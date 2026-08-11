'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import {
  getFirebaseAuth,
  getFirebaseDb,
  initializeFirebaseClient,
  type FirebaseClientConfig,
} from '@/infrastructure/firebase/client';

/**
 * 実行時公開設定。
 *
 * ビルド時に NEXT_PUBLIC_* として埋め込まず、Server Component がリクエスト時に読んだ値を渡す。
 * これにより同一コンテナイメージをステージング／本番で再利用できる。
 *
 * **秘密情報を含めない。**
 * Firebase の apiKey は「公開前提の識別子」であって秘密鍵ではない（docs/FIRESTORE_MODEL.md §6）。
 * 実際の保護は Security Rules とサーバー側の認可で行う。
 */
export type RuntimeConfig = {
  firebaseApiKey: string;
  firebaseAuthDomain: string;
  firebaseProjectId: string;
  firebaseStorageBucket: string;
  firebaseAppId?: string | null;
  /** SmileQ Live 専用の Firestore データベース ID（既定の (default) は使わない）。 */
  firestoreDatabaseId: string;
  appBaseUrl: string;
  /** 司会ログインで許可するメールドメイン。画面表示と hd ヒントにのみ使う。 */
  allowedAuthDomains: string[];
  turnstileSiteKey: string | null;
};

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function RuntimeConfigProvider({
  value,
  children,
}: {
  value: RuntimeConfig;
  children: ReactNode;
}) {
  // 設定が届いた時点で Firebase を初期化しておく。
  //
  // 以前は初期化が useFirebaseAuth / useOptionalFirestore などのフック内でだけ行われ、
  // そのフックを使わない画面（管理ログイン）では未初期化のまま
  // signInWithGoogle() が呼ばれ、素の Error で失敗していた。
  // 「先にフックを呼んでおくこと」という暗黙の順序に頼らない。
  useMemo(() => {
    if (!value.firebaseApiKey || !value.firebaseAuthDomain || !value.firebaseProjectId) {
      // 設定不足は各画面が「構成エラー」として表示する。ここでは落とさない。
      return false;
    }
    try {
      initializeFirebaseClient({
        apiKey: value.firebaseApiKey,
        authDomain: value.firebaseAuthDomain,
        projectId: value.firebaseProjectId,
        storageBucket: value.firebaseStorageBucket,
        ...(value.firebaseAppId ? { appId: value.firebaseAppId } : {}),
        firestoreDatabaseId: value.firestoreDatabaseId,
      });
      return true;
    } catch {
      return false;
    }
  }, [
    value.firebaseApiKey,
    value.firebaseAuthDomain,
    value.firebaseProjectId,
    value.firebaseStorageBucket,
    value.firebaseAppId,
    value.firestoreDatabaseId,
  ]);

  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) {
    throw new Error('RuntimeConfigProvider が見つかりません');
  }
  return config;
}

/** Firebase SDK 用の設定を組み立てる。不足していれば原因が分かる形で失敗させる。 */
function toFirebaseClientConfig(input: {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  appId: string | null;
  firestoreDatabaseId: string;
}): FirebaseClientConfig {
  if (!input.apiKey || !input.authDomain || !input.projectId) {
    throw new Error(
      'FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_PROJECT_ID が設定されていません',
    );
  }
  return {
    apiKey: input.apiKey,
    authDomain: input.authDomain,
    projectId: input.projectId,
    storageBucket: input.storageBucket.length > 0 ? input.storageBucket : undefined,
    appId: input.appId ?? undefined,
    firestoreDatabaseId: input.firestoreDatabaseId,
  };
}

/** 設定値が変わらない限り同じ Firebase App を使い回すための共通処理。 */
function useFirebaseClientConfig(): FirebaseClientConfig {
  const {
    firebaseApiKey,
    firebaseAuthDomain,
    firebaseProjectId,
    firebaseStorageBucket,
    firebaseAppId,
    firestoreDatabaseId,
  } = useRuntimeConfig();

  return useMemo(
    () =>
      toFirebaseClientConfig({
        apiKey: firebaseApiKey,
        authDomain: firebaseAuthDomain,
        projectId: firebaseProjectId,
        storageBucket: firebaseStorageBucket,
        appId: firebaseAppId ?? null,
        firestoreDatabaseId,
      }),
    [
      firebaseApiKey,
      firebaseAuthDomain,
      firebaseProjectId,
      firebaseStorageBucket,
      firebaseAppId,
      firestoreDatabaseId,
    ],
  );
}

/** Firebase Auth。司会は Google、参加者・投影は匿名でサインインする。 */
export function useFirebaseAuth(): Auth {
  const config = useFirebaseClientConfig();
  return useMemo(() => {
    initializeFirebaseClient(config);
    return getFirebaseAuth();
  }, [config]);
}

/**
 * 読み取り専用の Firestore。
 * 参加者が購読してよいのは `rooms/{roomId}/public/state` だけ。
 * クライアントからの書き込みは Security Rules で全面的に拒否されている。
 */
export function useFirestore(): Firestore {
  const config = useFirebaseClientConfig();
  return useMemo(() => {
    initializeFirebaseClient(config);
    return getFirebaseDb();
  }, [config]);
}

/** ブラウザ側で Firebase を初期化できる構成が揃っているか。 */
export function useIsConfigured(): boolean {
  const config = useContext(RuntimeConfigContext);
  return Boolean(config?.firebaseApiKey && config?.firebaseAuthDomain && config?.firebaseProjectId);
}
