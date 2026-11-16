'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { libraryRequest } from '@/lib/library-client';
import type { LibraryItem } from '@/lib/library-types';
import type { SourceConfig } from '@/lib/types';
import { useToast } from './toast';
export function FavoriteButton({ item, source, vodId, title, cover, showLibraryLink = false }: { item?: LibraryItem; source: SourceConfig; vodId: string; title: string; cover?: string; showLibraryLink?: boolean }) {
  const [busy, setBusy] = useState(false), { toast } = useToast(), client = useQueryClient();
  async function toggle() {
    setBusy(true);
    try {
      await libraryRequest(item ? `/items/${item.id}` : '', item ? 'DELETE' : 'POST', item ? undefined : { source, vodId, title, cover });
      await client.invalidateQueries({ queryKey: ['library'] });
      toast(item ? '已取消收藏，播放已停止，下载文件正在清理' : '已收藏，后台将下载全集并自动追更', 'success');
    } catch (error) { toast(error instanceof Error ? error.message : '收藏失败', 'error'); }
    finally { setBusy(false); }
  }
  return <><button className="btn-ghost btn-sm min-h-11" disabled={busy || !vodId} onClick={() => { void toggle(); }}>{busy ? '处理中…' : item ? '取消收藏' : '收藏并下载'}</button>{showLibraryLink && <Link className="btn-ghost btn-sm min-h-11" href="/library">收藏</Link>}</>;
}
