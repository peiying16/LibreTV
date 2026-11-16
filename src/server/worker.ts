import { setTimeout as delay } from 'node:timers/promises';
import { libraryStore } from './library/store';
import { createLibraryWorker } from './library-worker';
const store = libraryStore(), worker = createLibraryWorker(store), shutdown = new AbortController();
const stop = () => { shutdown.abort(); void worker.stop(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
async function main() {
  while (!shutdown.signal.aborted) {
    try { await worker.tick(); } catch { store.health('后台任务暂时异常，将重试'); }
    await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
  await worker.stop(); store.close();
}
void main();
