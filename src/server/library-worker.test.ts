import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from './library/store';
import { createLibraryWorker } from './library-worker';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'libretv-worker-')), store = new LibraryStore(root);
  cleanups.push(async () => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const item = store.favorite({ key: 'test', name: '测试', url: 'https://api.example/vod' }, '1', '后台测试');
  return { root, store, item };
}
const files = { '/1.m3u8': '#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', '/2.m3u8': '#EXTM3U\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST', '/a.ts': 'original TS 1', '/b.ts': 'original TS 2' };
describe('background worker integration', () => {
  it('W1: catalogs, downloads, publishes, follows new episodes and cleans an unfavorite', async () => {
    const { store, item, root } = fixture(); let updated = false;
    const worker = createLibraryWorker(store, {
      catalog: async () => [{ key: '第1集', title: '第1集', url: 'https://cdn.example/1.m3u8' }, ...(updated ? [{ key: '第2集', title: '第2集', url: 'https://cdn.example/2.m3u8' }] : [])],
      fetcher: async url => ({ finalUrl: url, res: new Response(files[new URL(url).pathname as keyof typeof files]) }),
    });
    cleanups.unshift(() => worker.stop());
    await worker.tick(); await worker.settle();
    expect(store.episodes(item.id).map(e => e.status)).toEqual(['ready']);
    updated = true; store.retry(item.id);
    await worker.tick(); await worker.settle();
    expect(store.episodes(item.id).map(e => e.status)).toEqual(['ready', 'ready']);
    expect(store.workerHealth()).not.toBeNull();
    store.unfavorite(item.id); await worker.tick();
    expect(existsSync(join(root, 'media', item.id, 'g1'))).toBe(false);
    expect(store.list()).toHaveLength(0);
  });
  it('W2: cancellation during a network request cannot recreate files after cleanup', async () => {
    const { store, item, root } = fixture();
    let release!: () => void, notify!: () => void;
    const started = new Promise<void>(resolve => { notify = resolve; });
    const worker = createLibraryWorker(store, {
      catalog: async () => [{ key: '第1集', title: '第1集', url: 'https://cdn.example/1.m3u8' }],
      fetcher: async url => {
        if (url.endsWith('a.ts')) { notify(); await new Promise<void>(resolve => { release = resolve; }); }
        return { finalUrl: url, res: new Response(url.endsWith('a.ts') ? 'TS bytes' : files['/1.m3u8']) };
      },
    });
    cleanups.unshift(() => worker.stop());
    await worker.tick(); await started;
    store.unfavorite(item.id); await worker.tick(); release(); await worker.settle();
    expect(existsSync(join(root, 'media', item.id, 'g1'))).toBe(false);
    expect(store.episodes(item.id)[0].status).toBe('cancelled');
  });
});
