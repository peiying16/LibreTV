import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNativePlaybackUrl, supportsNativeAirPlay, usesNativeAppleControls, attachNativePlayback } from './native-hls';

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


class NativeVideo extends EventTarget {
  controls = false;
  playsInline = false;
  disableRemotePlayback = true;
  src = '';
  currentTime = 0;
  duration = NaN;
  videoHeight = 1080;
  ended = false;
  error = null;
  load = vi.fn();
  play = vi.fn(async () => {});
  pause = vi.fn();
  setAttribute = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  emit(name: string) { this.dispatchEvent(new Event(name)); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function signedFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ url: '/api/proxy?signed=1' }) })));
}

describe('Apple mobile native controls', () => {
  it.each([
    ['iPhone Safari', 'iPhone', 5, true],
    ['iPad desktop mode', 'MacIntel', 5, true],
    ['Mac Safari', 'MacIntel', 0, false],
    ['Android', 'Linux armv8l', 5, false],
  ])('%s chooses the expected controls', (_name, platform, maxTouchPoints, expected) => {
    const video = { canPlayType: () => 'maybe' } as unknown as HTMLVideoElement;
    expect(usesNativeAppleControls(video, { platform, maxTouchPoints })).toBe(expected);
    expect(usesNativeAppleControls({ canPlayType: () => '' } as unknown as HTMLVideoElement, { platform, maxTouchPoints })).toBe(false);
  });
  it('hands a signed URL to one native video and never reloads it when seeking or changing AirPlay route', async () => {
    signedFetch();
    const video = new NativeVideo();
    const stop = attachNativePlayback(video as unknown as HTMLVideoElement, 'https://cdn.example/movie.m3u8', true, {});
    await flush();
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.disableRemotePlayback).toBe(false);
    expect(video.src).toBe('/api/proxy?signed=1');
    video.duration = 600;
    video.emit('loadedmetadata');
    await flush();
    const loads = video.load.mock.calls.length;
    for (const time of [30, 180, 90, 440, 100, 500]) {
      video.currentTime = time;
      video.emit('seeking');
      video.emit('seeked');
      video.emit('webkitcurrentplaybacktargetiswirelesschanged');
      expect(video.currentTime).toBe(time);
    }
    expect(video.load).toHaveBeenCalledTimes(loads);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
  });
  it('cancels a stale episode load without replacing the next episode', async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: '/api/proxy?episode=2' }) });
    vi.stubGlobal('fetch', fetcher);
    const video = new NativeVideo();
    const stopFirst = attachNativePlayback(video as unknown as HTMLVideoElement, 'https://cdn.example/1.m3u8', true, {});
    stopFirst();
    const stopSecond = attachNativePlayback(video as unknown as HTMLVideoElement, 'https://cdn.example/2.m3u8', true, {});
    await flush();
    resolve({ ok: true, json: async () => ({ url: '/api/proxy?episode=1' }) });
    await flush();
    expect(video.src).toBe('/api/proxy?episode=2');
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    stopSecond();
  });
  it('restores once after valid metadata, saves pauses and does not overwrite a completed episode on cleanup', async () => {
    signedFetch();
    const video = new NativeVideo();
    const restore = vi.fn(async () => 120);
    const pause = vi.fn(), ended = vi.fn(), quality = vi.fn();
    const stop = attachNativePlayback(video as unknown as HTMLVideoElement, 'https://cdn.example/movie.m3u8', true,
      { getRestorePosition: restore, onPause: pause, onEnded: ended, onQuality: quality });
    await flush();
    video.emit('loadedmetadata');
    expect(restore).not.toHaveBeenCalled();
    video.duration = 600;
    video.emit('durationchange');
    await flush();
    expect(video.currentTime).toBe(120);
    video.currentTime = 250;
    video.emit('loadedmetadata');
    video.emit('pause');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenLastCalledWith(250, 600);
    expect(quality).toHaveBeenCalledWith(1080);
    video.ended = true;
    video.emit('ended');
    const calls = pause.mock.calls.length;
    stop();
    video.emit('ended');
    expect(ended).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(calls);
  });
  it('does not overwrite a user seek while history is still loading', async () => {
    signedFetch();
    let resolve!: (value: number) => void;
    const video = new NativeVideo();
    const stop = attachNativePlayback(video as unknown as HTMLVideoElement, 'https://cdn.example/movie.m3u8', false,
      { getRestorePosition: () => new Promise(r => { resolve = r; }) });
    await flush();
    video.duration = 600;
    video.emit('loadedmetadata');
    video.currentTime = 300;
    video.emit('seeking');
    resolve(120);
    await flush();
    expect(video.currentTime).toBe(300);
    stop();
  });
  it('reports a signing failure without exposing URLs, and does not auto-reload native media on errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const error = vi.fn();
    const video = new NativeVideo();
    const stop = attachNativePlayback(video as unknown as HTMLVideoElement, 'https://cdn.example/movie.m3u8', true, { onError: error });
    await flush();
    expect(error).toHaveBeenCalledWith('无法获取投屏播放地址，请重新登录或换源');
    const loads = video.load.mock.calls.length;
    video.emit('error');
    expect(video.load).toHaveBeenCalledTimes(loads);
    stop();
  });
});
