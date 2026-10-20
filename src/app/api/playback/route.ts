import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { PLAYBACK_TTL_MS, signedPlaybackUrl } from '@/lib/auth';
import { checkUpstreamAllowed } from '@/lib/ssrf';

export const runtime = 'nodejs';

/** 登录后为原生 HLS/AirPlay 签发播放地址，不把会话或密码交给电视。 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let url: string;
  let adFilter: boolean;
  try {
    const body = await req.json();
    if (typeof body.url !== 'string') return jsonError('缺少播放地址', 400);
    url = new URL(body.url).href;
    adFilter = body.adFilter === true;
  } catch {
    return jsonError('无效的播放请求', 400);
  }
  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) return jsonError(verdict.reason, 400);
  const expiresAt = Date.now() + PLAYBACK_TTL_MS;
  return NextResponse.json(
    { url: signedPlaybackUrl(url, { expiresAt, adFilter }), expiresAt },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
