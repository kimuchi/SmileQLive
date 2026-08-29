'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 投票結果の「ためて出す」進み方。
 *
 * 司会が「◯位を発表」を押すと、サーバーから 1 件増えた結果が届く。
 * それをそのまま出すと、押した瞬間に答えが出て会場が沸かない。
 * そこで **まず「◯位は…」だけを出してためる音を鳴らし**、
 * ためる音が鳴り終わったところで中身を出す。
 *
 * ためる長さは音の素材の実際の長さに合わせる（差し替えても間延びしない）。
 * 素材が読めていないときは既定の長さを使う。
 *
 * ここは React の状態遷移だけを持ち、音そのものは扱わない（呼び出し側が鳴らす）。
 */

/** ためる時間の下限・上限。素材の長さがこの範囲に丸められる。 */
export const POLL_BUILD_UP_MIN_MS = 1_500;
export const POLL_BUILD_UP_MAX_MS = 6_000;

export type PollRevealState = {
  /** いま「ためて」いる順位。ためていなければ null。 */
  pendingRank: number | null;
  /** 中身を出してよい件数。ためている間は 1 件少ない。 */
  shownCount: number;
};

export function buildUpMs(soundSeconds: number | null): number {
  const base = (soundSeconds ?? 2.5) * 1000;
  return Math.min(POLL_BUILD_UP_MAX_MS, Math.max(POLL_BUILD_UP_MIN_MS, base));
}

export type UsePollRevealInput = {
  /** サーバーが出してよいと言っている件数。 */
  revealedCount: number;
  /** そのとき出す順位（ためている間に見出しへ出す）。 */
  nextRank: number;
  /** ためる音の長さ（秒）。読めていなければ null。 */
  buildUpSeconds: number | null;
  /** ためはじめ。ためる音を鳴らす。 */
  onBuildUpStart?: () => void;
  /** 出す瞬間。発表の音を鳴らす。 */
  onReveal?: (rank: number) => void;
};

/**
 * ためて出す。
 *
 * `revealedCount` が 1 件増えたら、`buildUpSeconds` に合わせた時間だけためてから出す。
 *
 * **一度に 2 件以上増えたときと、減ったときはためない。**
 * 2 件以上増えるのは「途中から画面を開いた」ときで、すでに会場へ出ている順位を
 * 伏せてしまわないように、その場で追いつく。
 * 減るのは司会が数え直したときで、こちらもその場で合わせる。
 */
export function usePollReveal({
  revealedCount,
  nextRank,
  buildUpSeconds,
  onBuildUpStart,
  onReveal,
}: UsePollRevealInput): PollRevealState {
  const [shownCount, setShownCount] = useState(revealedCount);

  /*
    ためずにその場で合わせる場合（レンダー中の state 調整）。

    効果でやると、追いついていない画面が 1 フレーム出てしまう。
    次のレンダーで revealedCount === shownCount になり、ここは通らなくなる。
  */
  if (revealedCount < shownCount || revealedCount - shownCount > 1) {
    setShownCount(revealedCount);
  }

  // 最新の関数を効果の外へ持ち出す（関数が変わるたびにため直さないため）。
  const startRef = useRef(onBuildUpStart);
  const revealRef = useRef(onReveal);
  useEffect(() => {
    startRef.current = onBuildUpStart;
    revealRef.current = onReveal;
  }, [onBuildUpStart, onReveal]);

  const building = revealedCount === shownCount + 1;

  useEffect(() => {
    if (!building) {
      return;
    }
    startRef.current?.();

    const timerId = setTimeout(() => {
      // 効果の中で同期的に state を書かない。時間が来てから書く。
      setShownCount(revealedCount);
      revealRef.current?.(nextRank);
    }, buildUpMs(buildUpSeconds));

    return () => {
      clearTimeout(timerId);
    };
  }, [building, buildUpSeconds, nextRank, revealedCount]);

  return { pendingRank: building ? nextRank : null, shownCount };
}
