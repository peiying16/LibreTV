import { episodeAction } from '@/server/library/http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function POST(req: Request, ctx: Context) { return episodeAction(req, (await ctx.params).id); }
export const PUT = POST;
