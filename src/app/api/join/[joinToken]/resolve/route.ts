import { requireJoinToken } from '@/app/api/join/_lib/params';
import { resolveJoinToken } from '@/application/services/join-service';
import { jsonOk } from '@/lib/errors/api-response';
import { defineRoute } from '@/lib/http/route-helpers';
import type { JoinResolveResponse } from '@/types/api';

/**
 * 参加 URL の解決（QR コードから直行した参加者が最初に呼ぶ）。
 *
 * - 返すのはロビー表示に必要な最小限だけ。quiz_snapshot・問題・正解情報は返さない。
 * - トークンはログへ出さない。route-helpers が redactPath() でパスを潰す。
 * - IP 単位のレート制限は掛けない。会場 Wi-Fi では数百人が同一 IP になるため、
 *   正規の一斉参加を止めてしまう。トークン自体が 128bit 以上の乱数で総当たりは非現実的。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = defineRoute<{ joinToken: string }>('join.resolve', async (_request, ctx) => {
  const token = requireJoinToken(ctx.params);
  const resolved = await resolveJoinToken(token);
  return jsonOk<JoinResolveResponse>(resolved);
});
