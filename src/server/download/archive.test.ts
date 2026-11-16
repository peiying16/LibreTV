import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv } from 'node:crypto';
import { downloadArchive, type ArchiveFetcher } from './archive';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function directory() { const d = mkdtempSync(join(tmpdir(), 'libretv-archive-')); dirs.push(d); return d; }
function fixture() {
  const key = Buffer.alloc(16, 3), iv = Buffer.alloc(16); iv[15] = 7;
  const clear = Buffer.from('unchanged TS bytes');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const files: Record<string, string | Buffer> = {
    '/list.m3u8': '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\na.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST',
    '/key.bin': key, '/a.ts': Buffer.concat([cipher.update(clear), cipher.final()]), '/b.ts': clear,
  };
  const requests: string[] = [];
  const fetcher: ArchiveFetcher = async url => {
    const p = new URL(url).pathname; requests.push(p);
    return { res: new Response(files[p] === undefined ? '' : new Uint8Array(Buffer.from(files[p])), { status: files[p] === undefined ? 404 : 200 }), finalUrl: url };
  };
  return { files, clear, requests, fetcher };
}
describe('real archive filesystem scenarios', () => {
  it('A1: preserves plaintext bytes and TS segmentation, removes encryption declarations', async () => {
    const f = fixture(), dir = directory();
    expect(await downloadArchive('https://cdn.example/list.m3u8', { directory: dir, signal: new AbortController().signal, fetcher: f.fetcher })).toBe('index.m3u8');
    expect(readFileSync(join(dir, 'p0-r000000.ts'))).toEqual(f.clear);
    expect(readFileSync(join(dir, 'p0-r000001.ts'))).toEqual(f.clear);
    const playlist = readFileSync(join(dir, 'index.m3u8'), 'utf8');
    expect(playlist).not.toContain('#EXT-X-KEY'); expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:7'); expect(playlist).toContain('p0-r000001.ts');
  });
  it('A2: verifies persisted files before resuming and re-downloads corrupted chunks', async () => {
    const f = fixture(), dir = directory(), options = { directory: dir, signal: new AbortController().signal, fetcher: f.fetcher };
    await downloadArchive('https://cdn.example/list.m3u8', options);
    writeFileSync(join(dir, 'p0-r000000.ts'), 'corrupted'); f.requests.length = 0;
    await downloadArchive('https://cdn.example/list.m3u8', options);
    expect(f.requests).toContain('/a.ts'); expect(f.requests).not.toContain('/b.ts');
    expect(readFileSync(join(dir, 'p0-r000000.ts'))).toEqual(f.clear);
  });
  it('A3: does not publish a playlist when a required segment is missing', async () => {
    const f = fixture(), dir = directory(); delete f.files['/b.ts'];
    await expect(downloadArchive('https://cdn.example/list.m3u8', { directory: dir, signal: new AbortController().signal, fetcher: f.fetcher })).rejects.toThrow('404');
    expect(existsSync(join(dir, 'index.m3u8'))).toBe(false);
  });
  it('A4: retains the selected rendition and its independent audio playlist', async () => {
    const f = fixture(), dir = directory();
    f.files['/master.m3u8'] = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"\nlist.m3u8';
    f.files['/audio.m3u8'] = '#EXTM3U\n#EXTINF:4,\naudio.aac\n#EXT-X-ENDLIST'; f.files['/audio.aac'] = Buffer.from('unchanged AAC');
    await downloadArchive('https://cdn.example/master.m3u8', { directory: dir, signal: new AbortController().signal, fetcher: f.fetcher });
    const master = readFileSync(join(dir, 'index.m3u8'), 'utf8');
    expect(master).toContain('URI="p1.m3u8"'); expect(master).toContain('p2.m3u8'); expect(master).not.toContain('https:');
    expect(readFileSync(join(dir, 'p1-r000000.aac'), 'utf8')).toBe('unchanged AAC');
  });
});

describe('original file download', () => {
  it('A5: keeps original MP4 bytes without transmuxing', async () => {
    const dir = directory(), original = Buffer.from('original MP4 container bytes');
    const fetcher: ArchiveFetcher = async url => ({ finalUrl: url, res: new Response(original, { headers: { 'Content-Length': String(original.length) } }) });
    expect(await downloadArchive('https://cdn.example/movie.mp4', { directory: dir, signal: new AbortController().signal, fetcher })).toBe('original.mp4');
    expect(readFileSync(join(dir, 'original.mp4'))).toEqual(original);
  });
  it('A6: resumes an original file only when the upstream validator still matches', async () => {
    const dir = directory(), original = Buffer.from('0123456789');
    writeFileSync(join(dir, 'original.mp4.part'), original.subarray(0, 5));
    writeFileSync(join(dir, 'original.resume.json'), JSON.stringify({ url: 'https://cdn.example/movie.mp4', validator: '"v1"' }));
    const ranges: string[] = [];
    const fetcher: ArchiveFetcher = async (url, headers) => {
      if (headers.Range) { ranges.push(headers.Range); return { finalUrl: url, res: new Response(original.subarray(5), { status: 206, headers: { 'content-range': 'bytes 5-9/10', 'content-length': '5', etag: '"v1"' } }) }; }
      return { finalUrl: url, res: new Response(original, { headers: { 'content-length': '10', etag: '"v1"' } }) };
    };
    await downloadArchive('https://cdn.example/movie.mp4', { directory: dir, signal: new AbortController().signal, fetcher });
    expect(ranges).toEqual(['bytes=5-']); expect(readFileSync(join(dir, 'original.mp4'))).toEqual(original);
  });
});
