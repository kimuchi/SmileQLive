import { requireJoinToken } from '@/app/api/join/_lib/params';
import {
  registerParticipant,
  resolveJoinToken,
  suggestNickname,
} from '@/application/services/join-service';
import { AppError } from '@/lib/errors/app-error';
import { jsonCreated } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute, parseJsonBody } from '@/lib/http/route-helpers';
import { registerParticipantSchema } from '@/lib/validation/schemas';
import type { JoinRegisterResponse } from '@/types/api';

/**
 * 参加登録（QR コードから直行した参加者）。
 *
 * レート制限・CAPTCHA 検証・人数上限・ニックネーム一意性はサービス層と DB が担保する。
 * ここでは重複時に「使える候補名」を details へ添えて、入力し直しの手間を減らす。
 *
 * details の形: { suggestedNickname: string }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ joinToken: string }>('join.register', async (request, ctx) => {
  assertSameOrigin(request);
  const token = requireJoinToken(ctx.params);
  const input = await parseJsonBody(request, registerParticipantSchema);

  try {
    const registered = await registerParticipant(token, input, request);
    return jsonCreated<JoinRegisterResponse>(registered);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'NICKNAME_TAKEN') {
      throw error;
    }

    // 候補名の算出に失敗しても、本来の 409 を握りつぶさない。
    let suggestedNickname: string | null = null;
    try {
      const { roomId } = await resolveJoinToken(token);
      suggestedNickname = await suggestNickname(roomId, input.nickname);
    } catch {
      suggestedNickname = null;
    }

    throw new AppError('NICKNAME_TAKEN', {
      details: suggestedNickname ? { suggestedNickname } : undefined,
      cause: error,
    });
  }
});
