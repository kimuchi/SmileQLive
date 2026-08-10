'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { signInAnonymouslyIfNeeded } from '@/infrastructure/firebase/client';
import { useOptionalFirebaseAuth } from '@/hooks/use-firebase-client';

/**
 * 参加者・投影担当用の匿名セッションを用意する。
 *
 * - **参加者へログインを求めない。** Firestore の購読（Security Rules は request.auth を見る）と
 *   サーバー API の認可のために、匿名 Auth ユーザーだけを用意する。
 * - すでにサインイン済みならそのユーザーを再利用する
 *   （再読込・再訪時に同じ参加者として復元されるため、回答済み判定が維持される）。
 * - どちらの場合も ID トークンを `/api/auth/session` で HttpOnly のセッションクッキーへ交換する。
 *   ID トークンはこの層から外へ出さない（保存・ログ・URL へ載せない）。
 * - **失敗しても例外を投げない。** 参加登録 API 側でも認証は確認されるため、
 *   ここで会場の参加を止めない。戻り値 false は「準備できなかった」だけを意味する。
 */
export function useEnsureAnonymousSession(): () => Promise<boolean> {
  const auth = useOptionalFirebaseAuth();

  return useCallback(async (): Promise<boolean> => {
    if (!auth) {
      // Firebase の公開設定が無い環境。画面側の「構成エラー」表示に任せる。
      return false;
    }
    try {
      await signInAnonymouslyIfNeeded();
      return true;
    } catch {
      // 失敗理由（トークン・ネットワーク）は画面にもログにも出さない。
      return false;
    }
  }, [auth]);
}

/**
 * マウント時に一度だけ匿名セッションを用意し、「準備が済んだか」を返す。
 *
 * 取得・購読を始めてよいタイミングを画面へ伝えるためのもの。
 * **失敗しても true になる**（サーバー API 側のエラー表示へ委ね、画面を無限ローディングにしない）。
 */
export function useAnonymousSessionReady(): boolean {
  const ensureAnonymousSession = useEnsureAnonymousSession();
  const [ready, setReady] = useState(false);

  // 購読し直さずに最新の関数を使うための参照。
  const ensureRef = useRef(ensureAnonymousSession);
  useEffect(() => {
    ensureRef.current = ensureAnonymousSession;
  }, [ensureAnonymousSession]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureRef.current();
      if (!cancelled) {
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return ready;
}
