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

/** iPad 的桌面模式也使用 MacIntel；触点数将它与 Mac 区分。 */
export function usesNativeAppleControls(
  video: HTMLVideoElement,
  device: Pick<Navigator, 'platform' | 'maxTouchPoints'>,
): boolean {
  return (/^(iPad|iPhone|iPod)$/.test(device.platform) ||
    (device.platform === 'MacIntel' && device.maxTouchPoints > 1)) &&
    !!video.canPlayType('application/vnd.apple.mpegurl');
}

interface NativePlaybackCallbacks {
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onPause?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onQuality?: (height: number) => void;
  onError?: (message: string) => void;
}

/** 一集对应一个载入生命周期；AirPlay、拖动与全屏均交给同一个原生 video。 */
export function attachNativePlayback(
  video: HTMLVideoElement,
  url: string,
  adFilter: boolean,
  callbacks: NativePlaybackCallbacks,
): () => void {
  const load = new AbortController();
  let restored = false;
  let restoring = false;
  let ended = false;
  let lastSave = 0;
  const validPosition = () => restored && Number.isFinite(video.duration) && video.duration > 0 && Number.isFinite(video.currentTime);
  const save = () => {
    if (!ended && validPosition()) callbacks.onPause?.(video.currentTime, video.duration);
  };
  const quality = () => {
    if (video.videoHeight > 0) callbacks.onQuality?.(video.videoHeight);
  };
  const restore = async () => {
    quality();
    if (restored || restoring || !Number.isFinite(video.duration) || video.duration <= 0) return;
    restoring = true;
    try {
      const position = await callbacks.getRestorePosition?.() ?? 0;
      if (load.signal.aborted || restored) return;
      restored = true;
      if (position > 10 && position < video.duration - 2) video.currentTime = position;
    } catch {
      // 历史记录不可用时仍允许正常播放与保存新进度。
      if (!load.signal.aborted) restored = true;
    } finally {
      restoring = false;
    }
  };
  const onRestore = () => { void restore(); };
  const onSeeking = () => { restored = true; };
  const onTimeUpdate = () => {
    if (validPosition() && Date.now() - lastSave >= 5000) {
      lastSave = Date.now();
      callbacks.onTimeUpdate?.(video.currentTime, video.duration);
    }
  };
  const onEnded = () => {
    if (!ended) { ended = true; callbacks.onEnded?.(); }
  };
  const onError = () => {
    // 不在投屏交接过程中自动重建 video 或替换 URL。
    callbacks.onError?.('视频播放失败，请尝试其他视频源');
  };
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  const listeners: [string, EventListener][] = [
    ['loadedmetadata', onRestore], ['durationchange', onRestore], ['canplay', onRestore],
    ['resize', quality], ['seeking', onSeeking], ['timeupdate', onTimeUpdate],
    ['pause', save], ['ended', onEnded], ['error', onError],
  ];

  video.controls = true;
  video.playsInline = true;
  video.disableRemotePlayback = false;
  video.setAttribute('x-webkit-airplay', 'allow');
  video.removeAttribute('src');
  video.load();
  listeners.forEach(([event, listener]) => video.addEventListener(event, listener));
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide);
  void getNativePlaybackUrl(url, adFilter, load.signal).then((signedUrl) => {
    if (load.signal.aborted) return;
    video.src = signedUrl;
    video.load();
    // 自动播放被系统拒绝时，保留系统播放按钮供用户点按。
    void video.play().catch(() => {});
  }).catch((error: unknown) => {
    if (!load.signal.aborted) callbacks.onError?.(error instanceof Error ? error.message : '视频加载失败');
  });

  return () => {
    load.abort();
    listeners.forEach(([event, listener]) => video.removeEventListener(event, listener));
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
    save();
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
