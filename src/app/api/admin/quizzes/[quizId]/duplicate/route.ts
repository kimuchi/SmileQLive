/**
 * POST /api/admin/quizzes/[quizId]/duplicate  クイズを複製して下書きとして作る
 */

import { duplicateQuiz } from '@/application/services/quiz-service';
import { jsonCreated } from '@/lib/errors/api-response';
import { assertSameOrigin } from '@/lib/http/route-helpers';
import type { QuizDetailResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { quizId: string };

export const POST = withParams<Params>('admin.quizzes.duplicate', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');

  // 複製先の所有者は複製元の所有者（＝認証済みユーザー）に固定される。
  const quiz = await duplicateQuiz(quizId);
  return jsonCreated<QuizDetailResponse>({ quiz });
});
