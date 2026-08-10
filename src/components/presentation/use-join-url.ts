'use client';

import { useCallback, useEffect, useState } from 'react';
import { recallJoinUrl, rememberJoinUrl } from '@/components/admin/join-url-store';

/**
 * 待機画面に出す参加 URL の取得。
 *
 * 平文の参加トークンはルーム作成・参加URL再発行の応答にしか現れないため、
 * 同じブラウザの sessionStorage（司会画面が保管したもの）から読み出す。
 *
 * 守ること:
 * - 参加 URL を画面に文字として出さない。二次元コードとしてだけ提示する。
 * - ログ・解析・API へ送らない。保管先はタブを閉じれば消える sessionStorage だけ。
 * - 受け取ってよいのは同じサイトの参加ページ (/j/...) だけ。別サイトの URL は拒否する。
 */

/** 参加ページのパス接頭辞。ここ以外の URL は二次元コードにしない。 */
const JOIN_PATH_PREFIX = '/j/';

/** 貼り付けられた文字列が、この画面と同じサイトの参加 URL かどうか。 */
function normalizeJoinUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const url = new URL(trimmed, window.location.origin);
    if (url.origin !== window.location.origin) {
      return null;
    }
    if (!url.pathname.startsWith(JOIN_PATH_PREFIX)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export type JoinUrlState = {
  joinUrl: string | null;
  /** 手入力された参加 URL を受け入れたら true。形式が違えば false。 */
  setJoinUrl: (value: string) => boolean;
};

export function useJoinUrl(roomId: string): JoinUrlState {
  const [joinUrl, setJoinUrlState] = useState<string | null>(null);

  useEffect(() => {
    // sessionStorage はレンダー中に読めない（サーバー描画と食い違う）ため、
    // 画面表示後に一度だけ読み出す。
    const stored = recallJoinUrl(roomId);
    const normalized = stored ? normalizeJoinUrl(stored) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 保管済みの参加URLはレンダー中に読めないため
    setJoinUrlState(normalized);
  }, [roomId]);

  const setJoinUrl = useCallback(
    (value: string): boolean => {
      const normalized = normalizeJoinUrl(value);
      if (!normalized) {
        return false;
      }
      rememberJoinUrl(roomId, normalized);
      setJoinUrlState(normalized);
      return true;
    },
    [roomId],
  );

  return { joinUrl, setJoinUrl };
}
