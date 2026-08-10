import 'server-only';

/**
 * 参加 URL の動的セグメント検証。
 *
 * - トークンは検証結果しか外へ出さない。ログ・エラー詳細へ載せない。
 * - 形式不正は「無効な参加URL」(404) として扱い、存在有無を推測させない。
 */

import { AppError } from '@/lib/errors/app-error';
import { joinTokenSchema } from '@/lib/validation/schemas';

export function requireJoinToken(params: { joinToken: string }): string {
  const parsed = joinTokenSchema.safeParse(params.joinToken);
  if (!parsed.success) {
    throw new AppError('JOIN_LINK_INVALID');
  }
  return parsed.data;
}
