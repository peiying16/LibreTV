import { localMedia } from '@/server/library/http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; file: string }> };
export async function GET(req: Request, ctx: Context) { const { id, file } = await ctx.params; return localMedia(req, id, file); }
export const HEAD = GET;
