/**
 * POST /api/admin/quizzes/[quizId]/publish  クイズを公開する
 *
 * 公開条件を満たさない場合は 422 を返す。
 * ボディは PublishResponse（published / issues）に加えて、
 * 汎用 API クライアントが読める error 形状も併せて含める。
 * どちらの読み方でも同じ issues 一覧へたどり着けるようにするため。
 */

import { publishQuiz } from '@/application/services/quiz-service';
import { jsonOk } from '@/lib/errors/api-response';
import type { ApiError } from '@/lib/errors/api-response';
import { userMessageForCode } from '@/lib/errors/app-error';
import { assertSameOrigin } from '@/lib/http/route-helpers';
import type { PublishResponse } from '@/types/api';
import { requireUuidParam, withParams } from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { quizId: string };

/** 公開失敗時のボディ。PublishResponse と ApiError の両方を満たす。 */
type PublishFailureBody = PublishResponse & ApiError;

export const POST = withParams<Params>('admin.quizzes.publish', async (request, ctx) => {
  assertSameOrigin(request);

  const quizId = requireUuidParam(ctx.params.quizId, 'quizId');
  const result = await publishQuiz(quizId);

  if (!result.published) {
    const body: PublishFailureBody = {
      published: false,
      issues: result.issues,
      error: {
        code: 'QUIZ_PUBLISH_VALIDATION_FAILED',
        message: userMessageForCode('QUIZ_PUBLISH_VALIDATION_FAILED'),
        details: result.issues,
        requestId: ctx.requestId,
      },
    };
    return jsonOk<PublishFailureBody>(body, { status: 422 });
  }

  return jsonOk<PublishResponse>(result);
});
