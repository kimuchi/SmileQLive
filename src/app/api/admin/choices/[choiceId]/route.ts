/**
 * DELETE /api/admin/choices/[choiceId]  選択肢の削除
 *
 * 削除すると 2 個未満になる場合はサービス層が CHOICE_MINIMUM_REACHED を投げる。
 * 削除後の position は 1..N へ詰め直されるため、問題全体を返す。
 */

import { deleteChoice } from '@/application/services/quiz-service';
import { requireChoiceOwner } from '@/lib/auth/session';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin } from '@/lib/http/route-helpers';
import type { QuestionResponse } from '@/types/api';
import { loadAdminQuestion, requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { choiceId: string };

export const DELETE = withParams<Params>('admin.choices.delete', async (request, ctx) => {
  assertSameOrigin(request);

  const choiceId = requireUuidParam(ctx.params.choiceId, 'choiceId');

  // 応答へ返す親問題を特定するため、削除前に所有権込みで問題 ID を得る。
  const { question } = await requireChoiceOwner(choiceId);

  await deleteChoice(choiceId);

  const updated = await loadAdminQuestion(question.id);
  return jsonOk<QuestionResponse>({ question: updated });
});
