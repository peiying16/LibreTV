import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from './store';
import { parseMediaPlaylist, decryptResource } from '../download/hls';
import { createCipheriv } from 'node:crypto';

const roots: string[] = [];
const stores: LibraryStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'libretv-library-')); roots.push(root);
  const store = new LibraryStore(root); stores.push(store);
  const item = store.favorite({ key: 'test', name: '测试', url: 'https://api.example/vod/' }, '1', '测试影片');
  store.syncEpisodes(item.id, item.generation, [{ key: '第01集', title: '第01集', url: 'https://cdn.example/a.m3u8' }]);
  return { root, store, item };
}

describe('library lifecycle scenarios', () => {
  it('L1: repeated favorites and catalog refreshes create only one episode/task', () => {
    const { store, item } = fixture();
    const again = store.favorite({ key: 'another-browser', name: '测试', url: 'https://api.example/vod' }, '1', '测试影片');
    expect(again.id).toBe(item.id); expect(again.generation).toBe(item.generation);
    store.syncEpisodes(item.id, item.generation, [{ key: '第01集', title: '第01集', url: 'https://cdn.example/new.m3u8' }]);
    expect(store.episodes(item.id)).toHaveLength(1);
    expect(store.claim('worker1')).not.toBeNull(); expect(store.claim('worker2')).toBeNull();
  });
  it('L2: cancellation fences every old writer and a re-favorite gets a new generation', () => {
    const { store, item } = fixture(); const job = store.claim('worker')!;
    store.unfavorite(item.id);
    expect(() => store.withLease(job, () => 'write')).toThrow();
    expect(store.complete(job, 'index.m3u8')).toBe(false);
    const next = store.favorite(item.source, '1', '测试影片');
    expect(next.generation).toBeGreaterThan(item.generation);
    expect(store.list()).toHaveLength(1);
    expect(store.complete(job, 'index.m3u8')).toBe(false);
  });
  it('L3: refreshing a removed favorite cannot enqueue a late episode', () => {
    const { store, item } = fixture(); store.unfavorite(item.id);
    store.syncEpisodes(item.id, item.generation, [{ key: '第02集', title: '第02集', url: 'https://cdn.example/b.m3u8' }]);
    expect(store.episodes(item.id)).toHaveLength(1); expect(store.claim('worker')).toBeNull();
  });
  it('L4: new episodes enqueue without resetting completed ones or mixing source IDs', () => {
    const { store, item } = fixture(); const job = store.claim('worker')!;
    expect(store.complete(job, 'index.m3u8')).toBe(true);
    store.syncEpisodes(item.id, item.generation, [{ key: '第02集', title: '第02集', url: 'https://cdn.example/b.m3u8' }, { key: '第01集', title: '第01集', url: 'https://cdn.example/a.m3u8' }]);
    expect(store.episodes(item.id).find(e => e.episodeKey === '第01集')?.status).toBe('ready');
    expect(store.claim('worker')?.episodeKey).toBe('第02集');
    expect(store.favorite({ ...item.source, url: 'https://other.example/vod' }, '1', '同名影片').id).not.toBe(item.id);
  });
});

describe('HLS decryption scenarios', () => {
  it('H1: associates rotated keys, IVs and METHOD=NONE with the right original segment sequence', () => {
    const parsed = parseMediaPlaylist(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:27\n#EXT-X-KEY:METHOD=AES-128,URI="a.key"\n#EXTINF:2,\na.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nb.ts\n#EXT-X-KEY:METHOD=AES-128,URI="b.key",IV=0x02\n#EXTINF:2,\nc.ts\n#EXT-X-ENDLIST`, 'https://cdn.example/list.m3u8');
    expect(parsed.resources.map(r => r.crypto?.keyUrl ?? null)).toEqual(['https://cdn.example/a.key', null, 'https://cdn.example/b.key']);
    expect(parsed.resources[0].crypto?.iv.toString('hex')).toBe('0000000000000000000000000000001b');
    expect(parsed.resources[2].crypto?.iv.toString('hex')).toBe('00000000000000000000000000000002');
    expect(parsed.template).not.toContain('#EXT-X-KEY'); expect(parsed.template).toContain('#EXT-X-MEDIA-SEQUENCE:27');
  });
  it('H2: decrypts CBC padding without changing any plaintext bytes or container', () => {
    const key = Buffer.alloc(16, 4), iv = Buffer.alloc(16, 8), data = Buffer.from('original TS container bytes');
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    expect(decryptResource(Buffer.concat([cipher.update(data), cipher.final()]), key, iv)).toEqual(data);
  });
  it('H3: handles init sections and implicit byte ranges, and retains discontinuities', () => {
    const parsed = parseMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"\n#EXTINF:2,\n#EXT-X-BYTERANGE:20@10\nall.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\n#EXT-X-BYTERANGE:30\nall.m4s\n#EXT-X-ENDLIST', 'https://cdn.example/list.m3u8');
    expect(parsed.resources.map(r => r.range)).toEqual([{ start: 0, length: 10 }, { start: 10, length: 20 }, { start: 30, length: 30 }]);
    expect(parsed.template).toContain('#EXT-X-DISCONTINUITY'); expect(parsed.template).not.toContain('BYTERANGE');
  });
  it('H4: refuses DRM, unsupported encryption and incomplete live playlists explicitly', () => {
    expect(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://id",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', 'https://cdn.example/a')).toThrow(/不支持/);
    expect(() => parseMediaPlaylist('#EXTM3U\n#EXTINF:2,\na.ts', 'https://cdn.example/a')).toThrow(/完整/);
  });
});

describe('lease recovery', () => {
  it('L5: an expired worker cannot write after another worker claims its task', () => {
    const { store } = fixture(); const old = store.claim('old')!;
    store.db.prepare('UPDATE episodes SET lease_until=0 WHERE id=?').run(old.id);
    const current = store.claim('new')!;
    expect(current.id).toBe(old.id); expect(store.active(old)).toBe(false); expect(store.active(current)).toBe(true);
    expect(() => store.withLease(old, () => 'stale file')).toThrow();
  });
  it('L6: database reopen retains favorites and resumable task state', () => {
    const { root, store, item } = fixture(); const job = store.claim('old')!;
    store.downloaded(job, 5, 10, 1000); store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new LibraryStore(root); stores.push(reopened);
    expect(reopened.get(item.id)?.episodes[0].completed).toBe(5);
    reopened.db.prepare('UPDATE episodes SET lease_until=0 WHERE id=?').run(job.id);
    expect(reopened.claim('restarted')?.id).toBe(job.id);
  });
});
