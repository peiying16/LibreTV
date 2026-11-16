import { itemAction } from '@/server/library/http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Context) { return itemAction(req, (await ctx.params).id); }
export const POST = GET;
export const DELETE = GET;
