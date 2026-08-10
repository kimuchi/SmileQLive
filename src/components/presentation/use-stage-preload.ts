'use client';

import { useEffect, useRef } from 'react';

/**
 * 次に使う画像の事前読込。
 *
 * 会場では「問題を出した瞬間に画像が出ていない」ことが致命的なので、
 * Snapshot が返した preloadImageUrls（現在問題＋次問題の画像）を先に取りに行く。
 *
 * この URL は staff Snapshot にしか含まれない。
 * 正解解説画像は参加者へは発表まで配信されないが、投影端末は司会側の情報を扱えるため、
 * ここで先読みしてよい（画面へ出すのは正解発表フェーズになってから）。
 */

/** 会場 1 回分の上限。これ以上は覚えない（メモリを無駄に使わない）。 */
const MAX_TRACKED = 200;

export function useStagePreload(urls: readonly string[] | undefined): void {
  const requestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!urls || urls.length === 0) {
      return;
    }
    const requested = requestedRef.current;
    for (const url of urls) {
      if (typeof url !== 'string' || url.length === 0 || requested.has(url)) {
        continue;
      }
      if (requested.size >= MAX_TRACKED) {
        requested.clear();
      }
      requested.add(url);
      // Image で取りに行くとブラウザのキャッシュへ載り、表示時は即座に描画される。
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
    }
  }, [urls]);
}
