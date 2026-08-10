import 'server-only';

import { cookies } from 'next/headers';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getAdminAuth } from '@/infrastructure/firebase/admin';
import { logger } from '@/infrastructure/logging/logger';
import { SESSION_COOKIE_NAME } from '@/lib/auth/shared';
import { appEnvironment } from '@/lib/env/server-env';

/**
 * Firebase セッションクッキーの発行・検証・破棄。
 *
 * 方針:
 * - ブラウザは ID トークンを保持し続けない。ログイン直後に 1 度だけ
 *   `/api/auth/session` へ送り、サーバーが HttpOnly のセッションクッキーへ交換する。
 *   これにより XSS で ID トークンを盗まれる面を減らし、サーバー側で失効させられる。
 * - クッキーは HttpOnly / SameSite=Lax / Secure（ローカル以外）。
 *   SameSite=Lax は、二次元コードから他サイト経由で `/j/...` へ遷移しても
 *   クッキーが送られる（トップレベル GET ナビゲーション）ため参加導線を壊さない。
 * - **ID トークン・クッキー値をログへ出さない。**
 */

/** Firebase のセッションクッキー上限（14 日）。 */
const MAX_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** ローカル開発は http なので Secure を付けない（付けると保存されない）。 */
function useSecureCookie(): boolean {
  return appEnvironment() !== 'local';
}

function clampTtl(expiresInMs: number): number {
  const value = Math.trunc(expiresInMs);
  if (!Number.isFinite(value) || value <= 0) {
    return MAX_SESSION_TTL_MS;
  }
  return Math.min(value, MAX_SESSION_TTL_MS);
}

/**
 * ID トークンをセッションクッキー値へ交換する。
 *
 * Firebase の制約により、ID トークンは発行から 5 分以内でなければならない。
 * つまりこれはログイン直後にしか成功しない。
 */
export async function createSessionCookie(
  idToken: string,
  options: { expiresInMs: number },
): Promise<{ value: string; expiresInMs: number }> {
  const expiresIn = clampTtl(options.expiresInMs);
  const value = await getAdminAuth().createSessionCookie(idToken, { expiresIn });
  return { value, expiresInMs: expiresIn };
}

/** セッションクッキーを応答へ載せる。Route Handler / Server Action からのみ成功する。 */
export async function setSessionCookie(value: string, expiresInMs: number): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: useSecureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(clampTtl(expiresInMs) / 1000),
  });
}

/** セッションクッキーを削除する。 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: useSecureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/** 現在のリクエストのセッションクッキー値。無ければ null。 */
export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  return value && value.length > 0 ? value : null;
}

/**
 * セッションクッキーを検証する。
 *
 * `checkRevoked` を true にすると Firebase Auth への問い合わせが 1 回増える代わりに、
 * ログアウト（refresh token の失効）済みかどうかまで判定できる。
 * 参照系の毎リクエストでは false、管理操作では true を使い分ける。
 *
 * 検証失敗（期限切れ・改ざん・失効）は例外にせず null を返す。
 */
export async function verifySessionCookie(
  value: string,
  options: { checkRevoked?: boolean } = {},
): Promise<DecodedIdToken | null> {
  try {
    return await getAdminAuth().verifySessionCookie(value, options.checkRevoked ?? false);
  } catch (error) {
    // 値そのものは絶対に出さない。理由コードだけ残す。
    logger.debug('auth.session_cookie_invalid', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * 対象利用者のリフレッシュトークンを失効させる。
 * 以後 `verifySessionCookie(value, { checkRevoked: true })` は必ず失敗する。
 */
export async function revokeSessions(uid: string): Promise<void> {
  await getAdminAuth().revokeRefreshTokens(uid);
}
