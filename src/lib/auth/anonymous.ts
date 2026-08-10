import 'server-only';

/**
 * 参加者・投影担当のための匿名セッション確保。
 *
 * - 参加は QR コードの URL 直行のみ。ルームコード入力画面は作らない。
 * - 参加者にログインを求めないため、匿名 Auth ユーザーをセッションクッキーで維持する。
 * - 通常はブラウザ側（src/infrastructure/firebase/client.ts の
 *   `signInAnonymouslyIfNeeded()`）が匿名サインイン → `/api/auth/session` 交換まで済ませる。
 *   ここはその取りこぼし（ポップアップ抑止・JS 失敗など）を救うサーバー側の保険で、
 *   Identity Toolkit の REST API で匿名ユーザーを起こしてクッキーを張る。
 * - Cookie の書き込みは Route Handler / Server Action からのみ成功する。
 *   Server Component から呼ぶと更新が反映されないので、必ず API 経由で呼ぶこと。
 * - **ID トークンをログへ出さない。**
 */

import { logger } from '@/infrastructure/logging/logger';
import { createSessionCookie, setSessionCookie } from '@/infrastructure/firebase/session-cookie';
import { getOptionalAuthUser } from '@/lib/auth/session';
import { ANONYMOUS_SESSION_TTL_MS, type AuthUser } from '@/lib/auth/shared';
import { firebaseApiKey } from '@/lib/env/server-env';
import { AppError } from '@/lib/errors/app-error';

type SignUpResponse = {
  idToken?: string;
  localId?: string;
};

/** エミュレーター利用時はそちらへ向ける。未設定なら本番エンドポイント。 */
function identityToolkitEndpoint(path: string): string {
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator && emulator.trim().length > 0) {
    return `http://${emulator.trim()}/identitytoolkit.googleapis.com/v1/${path}`;
  }
  return `https://identitytoolkit.googleapis.com/v1/${path}`;
}

/**
 * 匿名ユーザーを新規作成し、ID トークンを得る。
 *
 * Firebase Admin SDK には「匿名ユーザーとしてサインインする」API が無いため、
 * ブラウザ SDK と同じ Identity Toolkit の `accounts:signUp` を使う。
 * API キーは公開前提の識別子なので、サーバーから使っても秘密が増えるわけではない。
 */
async function signUpAnonymously(): Promise<{ idToken: string; uid: string }> {
  let apiKey: string;
  try {
    apiKey = firebaseApiKey();
  } catch {
    // 設定不足を「ログインしていない」と誤って伝えない。
    logger.error('auth.anonymous_sign_up_misconfigured', { missing: 'FIREBASE_API_KEY' });
    throw new AppError('CONFIGURATION_ERROR');
  }

  const response = await fetch(
    `${identityToolkitEndpoint('accounts:signUp')}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    // 応答本文にはトークンが含まれうるのでログへ出さない。状態コードのみ残す。
    logger.error('auth.anonymous_sign_up_failed', { status: response.status });
    throw new AppError('UNAUTHENTICATED');
  }

  const payload = (await response.json()) as SignUpResponse;
  if (!payload.idToken || !payload.localId) {
    logger.error('auth.anonymous_sign_up_incomplete', { status: response.status });
    throw new AppError('UNAUTHENTICATED');
  }

  return { idToken: payload.idToken, uid: payload.localId };
}

/** 既存セッションがあればそれを返し、無ければ匿名サインインしてクッキーを張る。 */
export async function ensureAuthSession(): Promise<AuthUser> {
  const existing = await getOptionalAuthUser();
  if (existing) {
    return existing;
  }

  try {
    const { idToken, uid } = await signUpAnonymously();
    const { value, expiresInMs } = await createSessionCookie(idToken, {
      expiresInMs: ANONYMOUS_SESSION_TTL_MS,
    });
    await setSessionCookie(value, expiresInMs);

    logger.info('auth.anonymous_session_created', { userId: uid });

    return {
      uid,
      id: uid,
      email: null,
      isAnonymous: true,
      displayName: null,
      hostedDomain: null,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('auth.anonymous_sign_in_failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    throw new AppError('UNAUTHENTICATED', { cause: error });
  }
}
