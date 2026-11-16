'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useAuth } from '@/components/auth';
import { FavoriteButton } from '@/components/favorite-button';
import { useLibrary, libraryRequest } from '@/lib/library-client';
import { useAppStore } from '@/lib/store';
const PlayerShell = dynamic(() => import('@/components/player-shell').then(m => m.PlayerShell), { ssr: false });
interface Playback { url: string; mode: 'local' | 'online'; position: number; generation: number }
export default function LibraryWatchPage() { return <Suspense><LibraryWatch /></Suspense>; }
function LibraryWatch() {
  const search = useSearchParams(), router = useRouter(), { verified, openLogin } = useAuth();
  const library = useLibrary(verified), autoplayNext = useAppStore(s => s.autoplayNext);
  const item = library.data?.items.find(i => i.id === search.get('item'));
  const episode = item?.episodes.find(e => e.id === search.get('episode')) ?? item?.episodes[Math.max(0, Number(search.get('index')) || 0)] ?? item?.episodes[0];
  const [attempt, setAttempt] = useState(0), [height, setHeight] = useState(0);
  const [playback, setPlayback] = useState<Playback | null>(null), [error, setError] = useState('');
  const durationRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const episodeId = episode?.id, generation = episode?.generation;
  useEffect(() => {
    setPlayback(null); setError(''); setHeight(0); durationRef.current = 0;
    if (!episodeId) return;
    const controller = new AbortController();
    void libraryRequest<Playback>(`/episodes/${episodeId}`, 'POST', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPlayback(value); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
    // 完成下载不会改变此播放会话；下次进入或换集才重新选本地/在线。
  }, [episodeId, generation, attempt]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, [episodeId]);
  const save = useCallback((position: number, duration: number, ended = false) => {
    if (Number.isFinite(duration) && duration > 0) durationRef.current = duration;
    if (episodeId && generation !== undefined) void libraryRequest(`/episodes/${episodeId}`, 'PUT', { position, duration, generation, ended }).catch(() => {});
  }, [episodeId, generation]);
  if (!verified) return <main className="p-6"><button className="btn-primary" onClick={openLogin}>登录后播放</button></main>;
  if (library.isLoading) return <p className="p-6">正在读取收藏…</p>;
  if (library.error) return <p className="p-6 text-danger">{library.error.message}</p>;
  if (!item) return <main className="p-6"><p>该影片已取消收藏，播放已停止。</p><Link className="btn-primary mt-4" href="/library">返回收藏</Link></main>;
  const go = (id: string) => router.replace(`/library/watch?item=${item.id}&episode=${id}`, { scroll: false });
  const index = item.episodes.findIndex(e => e.id === episodeId);
  return <main className="max-w-6xl mx-auto p-4">
    <div className="flex flex-wrap items-center gap-2 mb-4"><Link className="btn-ghost min-h-11" href="/library">返回收藏</Link><h1 className="font-medium flex-1">{item.title} · {episode?.title}</h1><FavoriteButton item={item} source={item.source} vodId={item.vodId} title={item.title} /></div>
    <p className="text-sm text-muted mb-2">{playback ? playback.mode === 'local' ? `正在从 NAS 本地播放${height ? ` · ${height}p` : ''}` : '正在播放在线来源，下载完成后下次打开使用本地文件' : '正在准备播放…'}</p>
    <div className="aspect-video bg-black rounded-lg overflow-hidden">
      {error ? <p className="text-danger p-4">{error}</p> : playback && episode ? <PlayerShell
        key={`${episode.id}:${episode.generation}`} url={playback.url} title={item.title} adFilter={false} autoplayNext={autoplayNext}
        getRestorePosition={() => playback.position} onTimeUpdate={save} onPause={save} onQuality={setHeight}
        onEnded={() => { save(0, durationRef.current || episode.duration || 1, true); if (autoplayNext && item.episodes[index + 1]) timer.current = setTimeout(() => go(item.episodes[index + 1].id), 800); }}
        hasPrevEpisode={index > 0} hasNextEpisode={index < item.episodes.length - 1}
        onPrevEpisode={() => go(item.episodes[index - 1].id)} onNextEpisode={() => go(item.episodes[index + 1].id)}
      /> : <p className="text-white p-4">{episode ? '正在准备播放…' : '后台正在读取剧集列表…'}</p>}
    </div>
    <button className="btn-ghost min-h-11 mt-2" onClick={() => setAttempt(value => value + 1)}>重新加载播放</button>
    <div className="flex flex-wrap gap-2 mt-4">{item.episodes.map(e => <button key={e.id} className={`min-h-11 px-3 rounded border ${e.id === episodeId ? 'border-accent text-accent' : 'border-line'}`} onClick={() => go(e.id)}>{e.title} · {e.status === 'ready' ? '本地' : e.status === 'downloading' ? '下载中' : e.status === 'error' || e.status === 'paused' ? '下载异常' : '在线'}</button>)}</div>
  </main>;
}
