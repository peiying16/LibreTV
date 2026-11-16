'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LibraryItem } from './library-types';
import type { SourceConfig } from './types';
export interface LibraryResponse {
  items: LibraryItem[]; worker: { heartbeat: number; error: string | null } | null;
  cleaning: { id: string; title: string; error: string | null }[];
}
export async function libraryRequest<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/library${path}`, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', keepalive: method === 'PUT' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '资料库请求失败');
  return data as T;
}
export function useLibrary(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const events = new EventSource('/api/library/events');
    events.onmessage = () => { void client.invalidateQueries({ queryKey: ['library'] }); };
    return () => events.close();
  }, [client, enabled]);
  return useQuery({ queryKey: ['library'], queryFn: ({ signal }) => libraryRequest<LibraryResponse>('', 'GET', undefined, signal), enabled, refetchInterval: 15000 });
}
export function matchingFavorite(items: LibraryItem[] | undefined, source: SourceConfig | undefined, vodId: string) {
  if (!source || !vodId) return undefined;
  const canonical = (url: string) => { try { const u = new URL(url); u.hash = ''; return u.href.replace(/\/+$/, ''); } catch { return url; } };
  return items?.find(item => item.vodId === vodId && canonical(item.source.url) === canonical(source.url));
}
