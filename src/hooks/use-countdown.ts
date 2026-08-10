'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { remainingMs, type ServerClock } from '@/domain/room/timer';

/**
 * 残り時間のローカル更新。
 *
 * - DB / API を一切叩かない。締切時刻とサーバー時刻差だけで計算する。
 * - 250ms 間隔で更新する（1 秒表示には十分で、電池と再描画コストも抑えられる）。
 * - タブ復帰時は即座に再計算する（バックグラウンドでは setInterval が絞られるため）。
 */

const TICK_INTERVAL_MS = 250;

export type Countdown = {
  remainingSeconds: number;
  remainingMs: number;
};

export function useCountdown(deadlineAtIso: string | null, clock: ServerClock): Countdown {
  const offsetMs = clock.offsetMs;

  const compute = useCallback(
    () => remainingMs(deadlineAtIso, { offsetMs }, Date.now()),
    [deadlineAtIso, offsetMs],
  );

  const [leftMs, setLeftMs] = useState<number>(compute);

  useEffect(() => {
    const update = () => {
      const next = compute();
      setLeftMs((previous) => (previous === next ? previous : next));
      return next;
    };

    update();

    if (!deadlineAtIso) {
      return;
    }

    const timerId = setInterval(() => {
      update();
    }, TICK_INTERVAL_MS);

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
  }, [compute, deadlineAtIso]);

  return useMemo(
    () => ({ remainingMs: leftMs, remainingSeconds: Math.ceil(leftMs / 1000) }),
    [leftMs],
  );
}
