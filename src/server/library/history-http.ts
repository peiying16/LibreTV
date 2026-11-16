import { guardRequest, jsonError } from '@/lib/api-guard';
import { LibraryStore, libraryStore } from './store';
import type { HistoryEntry } from '@/lib/db';
const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
export async function history(req: Request, store: LibraryStore = libraryStore()) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  if (req.method === 'GET') return json({ entries: store.historyList() });
  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id');
    if (id && !/^[a-f0-9]{32}$/.test(id)) return jsonError('历史记录 ID 无效', 400);
    store.removeHistory(id || undefined); return json({ success: true });
  }
  try {
    const body = await req.json() as Omit<HistoryEntry, 'id'>;
    if (!body || typeof body.sourceUrl !== 'string' || !/^https?:\/\//.test(body.sourceUrl) || typeof body.vodId !== 'string' || body.vodId.length > 3000 || typeof body.title !== 'string' || body.title.length > 500 || !Number.isSafeInteger(body.episodeIndex) || body.episodeIndex < 0 || ![body.playbackPosition, body.duration, body.totalEpisodes].every(Number.isFinite)) return jsonError('历史记录参数无效', 400);
    store.saveHistory(body, new URL(req.url).searchParams.get('import') === '1'); return json({ success: true });
  } catch { return jsonError('历史记录请求无效', 400); }
}
export async function onlineProgress(req: Request, store: LibraryStore = libraryStore()) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  try {
    const body = req.method === 'GET' ? Object.fromEntries(new URL(req.url).searchParams) : await req.json();
    if (typeof body.sourceUrl !== 'string' || !/^https?:\/\//.test(body.sourceUrl) || typeof body.vodId !== 'string' || body.vodId.length > 3000 || !Number.isSafeInteger(Number(body.index)) || Number(body.index) < 0) return jsonError('进度参数无效', 400);
    if (req.method === 'GET') return json(store.onlineProgress(body.sourceUrl, body.vodId, Number(body.index)) || { position: 0, duration: 0 });
    if (typeof body.position !== 'number' || typeof body.duration !== 'number' || ![body.position, body.duration].every(Number.isFinite) || body.duration <= 0) return jsonError('进度参数无效', 400);
    store.saveOnlineProgress(body.sourceUrl, body.vodId, Number(body.index), body.position, body.duration, body.ended === true);
    return json({ success: true });
  } catch { return jsonError('进度请求无效', 400); }
}
