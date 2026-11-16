import { cmsRequestHeaders } from '@/lib/cms-parser';
import { fetchUpstreamJson } from '@/lib/fetch-utils';
import type { CatalogEpisode, LibraryItem } from '@/lib/library-types';

export async function loadCatalog(item: Pick<LibraryItem, 'source' | 'vodId'>, signal?: AbortSignal): Promise<CatalogEpisode[]> {
  const url = new URL(item.source.url); url.searchParams.set('ac', 'videolist'); url.searchParams.set('ids', item.vodId);
  const data = await fetchUpstreamJson<{ list?: { vod_play_url?: string }[] }>(url.href, { headers: cmsRequestHeaders(), signal, timeoutMs: 15_000 });
  const raw = data.list?.[0]?.vod_play_url;
  if (typeof raw !== 'string') throw new Error('来源没有返回剧集列表');
  const groups = raw.split('$$$').map(group => group.split('#').map(entry => {
    const split = entry.indexOf('$');
    return { key: entry.slice(0, split).trim(), title: entry.slice(0, split).trim(), url: entry.slice(split + 1).trim() };
  }).filter(e => e.key && /^https?:\/\//.test(e.url)));
  const episodes = groups.find(group => group.some(e => /\.m3u8(?:\?|$)/i.test(e.url))) ?? groups.find(group => group.length);
  if (!episodes?.length) throw new Error('未发现可下载的剧集');
  if (episodes.length > 10_000 || new Set(episodes.map(e => e.key)).size !== episodes.length) throw new Error('剧集数量过多或集名重复，无法安全追更');
  return episodes;
}
