import { guardRequest } from '@/lib/api-guard';
import { libraryStore } from '@/server/library/store';
export const runtime = 'nodejs';
export async function GET(req: Request) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stop = () => {};
  const body = new ReadableStream({
    start(controller) {
      let closed = false, previous = '';
      stop = () => { if (closed) return; closed = true; clearInterval(timer); req.signal.removeEventListener('abort', stop); try { controller.close(); } catch { /* 消费端可能已经关闭 */ } };
      const send = () => {
        if (closed) return;
        try {
          const store = libraryStore();
          const signature = String(store.revision());
          if (signature !== previous) { previous = signature; controller.enqueue(new TextEncoder().encode('data: updated\n\n')); }
          else controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
        } catch { stop(); }
      };
      timer = setInterval(send, 1000); req.signal.addEventListener('abort', stop, { once: true });
      if (req.signal.aborted) stop(); else send();
    },
    cancel() { stop(); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
