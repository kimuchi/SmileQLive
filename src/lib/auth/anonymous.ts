import 'server-only';

/**
 * 参加者・投影担当のための匿名セッション確保。
 *
 * - 参加は QR コードの URL 直行のみ。ルームコード入力画面は作らない。
 * - 参加者にログインを求めないため、匿名 Auth ユーザーを Cookie で維持する。
 * - Cookie の書き込みは Route Handler / Server Action からのみ成功する。
 *   Server Component から呼ぶと更新が反映されないので、必ず API 経由で呼ぶこと。
 */

import type { User } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/infrastructure/supabase/server';
import { getOptionalAuthUser } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';

/** 既存セッションがあればそれを返し、無ければ匿名サインインする。 */
export async function ensureAuthSession(): Promise<User> {
  const existing = await getOptionalAuthUser();
  if (existing) {
    return existing;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInAnonymously();

  if (error || !data.user) {
    logger.error('auth.anonymous_sign_in_failed', { errorMessage: error?.message });
    throw new AppError('UNAUTHENTICATED', { cause: error });
  }

  return data.user;
}
