import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindNativeMediaSession, getNativePlaybackUrl, nativeControlsOwnPlayback, supportsNativeAirPlay } from './native-hls';

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

class Video extends EventTarget {
  duration = 600;
  currentTime = 20;
  playbackRate = 1;
  seeking = false;
  paused = false;
  ended = false;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
}
function mediaFixture() {
  const video = new Video();
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const state = {
    playbackState: 'none',
    setPositionState: vi.fn(),
    setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      handlers.set(action, handler);
    }),
  };
  const clear = bindNativeMediaSession(video as unknown as HTMLVideoElement, state as unknown as MediaSession);
  const action = (action: MediaSessionAction, args: Partial<MediaSessionActionDetails> = {}) => {
    handlers.get(action)?.({ action, ...args });
  };
  return { video, handlers, state, clear, action };
}

describe('native system media controls', () => {
  it('accepts repeated scrubs, including intermediate fastSeek messages, without reloading media', () => {
    const { video, state, action, clear } = mediaFixture();
    for (const seekTime of [90, 310, 150, 400, 60, 250, 100, 500]) {
      action('seekto', { seekTime, fastSeek: true });
      expect(video.currentTime).toBe(seekTime);
      video.dispatchEvent(new Event('seeked'));
      expect(state.setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: seekTime, playbackRate: 1 });
    }
    clear();
  });

  it('handles relative skips and clamps seeks to the current episode', () => {
    const { video, action, clear } = mediaFixture();
    action('seekforward', { seekOffset: 30 }); expect(video.currentTime).toBe(50);
    action('seekbackward'); expect(video.currentTime).toBe(40);
    action('seekto', { seekTime: 800 }); expect(video.currentTime).toBe(600);
    action('seekto', { seekTime: -40 }); expect(video.currentTime).toBe(0);
    action('seekto', { seekTime: NaN }); expect(video.currentTime).toBe(0);
    video.duration = NaN;
    action('seekto', { seekTime: 100 }); expect(video.currentTime).toBe(0);
    clear();
  });

  it('does not overwrite the system scrubber with old timeupdate events while seeking', () => {
    const { video, state, clear } = mediaFixture();
    state.setPositionState.mockClear(); video.seeking = true;
    video.dispatchEvent(new Event('timeupdate'));
    expect(state.setPositionState).not.toHaveBeenCalled();
    video.seeking = false; video.currentTime = 350;
    video.dispatchEvent(new Event('seeked'));
    expect(state.setPositionState).toHaveBeenLastCalledWith({ duration: 600, position: 350, playbackRate: 1 });
    // 原生 AirPlay 的短暂未知时长不能清掉系统的有效进度/跳转能力。
    state.setPositionState.mockClear(); video.duration = Infinity;
    video.dispatchEvent(new Event('durationchange'));
    expect(state.setPositionState).not.toHaveBeenCalled();
    clear();
  });

  it('applies play/pause commands and removes handlers and listeners on unmount', async () => {
    const { video, state, action, handlers, clear } = mediaFixture();
    action('pause'); video.dispatchEvent(new Event('pause'));
    expect(state.playbackState).toBe('paused');
    action('play'); await Promise.resolve(); video.dispatchEvent(new Event('play'));
    expect(state.playbackState).toBe('playing');
    clear(); expect(state.playbackState).toBe('none');
    expect([...handlers.values()].every((handler) => handler === null)).toBe(true);
    state.setPositionState.mockClear(); video.dispatchEvent(new Event('timeupdate'));
    expect(state.setPositionState).not.toHaveBeenCalled();
  });

  it('recognizes native fullscreen and wireless playback before applying web touch gestures', () => {
    const video = { webkitDisplayingFullscreen: false, webkitCurrentPlaybackTargetIsWireless: false };
    const own = () => nativeControlsOwnPlayback(video as unknown as HTMLVideoElement);
    expect(own()).toBe(false);
    video.webkitDisplayingFullscreen = true; expect(own()).toBe(true);
    video.webkitDisplayingFullscreen = false;
    video.webkitCurrentPlaybackTargetIsWireless = true; expect(own()).toBe(true);
  });
});
