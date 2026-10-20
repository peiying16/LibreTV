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
