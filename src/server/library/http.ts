import { NextResponse } from 'next/server';
import { join, extname, sep, resolve } from 'node:path';
import { createReadStream, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { signLibraryToken, verifyLibraryToken } from '@/lib/auth';
import { fetchWithSafeRedirects } from '@/lib/fetch-utils';
import { rewriteM3u8 } from '@/lib/m3u8';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SourceConfig } from '@/lib/types';
import { LibraryStore, libraryStore } from './store';
import { mediaBody, stopItemStreams } from './streams';
import { removeGenerations } from '../download/archive';

const noStore = { 'Cache-Control': 'private, no-store' };
function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: noStore }); }
function visible(store: LibraryStore, episodeId: string) {
  const episode = store.episode(episodeId), item = episode && store.get(episode.itemId);
  return episode && item?.favorite && episode.generation === item.generation ? { episode, item } : null;
}
export async function collection(req: Request, store = libraryStore()) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  if (req.method === 'GET') return json({ items: store.list(), worker: store.workerHealth(), cleaning: store.cleanupItems().map(i => ({ id: i.id, title: i.title, error: i.error })) });
  try {
    const data = await req.json(); const source = data.source as SourceConfig;
    if (!source || typeof source.url !== 'string' || typeof source.name !== 'string' || source.name.length > 200 || !/^[\w-]{1,100}$/.test(String(data.vodId)) || typeof data.title !== 'string' || data.title.length > 500) return jsonError('收藏参数无效', 400);
    const verdict = await checkUpstreamAllowed(source.url); if (!verdict.ok) return jsonError('来源地址不允许访问', 400);
    const safeSource: SourceConfig = { key: String(source.key || 'library').slice(0, 100), name: source.name, url: new URL(source.url).href };
    return json(store.favorite(safeSource, String(data.vodId), data.title, typeof data.cover === 'string' ? data.cover.slice(0, 2000) : ''), 201);
  } catch { return jsonError('收藏请求无效', 400); }
}
export async function itemAction(req: Request, id: string, store = libraryStore()) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  const item = store.get(id); if (!item) return jsonError('收藏不存在', 404);
  if (req.method === 'GET') return json(item);
  if (req.method === 'POST') { if (!item.favorite) return jsonError('已取消收藏', 409); store.retry(id); return json({ success: true }); }
  store.unfavorite(id); stopItemStreams(id);
  const removed = store.get(id)!;
  if (!removed.cleanupThrough) return json({ success: true, cleaning: false });
  try {
    removeGenerations(process.env.LIBRARY_MEDIA_DIR || join(store.root, 'media'), id, removed.cleanupThrough);
    store.cleaned(id, removed.cleanupThrough);
  } catch { store.cleanupError(id); return json({ success: true, cleaning: true }, 202); }
  return json({ success: true, cleaning: false });
}
export async function episodeAction(req: Request, id: string, store = libraryStore()) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  const active = visible(store, id); if (!active) return jsonError('该影片已取消收藏', 410);
  const { episode } = active;
  if (req.method === 'PUT') {
    try {
      const body = await req.json();
      if (body.generation !== episode.generation || typeof body.position !== 'number' || typeof body.duration !== 'number') return jsonError('进度参数或收藏版本无效', 409);
      store.progress(id, body.position, body.duration, body.ended === true); return json({ success: true });
    } catch { return jsonError('进度参数无效', 400); }
  }
  let local = episode.status === 'ready' && !!episode.entry;
  if (local && !existsSync(join(process.env.LIBRARY_MEDIA_DIR || join(store.root, 'media'), episode.itemId, `g${episode.generation}`, episode.id, episode.entry!))) { store.invalidateAsset(id, episode.generation); local = false; }
  const url = local
    ? `/api/library/media/${id}/${episode.entry}?token=${signLibraryToken(id, episode.generation)}`
    : relayUrl(id, episode.generation, episode.url);
  return json({ url, mode: local ? 'local' : 'online', position: episode.position, generation: episode.generation });
}
export function relayUrl(id: string, generation: number, url: string, expiresAt?: number) {
  return `/api/library/relay/${id}?${new URLSearchParams({ url, token: signLibraryToken(id, generation, `relay:${url}`, expiresAt) })}`;
}
export async function relay(req: Request, id: string, store = libraryStore()) {
  const active = visible(store, id); if (!active) return jsonError('播放权限已撤销', 410);
  const query = new URL(req.url).searchParams, url = query.get('url') || '';
  const expiresAt = verifyLibraryToken(query.get('token'), id, active.episode.generation, `relay:${url}`);
  if (!expiresAt) return jsonError('播放签名无效或已过期', 401);
  try {
    const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 LibreTV-Library' };
    if (req.headers.has('range')) headers.Range = req.headers.get('range')!;
    const { res, finalUrl } = await fetchWithSafeRedirects(url, { headers, signal: req.signal }, { headerTimeoutMs: 15000 });
    if (visible(store, id)?.episode.generation !== active.episode.generation) { await res.body?.cancel(); return jsonError('播放权限已撤销', 410); }
    if (res.headers.get('content-type')?.includes('mpegurl') || new URL(finalUrl).pathname.endsWith('.m3u8')) {
      const text = await res.text();
      const body = rewriteM3u8(text, finalUrl, 0, undefined, child => relayUrl(id, active.episode.generation, child, expiresAt));
      return new Response(body, { status: res.status, headers: { ...noStore, 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    const out = new Headers(noStore);
    for (const name of ['content-type', 'content-range', 'accept-ranges']) { const value = res.headers.get(name); if (value) out.set(name, value); }
    if (!res.headers.has('content-encoding') && res.headers.has('content-length')) out.set('Content-Length', res.headers.get('content-length')!);
    return new Response(res.body ? mediaBody(res.body, active.item.id, req.signal) : null, { status: res.status, headers: out });
  } catch { return jsonError('在线来源请求失败', 502); }
}
export function byteRange(header: string | null, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size <= 0) return false;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end } : false;
}
export async function localMedia(req: Request, id: string, file: string, store = libraryStore()) {
  const active = visible(store, id); if (!active || active.episode.status !== 'ready') return jsonError('影片未下载完成或播放权限已撤销', 410);
  if (!verifyLibraryToken(new URL(req.url).searchParams.get('token'), id, active.episode.generation)) return jsonError('播放签名无效或已过期', 401);
  if (!/^(?:index\.m3u8|p\d+\.m3u8|p\d+-r\d+\.(?:ts|m4s|mp4|aac|vtt|webvtt|bin)|original\.(?:mp4|mov|webm|mkv))$/.test(file)) return jsonError('媒体文件不存在', 404);
  const root = resolve(process.env.LIBRARY_MEDIA_DIR || join(store.root, 'media'), active.item.id, `g${active.episode.generation}`, id);
  try {
    const path = realpathSync(join(root, file)); if (!path.startsWith(realpathSync(root) + sep)) return jsonError('媒体路径无效', 403);
    if (file.endsWith('.m3u8')) {
      const token = new URL(req.url).searchParams.get('token')!;
      const local = (name: string) => `/api/library/media/${id}/${name}?${new URLSearchParams({ token })}`;
      const text = readFileSync(path, 'utf8').split('\n').map(line => {
        if (line.trim() && !line.startsWith('#')) return local(line.trim());
        return line.replace(/URI="([^"]+)"/g, (_all, uri) => `URI="${local(uri)}"`);
      }).join('\n');
      return new Response(req.method === 'HEAD' ? null : text, { headers: { ...noStore, 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(Buffer.byteLength(text)) } });
    }
    const stat = statSync(path); if (!stat.isFile()) return jsonError('媒体文件不存在', 404);
    const range = byteRange(req.headers.get('range'), stat.size);
    if (range === false) return new Response(null, { status: 416, headers: { ...noStore, 'Content-Range': `bytes */${stat.size}` } });
    const types: Record<string, string> = { '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.aac': 'audio/aac', '.vtt': 'text/vtt', '.webvtt': 'text/vtt', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
    const headers: Record<string, string> = { ...noStore, 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(range ? range.end - range.start + 1 : stat.size), ETag: `"${stat.size}-${stat.mtimeMs}"` };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    return new Response(req.method === 'HEAD' ? null : mediaBody(createReadStream(path, range || undefined), active.item.id, req.signal), { status: range ? 206 : 200, headers });
  } catch { store.invalidateAsset(id, active.episode.generation); return jsonError('本地文件缺失，已安排重新下载', 404); }
}
