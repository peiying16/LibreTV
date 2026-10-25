'use client';

import { useEffect, useRef, useState } from 'react';
import { attachNativePlayback } from '@/lib/native-hls';
import type { PlayerShellProps } from './player-shell';

/** 系统直接播放签名 HLS URL；不接入网页播放器、MSE、屏幕镜像或触摸手势。 */
export function NativePlayerShell(props: PlayerShellProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError('');
    // 清理旧集时使用旧集的进度回调，避免把它的时间写入下一集。
    const episode = propsRef.current;
    return attachNativePlayback(video, props.url, props.adFilter, {
      getRestorePosition: () => episode.getRestorePosition?.() ?? 0,
      onTimeUpdate: (position, duration) => episode.onTimeUpdate?.(position, duration),
      onPause: (position, duration) => episode.onPause?.(position, duration),
      onEnded: () => propsRef.current.onEnded?.(),
      onQuality: (height) => episode.onQuality?.(height),
      onError: setError,
    });
  }, [props.url, props.adFilter, attempt]);

  return (
    <div className="relative w-full h-full bg-black">
      <video
        ref={videoRef}
        controls
        playsInline
        autoPlay
        preload="metadata"
        poster="/player-poster.png"
        aria-label={props.title}
        className="w-full h-full object-contain"
      />
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs min-h-11" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}
