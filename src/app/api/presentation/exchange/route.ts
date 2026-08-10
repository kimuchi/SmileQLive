import { z } from 'zod';
import { exchangePresentationToken } from '@/application/services/room-service';
import { AppError } from '@/lib/errors/app-error';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody, withRoute } from '@/lib/http/route-helpers';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import { presentationTokenSchema } from '@/lib/validation/schemas';

/**
 * 投影用トークンを presenter メンバー登録へ引き換える。
 *
 * - トークンは URL ではなくリクエストボディで受け取り、ログ・Referer へ残さない。
 *   形式不正はそのまま「無効な投影URL」として扱い、詳細を返さない。
 * - 引き換え後は匿名セッション（Cookie）で presenter として認可される。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ボディ長だけを先に検証する。トークン形式の判定は presentationTokenSchema で行う。 */
const bodySchema = z.object({ token: z.string().min(1).max(256) });

export const POST = withRoute<{ roomId: string }>('presentation.exchange', async ({ request }) => {
  assertSameOrigin(request);

  // 投影端末は会場に数台。総当たり引き換えを抑えるための緩い上限。
  checkRateLimit(clientKeyFromRequest(request, 'presentation-exchange'), {
    limit: 60,
    windowMs: 60_000,
  });

  const body = await parseJsonBody(request, bodySchema);
  const parsed = presentationTokenSchema.safeParse(body.token);
  if (!parsed.success) {
    throw new AppError('PRESENTATION_LINK_INVALID');
  }

  const result = await exchangePresentationToken(parsed.data);
  return jsonOk(result);
});
