import { requireRoomId } from '@/app/api/rooms/_lib/params';
import { submitAnswer } from '@/application/services/answer-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, defineRoute, parseJsonBody } from '@/lib/http/route-helpers';
import { submitAnswerSchema } from '@/lib/validation/schemas';
import type { SubmitAnswerResponse } from '@/types/api';

/**
 * 回答送信（参加者のみ）。
 *
 * - 正誤は返さない。返すのは「受理した事実」と受理時刻だけ。
 *   正解発表前に isCorrect を推測できる情報を一切載せない。
 * - 回答数 (answeredCount) は司会・投影向けの進捗情報なので参加者へは返さない。
 * - 締切・重複の最終判定は DB の submit_answer と UNIQUE 制約。
 * - レート制限は参加者単位（answer-service 内 `answer:{participantId}`）で行う。
 *   会場 Wi-Fi では数百人が同一 IP になりうるため、IP 単位では絞らない。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = defineRoute<{ roomId: string }>('rooms.answer', async (request, ctx) => {
  assertSameOrigin(request);
  const roomId = requireRoomId(ctx.params);
  const input = await parseJsonBody(request, submitAnswerSchema);
  const result = await submitAnswer(roomId, input);

  const body: SubmitAnswerResponse = { accepted: true, answeredAt: result.answeredAt };
  return jsonOk(body);
});
