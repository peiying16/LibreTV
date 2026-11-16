import { relay } from '@/server/library/http';
export const runtime = 'nodejs';
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) { return relay(req, (await ctx.params).id); }
