import { collection } from '@/server/library/http';
export const runtime = 'nodejs';
export const GET = (req: Request) => collection(req);
export const POST = (req: Request) => collection(req);
