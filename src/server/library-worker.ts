import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LibraryStore } from './library/store';
import { loadCatalog } from './library/catalog';
import type { ArchiveFetcher } from './download/archive';
import { downloadArchive, DiskSpaceError, removeGenerations } from './download/archive';

export function createLibraryWorker(store: LibraryStore, dependencies: { catalog?: typeof loadCatalog; fetcher?: ArchiveFetcher } = {}) {
const mediaRoot = process.env.LIBRARY_MEDIA_DIR || join(store.root, 'media');
const owner = randomUUID(), shutdown = new AbortController();
const active = new Map<string, Promise<void>>();
async function tick() {
  for (const item of store.cleanupItems()) {
    try { removeGenerations(mediaRoot, item.id, item.cleanupThrough); store.cleaned(item.id, item.cleanupThrough); }
    catch { store.cleanupError(item.id); }
  }
  for (const item of store.due()) {
    if (shutdown.signal.aborted) return;
    try { store.syncEpisodes(item.id, item.generation, await (dependencies.catalog ?? loadCatalog)(item, shutdown.signal)); }
    catch { store.catalogError(item, '来源刷新失败，后台将重试'); }
  }
  const concurrency = Math.min(4, Math.max(1, Number(process.env.LIBRARY_CONCURRENT_DOWNLOADS) || 2));
  while (!shutdown.signal.aborted && active.size < concurrency) {
    const job = store.claim(owner + ':' + randomUUID()); if (!job) break;
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, controller.signal]);
    const watcher = setInterval(() => {
      if (!store.active(job)) controller.abort(); else store.heartbeat(job);
    }, 500);
    const task = (async () => {
      try {
        const entry = await downloadArchive(job.url, {
          fetcher: dependencies.fetcher,
          directory: join(mediaRoot, job.itemId, `g${job.generation}`, job.id), signal,
          guard: action => store.withLease(job, action),
          progress: (done, total, size) => store.downloaded(job, done, total, size),
        });
        store.complete(job, entry);
      } catch (error) {
        if (shutdown.signal.aborted) store.fail(job, '服务重启后将继续下载', true);
        else if (error instanceof DiskSpaceError) store.fail(job, error.message, true);
        else if (!signal.aborted) store.fail(job, error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[资源地址]') : '下载失败');
      } finally { clearInterval(watcher); active.delete(job.id); }
    })();
    active.set(job.id, task);
  }
  store.health();
}
return {
  tick,
  settle: () => Promise.allSettled([...active.values()]),
  stop: async () => { shutdown.abort(); await Promise.allSettled([...active.values()]); },
};
}
