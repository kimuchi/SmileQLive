'use client';

import { useMemo } from 'react';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { useRuntimeConfig } from '@/components/shared/runtime-config-provider';
import {
  getFirebaseAuth,
  getFirebaseDb,
  initializeFirebaseClient,
  type FirebaseClientConfig,
} from '@/infrastructure/firebase/client';

/**
 * ブラウザ用 Firebase の取得（構成不足でも例外を投げない版）。
 *
 * 会場進行中に「設定が足りない」だけで画面全体を落とさないための入口。
 * 初期化できないときは null を返し、購読側は Snapshot API のポーリングだけで動き続ける。
 *
 * Firebase の公開設定はビルド時ではなく RuntimeConfig（リクエスト時に読んだ値）から渡す。
 */

function toClientConfig(input: {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  appId: string | null;
}): FirebaseClientConfig | null {
  if (!input.apiKey || !input.authDomain || !input.projectId) {
    return null;
  }
  return {
    apiKey: input.apiKey,
    authDomain: input.authDomain,
    projectId: input.projectId,
    storageBucket: input.storageBucket.length > 0 ? input.storageBucket : undefined,
    appId: input.appId ?? undefined,
  };
}

/** 初期化済みの Firebase App。設定が足りなければ null。 */
function useInitializedApp(): boolean {
  const {
    firebaseApiKey,
    firebaseAuthDomain,
    firebaseProjectId,
    firebaseStorageBucket,
    firebaseAppId,
  } = useRuntimeConfig();

  return useMemo(() => {
    const config = toClientConfig({
      apiKey: firebaseApiKey,
      authDomain: firebaseAuthDomain,
      projectId: firebaseProjectId,
      storageBucket: firebaseStorageBucket,
      appId: firebaseAppId ?? null,
    });
    if (!config) {
      return false;
    }
    try {
      initializeFirebaseClient(config);
      return true;
    } catch {
      // 設定不足は /api/diagnostics と画面の「構成エラー」で伝える。ここでは落とさない。
      return false;
    }
  }, [firebaseApiKey, firebaseAuthDomain, firebaseProjectId, firebaseStorageBucket, firebaseAppId]);
}

/**
 * 読み取り専用の Firestore。初期化できなければ null。
 * **クライアントからの書き込みは行わない。** 購読（onSnapshot）にだけ使う。
 */
export function useOptionalFirestore(): Firestore | null {
  const ready = useInitializedApp();
  return useMemo(() => {
    if (!ready) {
      return null;
    }
    try {
      return getFirebaseDb();
    } catch {
      return null;
    }
  }, [ready]);
}

/** Firebase Auth。初期化できなければ null。 */
export function useOptionalFirebaseAuth(): Auth | null {
  const ready = useInitializedApp();
  return useMemo(() => {
    if (!ready) {
      return null;
    }
    try {
      return getFirebaseAuth();
    } catch {
      return null;
    }
  }, [ready]);
}
