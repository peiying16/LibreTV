import { history } from '@/server/library/history-http';
export const runtime = 'nodejs';
export const GET = (req: Request) => history(req);
export const POST = GET;
export const DELETE = GET;
