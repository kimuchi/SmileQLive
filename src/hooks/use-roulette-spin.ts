'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { itemAtPointer, type RouletteItem } from '@/domain/roulette/wheel';
import {
  planStop,
  spinningRotationAt,
  stoppingRotationAt,
  type StopPlan,
} from '@/domain/roulette/spin';

/**
 * URL だけで回すルーレットの進行。
 *
 * スタートで**等速に回り続け**、ストップで減速して止まる。
 * 止まった位置にあったものが当たり（決め方は `domain/roulette/spin.ts`）。
 *
 * 角度は React の状態に持たず、要素の style を直接書き換える。
 * 毎秒 60 回の再描画を React へ通すと、項目が多いときに目に見えて重くなる。
 *
 * **回している間、当たりは画面のどこにも無い。**
 * ストップを押した瞬間に止まる角度を引き、止まったところで盤面から読む。
 */

export type RouletteSpinPhase =
  /** まだ回していない。 */
  | 'idle'
  /** 等速で回っている。ストップ待ち。 */
  | 'spinning'
  /** 減速している。もう止まる角度は決まっているが、画面には出していない。 */
  | 'stopping'
  /** 止まった。 */
  | 'stopped';

export type RouletteResult = {
  /** 何回目か。1 から数える。 */
  order: number;
  label: string;
};

export type RouletteSpin = {
  /** 円盤の要素。回転はここへ直接書き込む。 */
  wheelRef: RefObject<HTMLDivElement | null>;
  phase: RouletteSpinPhase;
  /** 直近の結果。まだ止めていなければ null。 */
  result: RouletteResult | null;
  /** これまでの結果（新しいものが先）。リセットで消える。 */
  history: RouletteResult[];
  start: () => void;
  stop: () => void;
  reset: () => void;
};

/** 0 以上 1 未満を、暗号用の乱数から作る。 */
function randomUnit(): number {
  const globalCrypto = typeof globalThis === 'undefined' ? undefined : globalThis.crypto;
  if (globalCrypto?.getRandomValues) {
    const buffer = new Uint32Array(1);
    globalCrypto.getRandomValues(buffer);
    return (buffer[0] ?? 0) / 2 ** 32;
  }
  // 古いブラウザ向けの控え。止まる位置の均一さは Math.random でも実用上足りる。
  return Math.random();
}

/** 回している最中の指示。効果を張り直す鍵にもなる。 */
type Motion =
  | { kind: 'spinning'; startedRotation: number; speed: number; token: number }
  | { kind: 'stopping'; plan: StopPlan; token: number };

export function useRouletteSpin(input: {
  items: readonly RouletteItem[];
  /** 回っている間の速さ（度/秒）。 */
  spinSpeed: number;
  /** ストップを押してから止まるまでの秒数。 */
  stopSeconds: number;
  /** 回し始めた瞬間。効果音を鳴らすために使う。 */
  onStart?: () => void;
  /** 止まった瞬間。 */
  onSettle?: (result: RouletteResult) => void;
}): RouletteSpin {
  const { items, spinSpeed, stopSeconds, onStart, onSettle } = input;

  const wheelRef = useRef<HTMLDivElement | null>(null);
  /** いまの角度（度）。ストップの計算と、次に回すときの続きの角度に使う。 */
  const rotationRef = useRef(0);
  /**
   * 回し始めた時点の盤面。
   *
   * 回している最中に項目を書き換えられても、当たりはこの一覧から読む。
   * 画面側は回している間の編集を止めているが、当たりの決め方を
   * 画面の作りに頼らせない（片方だけ直したときに静かに壊れる）。
   */
  const spinItemsRef = useRef<readonly RouletteItem[]>(items);
  /** 何回目か。リセットで 0 に戻す。 */
  const orderRef = useRef(0);
  /** 効果を張り直す鍵。同じ指示でも押し直したら作り直す。 */
  const tokenRef = useRef(0);

  // 効果を張り直さずに最新の関数を呼ぶための参照。
  const onSettleRef = useRef(onSettle);
  useEffect(() => {
    onSettleRef.current = onSettle;
  }, [onSettle]);

  const [motion, setMotion] = useState<Motion | null>(null);
  const [phase, setPhase] = useState<RouletteSpinPhase>('idle');
  const [history, setHistory] = useState<RouletteResult[]>([]);

  const start = useCallback(() => {
    if (phase === 'spinning' || phase === 'stopping') {
      return;
    }
    spinItemsRef.current = items;
    tokenRef.current += 1;
    setMotion({
      kind: 'spinning',
      startedRotation: rotationRef.current,
      speed: spinSpeed,
      token: tokenRef.current,
    });
    setPhase('spinning');
    onStart?.();
  }, [items, onStart, phase, spinSpeed]);

  const stop = useCallback(() => {
    if (phase !== 'spinning') {
      return;
    }
    tokenRef.current += 1;
    setMotion({
      kind: 'stopping',
      // 止まる角度はここで引く。押すまで決まっていない。
      plan: planStop({
        startRotation: rotationRef.current,
        speed: spinSpeed,
        stopSeconds,
        random: randomUnit,
      }),
      token: tokenRef.current,
    });
    setPhase('stopping');
  }, [phase, spinSpeed, stopSeconds]);

  const reset = useCallback(() => {
    const element = wheelRef.current;
    if (element) {
      element.style.transform = 'rotate(0deg)';
    }
    rotationRef.current = 0;
    orderRef.current = 0;
    tokenRef.current += 1;
    setMotion(null);
    setPhase('idle');
    setHistory([]);
  }, []);

  useEffect(() => {
    const element = wheelRef.current;
    if (motion === null || element === null) {
      return;
    }

    const startedAt = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      const elapsed = now - startedAt;

      if (motion.kind === 'spinning') {
        // 等速。ストップを押すまで続ける。
        rotationRef.current = spinningRotationAt({
          startRotation: motion.startedRotation,
          speed: motion.speed,
          elapsedMs: elapsed,
        });
        element.style.transform = `rotate(${String(rotationRef.current)}deg)`;
        frame = requestAnimationFrame(step);
        return;
      }

      rotationRef.current = stoppingRotationAt(motion.plan, elapsed);
      element.style.transform = `rotate(${String(rotationRef.current)}deg)`;

      if (elapsed < motion.plan.durationMs) {
        frame = requestAnimationFrame(step);
        return;
      }

      // 止まった。ここで初めて盤面から当たりを読む。
      rotationRef.current = motion.plan.endRotation;
      const winner = itemAtPointer(spinItemsRef.current, motion.plan.endRotation);
      setPhase('stopped');
      if (winner) {
        orderRef.current += 1;
        const result: RouletteResult = { order: orderRef.current, label: winner.label };
        setHistory((previous) => [result, ...previous]);
        // 状態の更新関数の中では鳴らさない（作り直しで二度鳴る）。
        onSettleRef.current?.(result);
      }
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [motion]);

  return { wheelRef, phase, result: history[0] ?? null, history, start, stop, reset };
}
