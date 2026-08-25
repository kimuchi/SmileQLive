'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/shared/Button';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { PresentScreen } from '@/components/presentation/PresentScreen';
import { useEnsureAnonymousSession } from '@/hooks/use-anonymous-session';
import { apiPost } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';

/**
 * 投影用リンクを開いたときの画面。
 *
 * - 投影担当にログインは求めない。**匿名認証 → セッションクッキー**を先に用意してから
 *   引き換え API を呼ぶ（引き換えはこの匿名ユーザーを presenter として登録する）。
 * - **URL はこのまま動かさない。** アドレスバーの URL をそのまま人へ渡せば、
 *   相手もログイン無しで同じ投影画面を開ける。
 *   以前は引き換えたあと /present/{ルームID} へ移していたが、
 *   その URL は本人しか開けないため、共有しようとすると相手が締め出された。
 * - 引き換えは何人が開いても通る。1 回で使い切りにはしない。
 * - トークンはリクエストボディで送る。/present/* は Referrer-Policy: no-referrer なので、
 *   外部サイトへ URL が漏れることもない。
 * - 引き換えは端末ごとに 1 回だけ試す。二重に投げない。
 */
export function PresentTokenExchange({ token }: { token: string }) {
  const ensureAnonymousSession = useEnsureAnonymousSession();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestedRef = useRef(false);

  // 購読し直さずに最新の関数を使うための参照。
  const ensureSessionRef = useRef(ensureAnonymousSession);
  useEffect(() => {
    ensureSessionRef.current = ensureAnonymousSession;
  }, [ensureAnonymousSession]);

  useEffect(() => {
    if (requestedRef.current) {
      return;
    }
    requestedRef.current = true;

    void (async () => {
      try {
        // 匿名ユーザーが無いまま引き換えると、presenter として登録する相手が決まらない。
        const ready = await ensureSessionRef.current();
        if (!ready) {
          setErrorMessage(
            'この端末で投影画面を開く準備ができませんでした。ページを再読み込みしてください',
          );
          return;
        }

        const result = await apiPost<{ roomId?: unknown }>('/api/presentation/exchange', { token });
        const roomId = typeof result?.roomId === 'string' ? result.roomId : null;
        if (!roomId) {
          setErrorMessage('投影用リンクを確認できませんでした');
          return;
        }
        setRoomId(roomId);
      } catch (caught) {
        setErrorMessage(toUserErrorMessage(caught));
      }
    })();
  }, [token]);

  if (errorMessage !== null) {
    return (
      <FullScreenMessage
        tone="stage"
        title="投影用リンクを開けません"
        description={errorMessage}
        actions={
          <Button variant="secondary" size="lg" onClick={() => window.location.reload()}>
            もう一度試す
          </Button>
        }
      >
        <p className="max-w-xl text-sm text-white/60">
          投影用リンクには期限があります。司会画面から発行し直してください。
        </p>
      </FullScreenMessage>
    );
  }

  if (roomId === null) {
    return <FullScreenMessage tone="stage" title="投影画面を準備しています" loading />;
  }

  return <PresentScreen roomId={roomId} />;
}
