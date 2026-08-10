/**
 * POST /api/admin/questions/[questionId]/reorder-choices  選択肢の並べ替え
 *
 * choiceIds に含まれなかった選択肢は既存順のまま末尾へ回る（サービス層の仕様）。
 */

import { reorderChoices } from '@/application/services/quiz-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { reorderChoicesSchema } from '@/lib/validation/schemas';
import type { QuestionResponse } from '@/types/api';
import { loadAdminQuestion, requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { questionId: string };

export const POST = withParams<Params>('admin.choices.reorder', async (request, ctx) => {
  assertSameOrigin(request);

  const questionId = requireUuidParam(ctx.params.questionId, 'questionId');
  const { choiceIds } = await parseJsonBody(request, reorderChoicesSchema);

  // 他問題の選択肢 ID が混ざっていても、対象問題の選択肢だけが並べ替えの対象になる。
  await reorderChoices(questionId, choiceIds);

  const question = await loadAdminQuestion(questionId);
  return jsonOk<QuestionResponse>({ question });
});
