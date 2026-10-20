/** Safari 的原生 HLS 能将真实 URL 交给 AirPlay；Chromium 继续走 hls.js。 */
export function supportsNativeAirPlay(video: HTMLVideoElement): boolean {
  return 'webkitShowPlaybackTargetPicker' in video &&
    !!video.canPlayType('application/vnd.apple.mpegurl');
}

export async function getNativePlaybackUrl(url: string, adFilter: boolean, signal: AbortSignal): Promise<string> {
  const response = await fetch('/api/playback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ url, adFilter }),
    signal,
  });
  if (!response.ok) throw new Error('无法获取投屏播放地址，请重新登录或换源');
  const data = await response.json() as { url: string };
  return data.url;
}

type NativeVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

/** 原生全屏和 AirPlay 接管时，网页手势不再改倍速或拦截系统拖动。 */
export function nativeControlsOwnPlayback(video: NativeVideo): boolean {
  return !!(video.webkitDisplayingFullscreen || video.webkitCurrentPlaybackTargetIsWireless);
}

/** 将系统媒体面板的每次跳转明确交给同一个 video，避免只更新系统 UI。 */
export function bindNativeMediaSession(
  video: HTMLVideoElement,
  session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined,
): () => void {
  if (!session) return () => {};
  const actions: MediaSessionAction[] = [];
  const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try { session.setActionHandler(action, handler); actions.push(action); }
    catch { /* 旧版 Safari 可能只支持其中一部分指令。 */ }
  };
  const update = () => {
    session.playbackState = video.ended ? 'none' : video.paused ? 'paused' : 'playing';
    if (!session.setPositionState || video.seeking) return;
    const { duration, currentTime, playbackRate } = video;
    // AirPlay 切换期间 duration 可能短暂不可用，保留最后的有效系统进度。
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (!Number.isFinite(currentTime) || !Number.isFinite(playbackRate) || playbackRate <= 0) return;
    session.setPositionState({ duration, position: Math.min(duration, Math.max(0, currentTime)), playbackRate });
  };
  const seek = (time: number | undefined) => {
    if (time === undefined || !Number.isFinite(time) || !Number.isFinite(video.duration) || video.duration <= 0) return;
    // AirPlay 使用准确定位；不把连续拖动的 fastSeek 请求丢掉，也不重载 src。
    video.currentTime = Math.min(video.duration, Math.max(0, time));
  };
  bind('play', () => { void video.play().catch(() => {}); });
  bind('pause', () => video.pause());
  bind('seekto', ({ seekTime }) => seek(seekTime));
  bind('seekbackward', ({ seekOffset }) => seek(video.currentTime - (seekOffset ?? 10)));
  bind('seekforward', ({ seekOffset }) => seek(video.currentTime + (seekOffset ?? 10)));
  const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause',
    'ratechange', 'seeked', 'ended', 'emptied', 'webkitcurrentplaybacktargetiswirelesschanged'] as const;
  events.forEach((event) => video.addEventListener(event, update));
  update();
  return () => {
    events.forEach((event) => video.removeEventListener(event, update));
    actions.forEach((action) => session.setActionHandler(action, null));
    session.setPositionState?.();
    session.playbackState = 'none';
  };
}
