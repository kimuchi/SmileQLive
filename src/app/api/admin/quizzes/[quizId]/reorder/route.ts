/**
 * POST /api/admin/quizzes/[quizId]/reorder  問題の並べ替え
 *
 * questionIds に含まれなかった問題は既存順のまま末尾へ回る（サービス層の仕様）。
 * 並べ替え後のクイズ詳細を返し、画面側が position を再計算しなくて済むようにする。
 */

import { getQuiz, reorderQuestions } from '@/application/services/quiz-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { reorderQuestionsSchema } from '@/lib/validation/schemas';
import type { QuizDetailResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { quizId: string };

export const POST = withParams<Params>('admin.questions.reorder', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const { questionIds } = await parseJsonBody(request, reorderQuestionsSchema);

  // 他クイズの問題 ID が混ざっていても、対象クイズの問題だけが並べ替えの対象になる。
  await reorderQuestions(quizId, questionIds);

  const quiz = await getQuiz(quizId);
  return jsonOk<QuizDetailResponse>({ quiz });
});
