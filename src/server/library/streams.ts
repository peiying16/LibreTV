import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

type Registry = Map<string, Set<() => void>>;
const globalRegistry = globalThis as typeof globalThis & { __libretvStreams?: Registry };
const registry = globalRegistry.__libretvStreams ??= new Map();
export function stopItemStreams(id: string) { for (const stop of registry.get(id) ?? []) stop(); registry.delete(id); }
export function mediaBody(input: Readable | ReadableStream<Uint8Array>, itemId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const stream = input instanceof Readable ? input : Readable.fromWeb(input as NodeReadableStream);
  const stop = () => stream.destroy(new Error('播放已停止'));
  const entries = registry.get(itemId) ?? new Set(); entries.add(stop); registry.set(itemId, entries);
  signal.addEventListener('abort', stop, { once: true });
  stream.once('close', () => { entries.delete(stop); if (!entries.size) registry.delete(itemId); signal.removeEventListener('abort', stop); });
  // Response 消费端负责错误；在尚未开始读取时也不产生未捕获的 Node error。
  stream.on('error', () => {});
  if (signal.aborted) stop();
  return Readable.toWeb(stream, { strategy: { highWaterMark: 65536, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>;
}
