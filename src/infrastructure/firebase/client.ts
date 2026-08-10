'use client';

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
  signInAnonymously,
  signInWithPopup,
  signOut,
  type Auth,
  type User as FirebaseUser,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { apiDelete, apiPost } from '@/lib/client/api-client';
import type { CreateSessionRequestBody, CreateSessionResponse } from '@/lib/auth/shared';

/**
 * ブラウザ用 Firebase SDK。
 *
 * 方針:
 * - 設定はビルド時に埋め込まず、RuntimeConfig（Server Component がリクエスト時に読んだ値）から渡す。
 *   同一コンテナイメージをステージング／本番で再利用するため。
 * - **クライアントから Firestore へ書き込まない。** 読み取り（onSnapshot）専用。
 *   書き込みはすべて Admin SDK 経由（docs/FIRESTORE_MODEL.md §4）。
 * - ID トークンは保持し続けず、ログイン直後に `/api/auth/session` で
 *   HttpOnly のセッションクッキーへ交換する。
 * - トークンを console / ログへ出さない。
 */

export type FirebaseClientConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string | undefined;
  appId?: string | undefined;
};

let cachedApp: FirebaseApp | null = null;

/** Firebase App をシングルトンで初期化する。2 回目以降は既存インスタンスを返す。 */
export function initializeFirebaseClient(config: FirebaseClientConfig): FirebaseApp {
  if (cachedApp) {
    return cachedApp;
  }

  if (getApps().length > 0) {
    cachedApp = getApp();
    return cachedApp;
  }

  if (!config.apiKey || !config.projectId || !config.authDomain) {
    throw new Error('Firebase の公開設定（apiKey / authDomain / projectId）が渡されていません');
  }

  cachedApp = initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
    ...(config.appId ? { appId: config.appId } : {}),
  });

  return cachedApp;
}

function requireApp(config?: FirebaseClientConfig): FirebaseApp {
  if (config) {
    return initializeFirebaseClient(config);
  }
  if (cachedApp) {
    return cachedApp;
  }
  if (getApps().length > 0) {
    cachedApp = getApp();
    return cachedApp;
  }
  throw new Error('Firebase が初期化されていません（initializeFirebaseClient を先に呼ぶこと）');
}

export function getFirebaseAuth(config?: FirebaseClientConfig): Auth {
  const auth = getAuth(requireApp(config));
  // Google のログイン画面・エラー文言を日本語にする。
  auth.languageCode = 'ja';
  return auth;
}

/**
 * 読み取り専用の Firestore クライアント。
 * 参加者が購読してよいのは `rooms/{roomId}/public/state` だけ（Security Rules で担保済み）。
 */
export function getFirebaseDb(config?: FirebaseClientConfig): Firestore {
  return getFirestore(requireApp(config));
}

// ---------------------------------------------------------------------------
// サインイン
// ---------------------------------------------------------------------------

export type SignInResult = {
  uid: string;
  email: string | null;
  displayName: string | null;
};

/**
 * 司会・管理者の Google ログイン。
 *
 * `hd` パラメータは「Workspace アカウント選択画面を絞る」ための **UX 上のヒント**にすぎない。
 * ブラウザが送る値は改ざんできるため、**許可ドメインの判定は必ずサーバー側**
 * （/api/auth/session と requireHostUser）で行う。
 */
export async function signInWithGoogle(
  options: { allowedDomains?: string[] } = {},
): Promise<SignInResult> {
  const auth = getFirebaseAuth();
  await setPersistence(auth, browserLocalPersistence);

  const provider = new GoogleAuthProvider();
  const customParameters: Record<string, string> = { prompt: 'select_account' };

  const domains = options.allowedDomains ?? [];
  const onlyDomain = domains.length === 1 ? domains[0] : undefined;
  if (onlyDomain) {
    // hd は 1 ドメインしか指定できない。複数許可時はヒントを付けない。
    customParameters.hd = onlyDomain;
  }
  provider.setCustomParameters(customParameters);

  const credential = await signInWithPopup(auth, provider);
  await exchangeSessionCookie(credential.user);

  return {
    uid: credential.user.uid,
    email: credential.user.email,
    displayName: credential.user.displayName,
  };
}

/**
 * 参加者・投影担当の匿名サインイン。
 *
 * すでにサインイン済みなら再利用し（再訪時に同じ参加者として復元される）、
 * どちらの場合もセッションクッキーを張り直す。
 */
export async function signInAnonymouslyIfNeeded(): Promise<string> {
  const auth = getFirebaseAuth();
  await setPersistence(auth, browserLocalPersistence);
  await auth.authStateReady();

  const current = auth.currentUser;
  if (current) {
    await exchangeSessionCookie(current);
    return current.uid;
  }

  const credential = await signInAnonymously(auth);
  await exchangeSessionCookie(credential.user);
  return credential.user.uid;
}

/**
 * ID トークンを `/api/auth/session` へ渡し、HttpOnly のセッションクッキーへ交換する。
 * トークンはこの関数の外へ出さない（保存・ログ・URL へ載せない）。
 */
export async function exchangeSessionCookie(
  user?: FirebaseUser | null,
): Promise<CreateSessionResponse> {
  const target = user ?? getFirebaseAuth().currentUser;
  if (!target) {
    throw new Error('サインインしていません');
  }

  const idToken = await target.getIdToken(true);
  const body: CreateSessionRequestBody = { idToken };
  return apiPost<CreateSessionResponse>('/api/auth/session', body);
}

/**
 * ログアウト。
 *
 * サーバー側のセッションクッキー削除とリフレッシュトークン失効を先に行い、
 * その後ブラウザ側のサインイン状態を消す。
 * サーバー側が失敗してもブラウザ側は必ずサインアウトさせる。
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    await apiDelete<unknown>('/api/auth/session');
  } finally {
    await signOut(getFirebaseAuth());
  }
}

/** テスト用にシングルトンを破棄する。 */
export function resetFirebaseClient(): void {
  cachedApp = null;
}
