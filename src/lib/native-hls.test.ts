import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNativePlaybackUrl, supportsNativeAirPlay } from './native-hls';

afterEach(() => vi.unstubAllGlobals());
describe('native AirPlay playback', () => {
  it('uses native HLS only when both native HLS and the AirPlay picker are available', () => {
    const video = { canPlayType: () => 'maybe' };
    expect(supportsNativeAirPlay(video as unknown as HTMLVideoElement)).toBe(false);
    const safari = { ...video, webkitShowPlaybackTargetPicker() {} };
    expect(supportsNativeAirPlay(safari as unknown as HTMLVideoElement)).toBe(true);
    safari.canPlayType = () => '';
    expect(supportsNativeAirPlay(safari as unknown as HTMLVideoElement)).toBe(false);
  });
  it('requests a signed URL using the browser session and allows cancellation on episode changes', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetcher);
    const promise = getNativePlaybackUrl('https://cdn.example/first.m3u8', true, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0][1].credentials).toBe('same-origin');
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ url: 'https://cdn.example/first.m3u8', adFilter: true });
  });
});
