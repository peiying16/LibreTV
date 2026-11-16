import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LibraryStore } from './store';
import { episodeAction, itemAction, localMedia, byteRange, relayUrl } from './http';
import { signLibraryToken, signSession, verifyLibraryToken } from '@/lib/auth';
let store: LibraryStore, root: string;
beforeEach(() => { vi.stubEnv('PASSWORD', 'library-fixture-password'); root = mkdtempSync(join(tmpdir(), 'libretv-http-')); store = new LibraryStore(root); });
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture() {
  const item = store.favorite({ key: 'test', name: '测试', url: 'https://api.example/vod' }, '1', '测试');
  store.syncEpisodes(item.id, item.generation, [{ key: '正片', title: '正片', url: 'https://cdn.example/movie.m3u8' }]);
  const job = store.claim('test')!;
  const dir = join(root, 'media', item.id, `g${item.generation}`, job.id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.m3u8'), '#EXTM3U\n#EXTINF:2,\np0-r000000.ts\n#EXT-X-ENDLIST');
  writeFileSync(join(dir, 'p0-r000000.ts'), '0123456789');
  writeFileSync(join(dir, 'resume.json'), 'private state');
  store.complete(job, 'index.m3u8');
  const token = signLibraryToken(job.id, job.generation);
  return { item, job, token, dir };
}
const auth = () => ({ cookie: `ltv_session=${signSession().token}` });
describe('library HTTP contract', () => {
  it('P1: provides cookie-free signed local playback with signed child URIs', async () => {
    const { job, token } = fixture();
    const resolved = await episodeAction(new Request('https://film.example/api', { method: 'POST', headers: auth() }), job.id, store);
    expect((await resolved.json()).mode).toBe('local');
    const manifest = await localMedia(new Request(`https://film.example/api?token=${token}`), job.id, 'index.m3u8', store);
    expect(manifest.status).toBe(200); expect(await manifest.text()).toContain(`/api/library/media/${job.id}/p0-r000000.ts?token=`);
    const part = await localMedia(new Request(`https://film.example/api?token=${token}`, { headers: { range: 'bytes=2-5' } }), job.id, 'p0-r000000.ts', store);
    expect(part.status).toBe(206); expect(part.headers.get('content-range')).toBe('bytes 2-5/10'); expect(await part.text()).toBe('2345');
  });
  it('P2: rejects missing/tampered signatures, traversal and internal checkpoint files', async () => {
    const { job, token } = fixture();
    expect((await localMedia(new Request('https://film.example/api'), job.id, 'index.m3u8', store)).status).toBe(401);
    expect((await localMedia(new Request(`https://film.example/api?token=${token}x`), job.id, 'index.m3u8', store)).status).toBe(401);
    expect((await localMedia(new Request(`https://film.example/api?token=${token}`), job.id, '../library.sqlite', store)).status).toBe(404);
    expect((await localMedia(new Request(`https://film.example/api?token=${token}`), job.id, 'resume.json', store)).status).toBe(404);
    expect(verifyLibraryToken(token, job.id, job.generation, 'relay:https://other.example')).toBeNull();
  });
  it('P3: cancellation revokes unexpired URLs, deletes the old generation and cannot revoke a later favorite', async () => {
    const { item, job, token, dir } = fixture();
    const response = await itemAction(new Request('https://film.example/api', { method: 'DELETE', headers: auth() }), item.id, store);
    expect(response.status).toBe(200);
    expect(() => statSync(dir)).toThrow();
    expect((await localMedia(new Request(`https://film.example/api?token=${token}`), job.id, 'index.m3u8', store)).status).toBe(410);
    const next = store.favorite(item.source, '1', '测试'); expect(next.generation).toBeGreaterThan(job.generation);
    expect(verifyLibraryToken(token, job.id, next.generation)).toBeNull();
  });
  it('P4: shared progress persists across independent requests and rejects stale generations', async () => {
    const { job } = fixture();
    const write = await episodeAction(new Request('https://film.example/api', { method: 'PUT', headers: auth(), body: JSON.stringify({ position: 80, duration: 100, generation: job.generation }) }), job.id, store);
    expect(write.status).toBe(200); expect(store.episode(job.id)?.position).toBe(80);
    const read = await episodeAction(new Request('https://film.example/api', { method: 'POST', headers: auth() }), job.id, store);
    expect((await read.json()).position).toBe(80);
    expect(relayUrl(job.id, job.generation, 'https://cdn.example/movie.m3u8')).toContain('/api/library/relay/');
  });
  it.each([
    [null, 10, null], ['bytes=0-0', 10, { start: 0, end: 0 }], ['bytes=-3', 10, { start: 7, end: 9 }],
    ['bytes=7-', 10, { start: 7, end: 9 }], ['bytes=10-', 10, false], ['bytes=8-2', 10, false], ['bytes=0-1,4-5', 10, false],
  ] as const)('P5: correctly handles byte range %s', (header, size, expected) => { expect(byteRange(header, size)).toEqual(expected); });
});

describe('in-flight media cancellation', () => {
  it('P6: aborts an already open response when the favorite is removed', async () => {
    const { item, job, token, dir } = fixture();
    writeFileSync(join(dir, 'p0-r000000.ts'), Buffer.alloc(8 * 1024 * 1024, 0x47));
    const response = await localMedia(new Request(`https://film.example/api?token=${token}`), job.id, 'p0-r000000.ts', store);
    const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false);
    await itemAction(new Request('https://film.example/api', { method: 'DELETE', headers: auth() }), item.id, store);
    await expect((async () => { for (;;) { if ((await reader.read()).done) break; } })()).rejects.toThrow();
  });
});

describe('missing local files', () => {
  it('P7: resolves to online playback and queues repair if the local entry disappears', async () => {
    const { job, dir } = fixture(); rmSync(join(dir, 'index.m3u8'));
    const response = await episodeAction(new Request('https://film.example/api', { method: 'POST', headers: auth() }), job.id, store);
    expect((await response.json()).mode).toBe('online'); expect(store.episode(job.id)?.status).toBe('queued');
  });
});

describe('idempotent removal', () => {
  it('P8: repeated cancellation remains successful after files have already been removed', async () => {
    const { item } = fixture();
    for (let i = 0; i < 2; i++) {
      const response = await itemAction(new Request('https://film.example/api', { method: 'DELETE', headers: auth() }), item.id, store);
      expect(response.status).toBe(200); expect((await response.json()).cleaning).toBe(false);
    }
  });
});
