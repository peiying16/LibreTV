import type { SourceConfig } from './types';

export type LibraryStatus = 'queued' | 'downloading' | 'ready' | 'error' | 'paused' | 'cancelled';
export interface LibraryEpisode {
  id: string; itemId: string; episodeKey: string; title: string; ordinal: number; url: string;
  generation: number; status: LibraryStatus; completed: number; total: number; bytes: number;
  error: string | null; entry: string | null; position: number; duration: number; progressUpdatedAt: number;
}
export interface LibraryItem {
  id: string; source: SourceConfig; vodId: string; title: string; cover: string;
  favorite: boolean; generation: number; error: string | null; updatedAt: number;
  nextCheck: number; cleanupThrough: number; episodes: LibraryEpisode[];
}
export interface CatalogEpisode { key: string; title: string; url: string }
export interface DownloadJob extends LibraryEpisode { owner: string; leaseUntil: number; attempts: number }
