/**
 * POST   /api/auth/session   ID トークン → セッションクッキー交換（ログイン）
 * DELETE /api/auth/session   セッションクッキー破棄 + リフレッシュトークン失効（ログアウト）
 *
 * 設計:
 * - ブラウザは ID トークンを保持し続けない。ここで HttpOnly のクッキーへ交換する。
 * - 司会（Google）の許可ドメイン判定は **サーバー側で**行う。
 *   クライアントが送る hd / email は信用しない。
 * - **profiles/{uid} をここで作成しない**（docs/HOST_ACCESS.md）。
 *   ドメイン制限を掛けない運用のため、自動作成は「Google アカウントを持つ誰でも司会者」
 *   になってしまう。サインインは成功させ、権限の有無は isHost で返すだけにする。
 * - 参加者・投影担当は匿名認証。管理画面へは入れない（profiles を持たないため）。
 * - ID トークン・クッキー値をログへ出さない。
 */

import type { DecodedIdToken } from 'firebase-admin/auth';
import { z } from 'zod';
import { getAdminAuth, getDb } from '@/infrastructure/firebase/admin';
import {
  clearSessionCookie,
  createSessionCookie,
  readSessionCookie,
  revokeSessions,
  setSessionCookie,
  verifySessionCookie,
} from '@/infrastructure/firebase/session-cookie';
import { logger } from '@/infrastructure/logging/logger';
import {
  ANONYMOUS_SESSION_TTL_MS,
  HOST_SESSION_TTL_MS,
  SIGN_IN_PROVIDER,
  emailDomain,
  isAllowedAuthDomain,
  type CreateSessionResponse,
  type DeleteSessionResponse,
} from '@/lib/auth/shared';
import { allowedAuthDomains } from '@/lib/env/server-env';
import { AppError } from '@/lib/errors/app-error';
import { jsonOk } from '@/lib/errors/api-response';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import { assertSameOrigin, parseJsonBody, withRoute } from '@/lib/http/route-helpers';
import { COLLECTIONS } from '@/types/firestore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ID トークンは JWT。長さの上限を決めて過大なボディを弾く。 */
const createSessionSchema = z.object({
  idToken: z.string().min(40).max(8192),
});

/**
 * 司会者かどうか（profiles/{uid} が存在するか）を**確認するだけ**。
 *
 * **ここで profiles を作成してはいけない**（docs/HOST_ACCESS.md §2）。
 * ドメイン制限を掛けない運用のため、自動作成すると
 * 「Google アカウントを持つ誰でも司会者」になってしまう。
 * 司会者の追加は管理スクリプト／Firebase コンソールでの明示操作のみ。
 */
async function hasHostProfile(uid: string): Promise<boolean> {
  const snapshot = await getDb().collection(COLLECTIONS.profiles).doc(uid).get();
  return snapshot.exists;
}

export const POST = withRoute<CreateSessionResponse>('auth.session.create', async ({ request }) => {
  assertSameOrigin(request);
  checkRateLimit(clientKeyFromRequest(request, 'auth.session'), {
    limit: 30,
    windowMs: 60_000,
  });

  const { idToken } = await parseJsonBody(request, createSessionSchema);

  // 失効済みトークンでのログインを防ぐため checkRevoked を有効にする。
  let decoded: DecodedIdToken;
  try {
    decoded = await getAdminAuth().verifyIdToken(idToken, true);
  } catch {
    // 失敗理由（期限切れ・改ざん）を利用者へ区別して返さない。
    throw new AppError('UNAUTHENTICATED');
  }

  const provider = decoded.firebase.sign_in_provider;
  const isAnonymous = provider === SIGN_IN_PROVIDER.anonymous;

  // 想定しているのは Google（司会）と匿名（参加者・投影）だけ。
  if (!isAnonymous && provider !== SIGN_IN_PROVIDER.google) {
    logger.warn('auth.unsupported_provider', { provider });
    throw new AppError('FORBIDDEN', { details: { reason: 'unsupported_provider' } });
  }

  const email = typeof decoded.email === 'string' ? decoded.email : null;
  let isHost = false;

  if (!isAnonymous) {
    if (decoded.email_verified !== true) {
      throw new AppError('FORBIDDEN', { details: { reason: 'email_not_verified' } });
    }

    // ALLOWED_AUTH_DOMAINS を設定した環境だけドメインで絞る（既定は制限なし）。
    // これは profiles による制御へ**追加する**多層防御であって、置き換えではない。
    if (!isAllowedAuthDomain(email, allowedAuthDomains())) {
      // メールアドレスそのものはログへ出さない（ドメインのみ）。
      logger.warn('auth.domain_not_allowed', { domain: emailDomain(email) });
      throw new AppError('FORBIDDEN', { details: { reason: 'domain_not_allowed' } });
    }

    // サインイン自体は成功させ、権限の有無だけを返す。
    // 管理者は「一度ログインしてもらってから profiles を作る」運用ができる。
    isHost = await hasHostProfile(decoded.uid);
  }

  const ttlMs = isAnonymous ? ANONYMOUS_SESSION_TTL_MS : HOST_SESSION_TTL_MS;
  const { value, expiresInMs } = await createSessionCookie(idToken, { expiresInMs: ttlMs });
  await setSessionCookie(value, expiresInMs);

  logger.info('auth.session_created', { userId: decoded.uid, provider, isHost });

  return jsonOk<CreateSessionResponse>({
    uid: decoded.uid,
    isAnonymous,
    isHost,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
});

export const DELETE = withRoute<DeleteSessionResponse>(
  'auth.session.delete',
  async ({ request }) => {
    assertSameOrigin(request);

    const cookieValue = await readSessionCookie();
    if (cookieValue) {
      const decoded = await verifySessionCookie(cookieValue);
      if (decoded) {
        try {
          // 以後 checkRevoked 付きの検証がすべて失敗する。
          await revokeSessions(decoded.uid);
        } catch {
          // 失効に失敗してもクッキー削除は必ず行う。
          logger.warn('auth.revoke_failed', { userId: decoded.uid });
        }
      }
    }

    await clearSessionCookie();

    return jsonOk<DeleteSessionResponse>({ signedOut: true });
  },
);
