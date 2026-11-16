import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync, rmSync, openSync, writeSync, closeSync, readdirSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fetchWithSafeRedirects } from '@/lib/fetch-utils';
import { attributes, checkKey, decryptResource, parseMediaPlaylist, type MediaResource } from './hls';

export class DiskSpaceError extends Error {}
export type ArchiveFetcher = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<{ res: Response; finalUrl: string }>;
export const archiveFetch: ArchiveFetcher = (url, headers, signal) => fetchWithSafeRedirects(url, { headers: { 'User-Agent': 'Mozilla/5.0 LibreTV-Library', ...headers }, signal }, { headerTimeoutMs: 15_000 });
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
async function* chunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const part = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('媒体传输停滞，稍后重试')), 30000); })]);
        if (part.done) return;
        yield part.value;
      } finally { clearTimeout(timer); }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
async function bytes(response: Response, limit: number) {
  if (!response.body) throw new Error('上游返回空内容');
  const buffers: Buffer[] = []; let size = 0;
  for await (const value of chunks(response.body)) {
    size += value.byteLength; if (size > limit) throw new Error('上游资源超过安全大小限制');
    buffers.push(Buffer.from(value));
  }
  return Buffer.concat(buffers);
}
function checkSpace(root: string, bytes = 0) {
  const stat = statfsSync(root, { bigint: true });
  const configured = Number(process.env.LIBRARY_MIN_FREE_BYTES ?? 64 * 1024 * 1024);
  const reserve = BigInt(Number.isSafeInteger(configured) && configured >= 0 ? configured : 64 * 1024 * 1024);
  if (stat.bavail * stat.bsize < reserve + BigInt(bytes)) throw new DiskSpaceError('磁盘空间不足，下载已暂停');
}
interface ArchiveOptions {
  directory: string; signal: AbortSignal; fetcher?: ArchiveFetcher;
  guard?: <T>(action: () => T) => T;
  progress?: (completed: number, total: number, size: number) => void;
}
interface Checkpoint { fingerprint: string; files: Record<string, { hash: string; size: number }> }
export async function downloadArchive(url: string, options: ArchiveOptions): Promise<string> {
  const { directory, signal } = options, fetcher = options.fetcher ?? archiveFetch;
  const guard = <T>(action: () => T): T => { signal.throwIfAborted(); return options.guard ? options.guard(action) : action(); };
  guard(() => mkdirSync(directory, { recursive: true }));
  const atomic = (name: string, data: Buffer | string) => guard(() => {
    checkSpace(directory, Buffer.byteLength(data));
    const temp = join(directory, `${name}.${randomUUID()}.part`);
    writeFileSync(temp, data); renameSync(temp, join(directory, name));
  });
  const playlists = new Map<string, string>(), resources: (MediaResource & { output: string })[] = [];
  const seen = new Map<string, string>();
  let firstResponse: Response | undefined;
  let playlistNumber = 0;
  const visiting = new Set<string>();
  async function visit(input: string, depth: number): Promise<string> {
    if (visiting.has(input)) throw new Error('播放清单存在循环引用');
    if (seen.has(input)) return seen.get(input)!;
    if (depth > 5 || seen.size >= 32) throw new Error('播放清单层数或数量过多');
    visiting.add(input);
    const name = depth === 0 ? 'index.m3u8' : `p${playlistNumber}.m3u8`;
    const prefix = `p${playlistNumber++}-`; seen.set(input, name);
    const { res, finalUrl } = await fetcher(input, {}, signal);
    if (!res.ok) { await res.body?.cancel(); throw new Error(`清单请求失败 HTTP ${res.status}`); }
    if (depth === 0 && /\.(mp4|mov|webm|mkv)(?:\?|$)/i.test(input)) { firstResponse = res; return ''; }
    const text = (await bytes(res, 4 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('来源没有返回有效 HLS 清单');
    const lines = text.split(/\r?\n/);
    if (text.includes('#EXT-X-STREAM-INF:')) {
      const variants: { tag: string; uri: string; bandwidth: number; attrs: Record<string, string> }[] = [];
      for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const uri = lines.slice(i + 1).find(l => l.trim() && !l.startsWith('#'));
        if (!uri) throw new Error('主清单缺少视频档位');
        const a = attributes(lines[i]); variants.push({ tag: lines[i], uri, bandwidth: Number(a.BANDWIDTH) || 0, attrs: a });
      }
      const chosen = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!chosen) throw new Error('主清单没有可用视频档位');
      const groups = new Set([chosen.attrs.AUDIO, chosen.attrs.SUBTITLES, chosen.attrs['CLOSED-CAPTIONS']].filter(Boolean));
      const out: string[] = [];
      let skipVariantUri = false;
      for (const line of lines) {
        if (line.startsWith('#EXT-X-SESSION-KEY:')) { checkKey(attributes(line)); continue; }
        if (line.startsWith('#EXT-X-STREAM-INF:')) { skipVariantUri = true; continue; }
        if (line.trim() && !line.startsWith('#')) { if (skipVariantUri) skipVariantUri = false; continue; }
        if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) continue;
        if (line.startsWith('#EXT-X-MEDIA:')) {
          const a = attributes(line); if (!groups.has(a['GROUP-ID'])) continue;
          if (a.URI) {
            const child = await visit(new URL(a.URI, finalUrl).href, depth + 1);
            out.push(line.replace(/URI="[^"]*"/, `URI="${child}"`));
          } else out.push(line);
        } else if (/URI=/.test(line)) throw new Error('主清单包含未支持的外部资源');
        else out.push(line);
      }
      out.push(chosen.tag, await visit(new URL(chosen.uri, finalUrl).href, depth + 1));
      playlists.set(name, out.join('\n'));
    } else {
      const parsed = parseMediaPlaylist(text, finalUrl);
      let rewritten = parsed.template;
      for (const resource of parsed.resources) {
        const output = prefix + resource.name;
        rewritten = rewritten.replaceAll(resource.name, output);
        resources.push({ ...resource, output });
      }
      if (resources.length > 100_000) throw new Error('影片分片数量过多');
      playlists.set(name, rewritten);
    }
    visiting.delete(input);
    return name;
  }
  await visit(url, 0);
  if (firstResponse) {
    let response = firstResponse as Response;
    const ext = url.match(/\.(mp4|mov|webm|mkv)(?:\?|$)/i)![1].toLowerCase();
    const name = `original.${ext}`, temporary = join(directory, `${name}.part`);
    const validator = response.headers.get('etag') || response.headers.get('last-modified');
    let size = 0;
    try {
      const old = JSON.parse(readFileSync(join(directory, 'original.resume.json'), 'utf8'));
      if (validator && old.url === url && old.validator === validator) size = statSync(temporary).size;
    } catch { /* 没有安全可恢复的原文件 */ }
    if (size > 0) {
      await response.body?.cancel();
      response = (await fetcher(url, { Range: `bytes=${size}-`, 'If-Range': validator! }, signal)).res;
      if (response.status !== 206 || !response.headers.get('content-range')?.startsWith(`bytes ${size}-`)) size = 0;
      if (!response.ok || (response.status !== 200 && response.status !== 206)) { await response.body?.cancel(); throw new Error(`原文件续传失败 HTTP ${response.status}`); }
      if (!size && response.status === 206) throw new Error('原文件续传范围无效');
    }
    atomic('original.resume.json', JSON.stringify({ url, validator }));
    const initialSize = size;
    const fd = guard(() => openSync(temporary, size > 0 ? 'a' : 'w'));
    try {
      if (!response.body) throw new Error('空媒体文件');
      for await (const chunk of chunks(response.body)) {
        signal.throwIfAborted(); guard(() => { checkSpace(directory, chunk.byteLength); writeSync(fd, chunk); });
        size += chunk.byteLength; options.progress?.(0, 1, size);
      }
    } finally { closeSync(fd); }
    const expected = Number(response.headers.get('content-length'));
    if (!size || (expected > 0 && !response.headers.has('content-encoding') && expected !== size - initialSize)) throw new Error('媒体文件下载不完整');
    guard(() => renameSync(temporary, join(directory, name))); options.progress?.(1, 1, size); return name;
  }
  const keys = new Map<string, Buffer>();
  for (const r of resources) if (r.crypto && !keys.has(r.crypto.keyUrl)) {
    const { res } = await fetcher(r.crypto.keyUrl, {}, signal);
    if (!res.ok) { await res.body?.cancel(); throw new Error(`密钥请求失败 HTTP ${res.status}`); }
    const key = await bytes(res, 16); if (key.length !== 16) throw new Error('AES-128 密钥长度无效');
    keys.set(r.crypto.keyUrl, key);
  }
  const fingerprint = digest(JSON.stringify({ playlists: [...playlists], resources: resources.map(r => ({ ...r, crypto: r.crypto && { ...r.crypto, keyHash: digest(keys.get(r.crypto.keyUrl)!) } })) }));
  const checkpoint: Checkpoint = { fingerprint, files: {} };
  try { const old = JSON.parse(readFileSync(join(directory, 'resume.json'), 'utf8')) as Checkpoint; if (old.fingerprint === fingerprint) {
    for (const line of readFileSync(join(directory, 'resume.log'), 'utf8').split('\n')) {
      try { const record = JSON.parse(line); checkpoint.files[record.name] = record; } catch { /* 忽略断电产生的末尾半条记录 */ }
    }
  } } catch { /* 首次或未完整落盘 */ }
  atomic('resume.json', JSON.stringify({ fingerprint }));
  if (!Object.keys(checkpoint.files).length) atomic('resume.log', '');
  let completed = 0, size = 0;
  for (const resource of resources) {
    signal.throwIfAborted();
    const cached = checkpoint.files[resource.output];
    let buffer: Buffer | undefined;
    if (cached && existsSync(join(directory, resource.output))) {
      const local = readFileSync(join(directory, resource.output));
      if (local.length === cached.size && digest(local) === cached.hash) buffer = local;
    }
    if (!buffer) {
      const headers: Record<string, string> = {};
      if (resource.range) headers.Range = `bytes=${resource.range.start}-${resource.range.start + resource.range.length - 1}`;
      const { res } = await fetcher(resource.url, headers, signal);
      if (!res.ok) { await res.body?.cancel(); throw new Error(`分片请求失败 HTTP ${res.status}`); }
      if (/text\/html|application\/json/.test(res.headers.get('content-type') || '')) { await res.body?.cancel(); throw new Error('分片返回了错误页面'); }
      if (resource.range && (res.status !== 206 || !res.headers.get('content-range')?.startsWith(`bytes ${resource.range.start}-${resource.range.start + resource.range.length - 1}/`))) { await res.body?.cancel(); throw new Error('来源未正确响应分片字节范围'); }
      buffer = await bytes(res, 32 * 1024 * 1024);
      if (!buffer.length || (resource.range && buffer.length !== resource.range.length) || (!res.headers.has('content-encoding') && Number(res.headers.get('content-length')) > 0 && Number(res.headers.get('content-length')) !== buffer.length)) throw new Error('分片长度不完整');
      if (resource.crypto) buffer = decryptResource(buffer, keys.get(resource.crypto.keyUrl)!, resource.crypto.iv);
      if (!buffer.length) throw new Error('解密后的分片为空');
      atomic(resource.output, buffer);
      checkpoint.files[resource.output] = { hash: digest(buffer), size: buffer.length };
      guard(() => appendFileSync(join(directory, 'resume.log'), JSON.stringify({ name: resource.output, ...checkpoint.files[resource.output] }) + '\n'));
    }
    completed++; size += buffer.length; options.progress?.(completed, resources.length, size);
  }
  for (const [name, template] of playlists) atomic(name, template);
  guard(() => { for (const key of keys.values()) key.fill(0); });
  return 'index.m3u8';
}

/** 只清理已撤销的代次，重新收藏后的目录不受旧清理任务影响。 */
export function removeGenerations(base: string, itemId: string, through: number) {
  if (!/^[a-f0-9]{32}$/.test(itemId) || !Number.isSafeInteger(through) || through < 1) throw new Error('无效清理目标');
  const root = join(base, itemId);
  if (!existsSync(root)) return;
  for (const directory of readdirSync(root)) {
    const generation = /^g([0-9]+)$/.exec(directory);
    if (generation && Number(generation[1]) <= through) rmSync(join(root, directory), { recursive: true, force: true });
  }
}
