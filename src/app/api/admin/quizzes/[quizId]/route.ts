/**
 * GET    /api/admin/quizzes/[quizId]  クイズ詳細（問題・選択肢を含む司会者用データ）
 * PATCH  /api/admin/quizzes/[quizId]  クイズ設定の更新
 * DELETE /api/admin/quizzes/[quizId]  アーカイブ（物理削除はしない）
 */

import { archiveQuiz, getQuiz, updateQuiz } from '@/application/services/quiz-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { updateQuizSchema } from '@/lib/validation/schemas';
import type { QuizDetailResponse } from '@/types/api';
import {
  requireUuidParam,
  withParams,
  type ArchivedResponse,
} from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { quizId: string };

export const GET = withParams<Params>('admin.quizzes.get', async (_request, ctx) => {
  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const quiz = await getQuiz(quizId);
  return jsonOk<QuizDetailResponse>({ quiz });
});

export const PATCH = withParams<Params>('admin.quizzes.update', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const input = await parseJsonBody(request, updateQuizSchema);

  // 所有権はサービス層の requireQuizOwner で確認する。
  const quiz = await updateQuiz(quizId, input);
  return jsonOk<QuizDetailResponse>({ quiz });
});

export const DELETE = withParams<Params>('admin.quizzes.archive', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  await archiveQuiz(quizId);

  return jsonOk<ArchivedResponse>({ archived: true });
});
