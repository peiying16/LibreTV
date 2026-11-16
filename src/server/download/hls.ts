import { createDecipheriv } from 'node:crypto';

export interface ByteRange { start: number; length: number }
export interface ResourceCrypto { keyUrl: string; iv: Buffer }
export interface MediaResource { url: string; name: string; range?: ByteRange; crypto?: ResourceCrypto }
export interface MediaPlaylist { template: string; resources: MediaResource[] }
export function attributes(line: string): Record<string, string> {
  return Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(m => [m[1], m[2] ?? m[3]]));
}
function ivBuffer(text: string) {
  if (!/^0[xX][0-9a-fA-F]{1,32}$/.test(text)) throw new Error('无效的 AES IV');
  return Buffer.from(text.slice(2).padStart(32, '0'), 'hex');
}
export function checkKey(a: Record<string, string>) {
  if (a.METHOD === 'NONE') return;
  if (a.METHOD !== 'AES-128' || (a.KEYFORMAT && a.KEYFORMAT !== 'identity') || !a.URI || a.URI.startsWith('skd:')) throw new Error('不支持该加密格式或 DRM 授权');
}
export function parseMediaPlaylist(text: string, base: string): MediaPlaylist {
  if (!text.trimStart().startsWith('#EXTM3U') || !text.includes('#EXT-X-ENDLIST')) throw new Error('需要完整的点播 HLS 清单');
  let sequence = BigInt(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] ?? '0');
  let key: { url: string; iv?: Buffer } | undefined;
  let pendingRange: string | undefined;
  let lastRangeUrl = '', lastRangeEnd = 0;
  const resources: MediaResource[] = [], output: string[] = [];
  function resource(uri: string, rangeText?: string, initialization = false) {
    const url = new URL(uri, base).href;
    if (!/^https?:/.test(url)) throw new Error('不支持的分片协议');
    let range: ByteRange | undefined;
    if (rangeText) {
      const m = /^(\d+)(?:@(\d+))?$/.exec(rangeText);
      if (!m || +m[1] <= 0 || (m[2] === undefined && lastRangeUrl !== url)) throw new Error('无效的分片字节范围');
      range = { length: +m[1], start: m[2] === undefined ? lastRangeEnd : +m[2] };
      if (!Number.isSafeInteger(range.start + range.length)) throw new Error('分片字节范围过大');
      lastRangeUrl = url; lastRangeEnd = range.start + range.length;
    } else if (!initialization) { lastRangeUrl = ''; lastRangeEnd = 0; }
    if (initialization && key && !key.iv) throw new Error('加密初始化文件必须声明 IV');
    const iv = key?.iv ?? ivBuffer(`0x${sequence.toString(16)}`);
    const ext = new URL(url).pathname.match(/\.(ts|m4s|mp4|aac|vtt|webvtt)$/i)?.[0].toLowerCase() ?? '.bin';
    const name = `r${String(resources.length).padStart(6, '0')}${ext}`;
    resources.push({ url, name, range, crypto: key ? { keyUrl: key.url, iv } : undefined });
    return name;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = attributes(line); checkKey(a);
      key = a.METHOD === 'NONE' ? undefined : { url: new URL(a.URI, base).href, iv: a.IV ? ivBuffer(a.IV) : undefined };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line); if (!a.URI) throw new Error('初始化文件缺少地址');
      const name = resource(a.URI, a.BYTERANGE, true);
      output.push(`#EXT-X-MAP:URI="${name}"`); continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) { pendingRange = line.slice(17); continue; }
    if (/^#EXT-X-(GAP(?:$|:)|(?:PART|PRELOAD-HINT|SKIP|STREAM-INF|MEDIA):)/.test(line)) throw new Error('不支持不完整或嵌套的媒体清单');
    if (line.startsWith('#') && /URI=/.test(line)) throw new Error('清单包含未支持的外部资源');
    if (line && !line.startsWith('#')) {
      output.push(resource(line, pendingRange)); pendingRange = undefined; sequence++;
    } else output.push(raw);
  }
  if (!resources.length || pendingRange) throw new Error('媒体清单没有完整分片');
  return { template: output.join('\n'), resources };
}
export function decryptResource(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (key.length !== 16) throw new Error('AES-128 密钥长度无效');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
