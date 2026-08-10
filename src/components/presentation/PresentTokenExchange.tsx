'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/shared/Button';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import { apiPost } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';

/**
 * 別端末で投影を始めるための引き換え画面。
 *
 * - 投影用トークンは URL ではなく **リクエストボディ** で送る。
 *   ログ・Referer・解析へトークンを残さない（/present/* は Referrer-Policy: no-referrer）。
 * - 引き換えに成功したら投影画面へ replace 遷移し、URL からトークンを取り除く。
 *   戻るボタンでトークン付き URL へ戻れないようにする。
 * - 引き換えは 1 回だけ試す。二重に投げてリンクを無駄に消費しない。
 */
export function PresentTokenExchange({ token }: { token: string }) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) {
      return;
    }
    requestedRef.current = true;

    void (async () => {
      try {
        const result = await apiPost<{ roomId?: unknown }>('/api/presentation/exchange', { token });
        const roomId = typeof result?.roomId === 'string' ? result.roomId : null;
        if (!roomId) {
          setErrorMessage('投影用リンクを確認できませんでした');
          return;
        }
        router.replace(`/present/${roomId}`);
      } catch (caught) {
        setErrorMessage(toUserErrorMessage(caught));
      }
    })();
  }, [router, token]);

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

  return <FullScreenMessage tone="stage" title="投影画面を準備しています" loading />;
}
