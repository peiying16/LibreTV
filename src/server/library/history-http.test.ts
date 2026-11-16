import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from './store';
import { history, onlineProgress } from './history-http';
import { signSession } from '@/lib/auth';
let store: LibraryStore, root: string;
beforeEach(() => { vi.stubEnv('PASSWORD', 'history-test'); root = mkdtempSync(join(tmpdir(), 'libretv-history-')); store = new LibraryStore(root); });
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const source = { key: 'env_0', name: '测试', url: 'https://api.example/vod' };
const entry = { sourceKey: source.key, sourceUrl: source.url, vodId: '1', title: '共享历史', episodeIndex: 0, totalEpisodes: 2, playbackPosition: 0, duration: 0, timestamp: 1 };
function request(path: string, method = 'GET', body?: unknown) { return new Request(`https://film.example/api/library/${path}`, { method, headers: { cookie: `ltv_session=${signSession().token}` }, body: body === undefined ? undefined : JSON.stringify(body) }); }
describe('shared history and progress routes', () => {
  it('S1: syncs an online position before the film is favorited and seeds the library episode', async () => {
    expect((await history(request('history', 'POST', entry), store)).status).toBe(200);
    expect((await onlineProgress(request('progress', 'PUT', { sourceUrl: source.url, vodId: '1', index: 0, position: 42, duration: 120 }), store)).status).toBe(200);
    const response = await onlineProgress(request('progress?'+new URLSearchParams({ sourceUrl: source.url, vodId: '1', index: '0' })), store);
    expect((await response.json()).position).toBe(42);
    const item = store.favorite(source, '1', entry.title); store.syncEpisodes(item.id, item.generation, [{ key: '第1集', title: '第1集', url: 'https://cdn.example/a.m3u8' }]);
    expect(store.episodes(item.id)[0].position).toBe(42);
  });
  it('S2: importing old browser data cannot overwrite an existing shared record', async () => {
    store.saveHistory({ ...entry, playbackPosition: 70, duration: 120 });
    await history(request('history?import=1', 'POST', { ...entry, playbackPosition: 10, duration: 120 }), store);
    expect(store.historyList()[0].playbackPosition).toBe(70);
  });
  it('S3: clearing all history also clears online and library progress', async () => {
    const item = store.favorite(source, '1', entry.title); store.syncEpisodes(item.id, item.generation, [{ key: '第1集', title: '第1集', url: 'https://cdn.example/a.m3u8' }]);
    store.progress(store.episodes(item.id)[0].id, 40, 120);
    await history(request('history', 'DELETE'), store);
    expect(store.historyList()).toEqual([]); expect(store.episodes(item.id)[0].position).toBe(0); expect(store.onlineProgress(source.url, '1', 0)).toBeNull();
  });
  it('S4: rejects unauthenticated reads and malformed positions', async () => {
    expect((await history(new Request('https://film.example/api/library/history'), store)).status).toBe(401);
    expect((await onlineProgress(request('progress', 'PUT', { sourceUrl: source.url, vodId: '1', index: -1, position: 3, duration: 10 }), store)).status).toBe(400);
  });
});
