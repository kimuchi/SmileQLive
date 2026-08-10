/**
 * PATCH  /api/admin/questions/[questionId]  問題の更新（問題型の変更もここで扱う）
 * DELETE /api/admin/questions/[questionId]  問題の削除（残りの position は詰め直される）
 *
 * 問題型の変更:
 *   choice → number ... 選択肢を削除し、numberRule を保存する
 *   number → choice ... 数値条件（正解値・許容誤差・範囲・単位）を消し、選択肢を作り直す
 * どちらもリポジトリ層の updateQuestion() が 1 か所で処理する。
 */

import { deleteQuestion, updateQuestion } from '@/application/services/quiz-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { updateQuestionSchema } from '@/lib/validation/schemas';
import type { QuestionResponse } from '@/types/api';
import {
  requireUuidParam,
  withParams,
  type DeletedResponse,
} from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { questionId: string };

export const PATCH = withParams<Params>('admin.questions.update', async (request, ctx) => {
  assertSameOrigin(request);

  const questionId = requireUuidParam(ctx.params.questionId, 'questionId');
  const input = await parseJsonBody(request, updateQuestionSchema);

  // isCorrect は所有権を確認したうえで反映する（requireQuestionOwner はサービス層）。
  const question = await updateQuestion(questionId, input);
  return jsonOk<QuestionResponse>({ question });
});

export const DELETE = withParams<Params>('admin.questions.delete', async (request, ctx) => {
  assertSameOrigin(request);

  const questionId = requireUuidParam(ctx.params.questionId, 'questionId');
  await deleteQuestion(questionId);

  return jsonOk<DeletedResponse>({ deleted: true });
});
