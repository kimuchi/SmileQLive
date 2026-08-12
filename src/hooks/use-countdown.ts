'use client';

import { useEffect, useMemo, useState } from 'react';
import { remainingMs, type ServerClock } from '@/domain/room/timer';

/**
 * 残り時間のローカル更新。
 *
 * - DB / API を一切叩かない。締切時刻とサーバー時刻差だけで計算する。
 * - 250ms 間隔で更新する（1 秒表示には十分で、電池と再描画コストも抑えられる）。
 * - タブ復帰時は即座に再計算する（バックグラウンドでは setInterval が絞られるため）。
 *
 * `ready` は「いま渡されている締切時刻に対して計算済みか」。
 *
 * 締切時刻が届いた直後の 1 回だけ、状態にはまだ前の値（＝残り 0）が入っている。
 * その 1 回を「時間切れ」と受け取ると、締切の自動処理が本来より早く 1 度だけ走り、
 * 二重実行防止に阻まれて**本当の締切時刻には何も起きなくなる**。
 * 時間切れの判定には必ず `ready` を併せて見ること。
 */

const TICK_INTERVAL_MS = 250;

export type Countdown = {
  remainingSeconds: number;
  remainingMs: number;
  /** いまの締切時刻に対して計算済みか。時間切れ判定はこれが true のときだけ。 */
  ready: boolean;
};

type Computed = { deadline: string | null; leftMs: number };

export function useCountdown(deadlineAtIso: string | null, clock: ServerClock): Countdown {
  const offsetMs = clock.offsetMs;

  const [computed, setComputed] = useState<Computed>({ deadline: null, leftMs: 0 });

  useEffect(() => {
    const update = () => {
      const next = remainingMs(deadlineAtIso, { offsetMs }, Date.now());
      setComputed((previous) =>
        previous.deadline === deadlineAtIso && previous.leftMs === next
          ? previous
          : { deadline: deadlineAtIso, leftMs: next },
      );
    };

    update();

    if (!deadlineAtIso) {
      return;
    }

    const timerId = setInterval(update, TICK_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        update();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(timerId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [deadlineAtIso, offsetMs]);

  const ready = deadlineAtIso !== null && computed.deadline === deadlineAtIso;
  const leftMs = computed.deadline === deadlineAtIso ? computed.leftMs : 0;

  return useMemo(
    () => ({ remainingMs: leftMs, remainingSeconds: Math.ceil(leftMs / 1000), ready }),
    [leftMs, ready],
  );
}
