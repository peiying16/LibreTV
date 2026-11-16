'use client';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { useAuth } from '@/components/auth';
import { FavoriteButton } from '@/components/favorite-button';
import { useLibrary, libraryRequest } from '@/lib/library-client';
import { useToast } from '@/components/toast';
export default function LibraryPage() {
  const { verified, checked, openLogin } = useAuth(), query = useLibrary(verified), client = useQueryClient(), { toast } = useToast();
  return <><Header /><main className="max-w-6xl mx-auto p-4">
    <h1 className="text-xl font-semibold mb-2">全家收藏</h1>
    <p className="text-sm text-muted mb-6">收藏后后台下载全集并自动追更；取消收藏会停止所有设备的播放并删除下载文件。</p>
    {checked && !verified ? <button className="btn-primary" onClick={openLogin}>登录后查看</button> : null}
    {query.isLoading && <p>正在读取收藏…</p>}
    {query.error && <p className="text-danger">{query.error.message}</p>}
    {query.data && (!query.data.worker || Date.now() - query.data.worker.heartbeat > 90000) && <p className="text-sm text-danger mb-4">后台下载暂未运行，收藏已保存。请检查服务状态。</p>}
    {query.data?.cleaning.map(item => <p key={item.id} className="text-sm text-muted mb-3">《{item.title}》{item.error || '正在清理下载文件…'}</p>)}
    {query.data?.items.length === 0 && <p className="text-muted">还没有收藏。在影片播放页点击“收藏并下载”即可。</p>}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{query.data?.items.map(item => {
      const ready = item.episodes.filter(e => e.status === 'ready').length, running = item.episodes.find(e => e.status === 'downloading');
      const failed = item.episodes.find(e => e.status === 'error' || e.status === 'paused');
      const resume = [...item.episodes].filter(e => e.position > 0).sort((a, b) => b.progressUpdatedAt - a.progressUpdatedAt)[0];
      return <article key={item.id} className="rounded-xl bg-surface-raised border border-line p-4">
        <h2 className="font-medium mb-1">{item.title}</h2><p className="text-xs text-muted">{item.source.name} · 已下载 {ready}/{item.episodes.length} 集</p>
        <p className="text-sm my-3">{item.error || (running ? `${running.title} · ${running.completed}/${running.total || '…'} 分片` : failed?.error || (item.episodes.length && ready === item.episodes.length ? '已下载完整 · 持续追更中' : '等待后台处理'))}</p>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-primary btn-sm min-h-11" href={`/library/watch?item=${item.id}${resume ? `&episode=${resume.id}` : ''}`}>{resume ? '继续播放' : '播放'}</Link>
          <FavoriteButton item={item} source={item.source} vodId={item.vodId} title={item.title} />
          {(failed || item.error) && <button className="btn-ghost btn-sm min-h-11" onClick={async () => {
            try { await libraryRequest(`/items/${item.id}`, 'POST'); await client.invalidateQueries({ queryKey: ['library'] }); }
            catch (e) { toast(e instanceof Error ? e.message : '重试失败', 'error'); }
          }}>重试下载</button>}
        </div>
      </article>;
    })}</div>
  </main></>;
}
