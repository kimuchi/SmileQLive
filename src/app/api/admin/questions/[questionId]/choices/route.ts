/**
 * POST /api/admin/questions/[questionId]/choices  選択肢を 1 つ追加する
 *
 * 追加した選択肢だけでなく、更新後の問題全体を返す（position が詰め直されるため）。
 * すでに 5 個ある場合はサービス層が CHOICE_LIMIT_REACHED を投げる。
 * 数値問題に対する追加は VALIDATION_FAILED になる。
 */

import { addChoice } from '@/application/services/quiz-service';
import { jsonCreated } from '@/lib/errors/api-response';
import { assertSameOrigin } from '@/lib/http/route-helpers';
import type { QuestionResponse } from '@/types/api';
import { loadAdminQuestion, requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { questionId: string };

export const POST = withParams<Params>('admin.choices.add', async (request, ctx) => {
  assertSameOrigin(request);

  const questionId = requireUuidParam(ctx.params.questionId, 'questionId');

  // 追加される選択肢は必ず isCorrect = false。正解の指定は問題更新 API で行う。
  await addChoice(questionId);

  const question = await loadAdminQuestion(questionId);
  return jsonCreated<QuestionResponse>({ question });
});
