/**
 * GET  /api/admin/quizzes/[quizId]/share  共有相手の一覧
 * PUT  /api/admin/quizzes/[quizId]/share  共有相手を置き換える
 *
 * 共有できるのは所有者だけ。共有された側は閲覧とルーム作成ができ、
 * 編集・削除・公開・共有設定はできない（quiz-service の認可で担保）。
 */

import { listQuizShares, setQuizShares } from '@/application/services/quiz-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { quizShareInputSchema } from '@/lib/validation/schemas';
import type { QuizShareResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { quizId: string };

export const GET = withParams<Params>('admin.quizzes.share.list', async (_request, ctx) => {
  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const shares = await listQuizShares(quizId);
  return jsonOk<QuizShareResponse>({ shares });
});

export const PUT = withParams<Params>('admin.quizzes.share.set', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const input = await parseJsonBody(request, quizShareInputSchema);
  const shares = await setQuizShares(quizId, input.emails);
  return jsonOk<QuizShareResponse>({ shares });
});
