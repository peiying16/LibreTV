import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/playback/route';
import { GET } from '@/app/api/proxy/route';
import { PLAYBACK_TTL_MS, SESSION_COOKIE, signedPlaybackUrl, signSession, verifyPlaybackToken } from './auth';
import { fetchWithSafeRedirects } from './fetch-utils';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) },
}));
vi.mock('./fetch-utils', () => ({ fetchWithSafeRedirects: vi.fn() }));

const origin = 'https://film.example';
const media = 'https://cdn.example/movie/master.m3u8';
const upstream = vi.mocked(fetchWithSafeRedirects);

function mint(url = media, authenticated = true, adFilter = false) {
  return POST(new Request(`${origin}/api/playback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(authenticated ? { Cookie: `${SESSION_COOKIE}=${signSession().token}` } : {}) },
    body: JSON.stringify({ url, adFilter }),
  }));
}
function read(url: string, range?: string) {
  return GET(new Request(new URL(url, origin), { headers: range ? { Range: range } : {} }));
}
function reply(text: string, url = media, type = 'application/vnd.apple.mpegurl') {
  upstream.mockResolvedValueOnce({ res: new Response(text, { headers: { 'Content-Type': type } }), finalUrl: url });
}
function uris(text: string) {
  return [...text.matchAll(/URI="([^"]+)"/g)].map((m) => m[1])
    .concat(text.split('\n').filter((s) => s && !s.startsWith('#')));
}

beforeEach(() => {
  vi.stubEnv('PASSWORD', 'airplay-test-password');
  upstream.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('AirPlay cookie-free playback', () => {
  it('only a logged-in user can mint a URL; rejects malformed and private targets', async () => {
    expect((await mint(media, false)).status).toBe(401);
    expect((await mint('http://127.0.0.1/secret')).status).toBe(400);
    expect((await mint('file:///etc/passwd')).status).toBe(400);
    expect((await POST(new Request(`${origin}/api/playback`, { method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${signSession().token}` }, body: '{' }))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('receiver reads master, separate audio, media playlist, key/map and segments without cookies', async () => {
    const minted = await mint();
    expect(minted.headers.get('cache-control')).toBe('no-store');
    const { url, expiresAt } = await minted.json();
    reply('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\nvideo.m3u8', 'https://redirect.example/hls/master.m3u8');
    const master = await read(url);
    expect(master.status).toBe(200);
    const children = uris(await master.text());
    expect(children).toHaveLength(2);
    for (const child of children) {
      const params = new URL(child, origin).searchParams;
      const target = params.get('url')!;
      expect(target).toMatch(/^https:\/\/redirect.example\/hls\//);
      expect(verifyPlaybackToken(params.get('playback'), target)?.expiresAt).toBe(expiresAt);
      reply('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST', target);
      const playlist = await read(child);
      expect(playlist.status).toBe(200);
      const assets = uris(await playlist.text());
      expect(assets).toHaveLength(3);
      for (const asset of assets) {
        const p = new URL(asset, origin).searchParams;
        expect(verifyPlaybackToken(p.get('playback'), p.get('url')!)?.expiresAt).toBe(expiresAt);
        reply('media-bytes', p.get('url')!, 'video/mp2t');
        const response = await read(asset, 'bytes=0-4095');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.text()).toBe('media-bytes');
        expect(upstream.mock.lastCall?.[1]?.headers).toMatchObject({ Range: 'bytes=0-4095' });
      }
    }
  });

  it('rejects unsigned, tampered, expired and session tokens, and still enforces SSRF', async () => {
    vi.useFakeTimers();
    const { url } = await (await mint()).json();
    const changed = new URL(url, origin);
    changed.searchParams.set('url', 'https://other.example/secret');
    expect((await read(changed.href)).status).toBe(401);
    const token = new URL(url, origin).searchParams.get('playback')!;
    expect(verifyPlaybackToken('0' + token, media)).toBeNull();
    expect(verifyPlaybackToken(signSession().token, media)).toBeNull();
    expect((await read(`/api/proxy?url=${encodeURIComponent(media)}`)).status).toBe(401);
    const privateUrl = signedPlaybackUrl('http://127.0.0.1/secret', { expiresAt: Date.now() + 60000, adFilter: false });
    expect((await read(privateUrl)).status).toBe(400);
    vi.advanceTimersByTime(PLAYBACK_TTL_MS + 1);
    expect((await read(url)).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('revokes playback when the password changes or is removed', async () => {
    const { url } = await (await mint()).json();
    vi.stubEnv('PASSWORD', 'rotated');
    expect((await read(url)).status).toBe(401);
    vi.stubEnv('PASSWORD', '');
    expect((await read(url)).status).toBe(503);
  });

  it('keeps advertisement filtering for native playback', async () => {
    const { url } = await (await mint(media, true, true)).json();
    reply('#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nad.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nmovie.ts\n#EXT-X-ENDLIST');
    const res = await read(url);
    const text = await res.text();
    expect(text).not.toContain('ad.ts');
    expect(decodeURIComponent(text)).toContain('movie.ts');
  });
});
