/**
 * POST /api/admin/quizzes/[quizId]/questions  問題を末尾へ追加する
 *
 * 選択式なら既定の選択肢が作られ、数値式なら数値条件が保存される
 * （どちらを作るかは createQuestionSchema の discriminated union で決まる）。
 */

import { createQuestion } from '@/application/services/quiz-service';
import { jsonCreated } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { createQuestionSchema } from '@/lib/validation/schemas';
import type { QuestionResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { quizId: string };

export const POST = withParams<Params>('admin.questions.create', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const input = await parseJsonBody(request, createQuestionSchema);

  // isCorrect を含む選択肢はクイズ所有者だけが設定できる（requireQuizOwner はサービス層）。
  const question = await createQuestion(quizId, input);
  return jsonCreated<QuestionResponse>({ question });
});
