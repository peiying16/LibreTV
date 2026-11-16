import { onlineProgress } from '@/server/library/history-http';
export const runtime = 'nodejs';
export const GET = (req: Request) => onlineProgress(req);
export const PUT = GET;
