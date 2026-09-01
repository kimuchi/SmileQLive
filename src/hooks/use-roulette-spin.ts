'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { itemAtPointer, type RouletteItem } from '@/domain/roulette/wheel';
import { planSpin, rotationAt, type SpinPlan } from '@/domain/roulette/spin';

/**
 * URL だけで回すルーレットの進行。
 *
 * ボタン 1 つで回し、一定の割合で減速してひとりでに止まる。
 * 止まった位置にあったものが当たり（決め方は `domain/roulette/spin.ts`）。
 *
 * 角度は React の状態に持たず、要素の style を直接書き換える。
 * 毎秒 60 回の再描画を React へ通すと、項目が多いときに目に見えて重くなる。
 *
 * **回している間、当たりは画面のどこにも無い。**
 * 止まったところで初めて盤面から読む。
 */

export type RouletteSpinPhase = 'idle' | 'spinning' | 'stopped';

export type RouletteResult = {
  /** 何回目か。1 から数える。 */
  order: number;
  label: string;
};

export type RouletteSpin = {
  /** 円盤の要素。回転はここへ直接書き込む。 */
  wheelRef: RefObject<HTMLDivElement | null>;
  phase: RouletteSpinPhase;
  /** 直近の結果。まだ回していなければ null。 */
  result: RouletteResult | null;
  /** これまでの結果（新しいものが先）。リセットで消える。 */
  history: RouletteResult[];
  start: () => void;
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

export function useRouletteSpin(input: {
  items: readonly RouletteItem[];
  /** 1 フレームあたりの減速（度）。 */
  decel: number;
  /** 回し始めた瞬間。効果音を鳴らすために使う。 */
  onStart?: () => void;
  /** 止まった瞬間。 */
  onSettle?: (result: RouletteResult) => void;
}): RouletteSpin {
  const { items, decel, onStart, onSettle } = input;

  const wheelRef = useRef<HTMLDivElement | null>(null);
  /** いまの角度（度）。次に回すときの続きの角度として使う。 */
  const rotationRef = useRef(0);
  /**
   * 回し始めた時点の盤面。
   *
   * 回している最中に項目を書き換えられても、当たりはこの一覧から読む。
   * 画面側は回している間の編集を止めているが、当たりの決め方を
   * 画面の作りに頼らせない（片方だけ直したときに静かに壊れる）。
   */
  const spinItemsRef = useRef<readonly RouletteItem[]>(items);
  /** 何回目か。リセットで 1 に戻す。 */
  const orderRef = useRef(0);

  // 効果を張り直さずに最新の関数を呼ぶための参照。
  const onSettleRef = useRef(onSettle);
  useEffect(() => {
    onSettleRef.current = onSettle;
  }, [onSettle]);

  const [plan, setPlan] = useState<SpinPlan | null>(null);
  const [phase, setPhase] = useState<RouletteSpinPhase>('idle');
  const [history, setHistory] = useState<RouletteResult[]>([]);

  const start = useCallback(() => {
    if (phase === 'spinning') {
      return;
    }
    spinItemsRef.current = items;
    setPlan(planSpin({ startRotation: rotationRef.current, decel, random: randomUnit }));
    setPhase('spinning');
    onStart?.();
  }, [decel, items, onStart, phase]);

  const reset = useCallback(() => {
    const element = wheelRef.current;
    if (element) {
      element.style.transform = 'rotate(0deg)';
    }
    rotationRef.current = 0;
    orderRef.current = 0;
    setPlan(null);
    setPhase('idle');
    setHistory([]);
  }, []);

  useEffect(() => {
    const element = wheelRef.current;
    if (plan === null || element === null) {
      return;
    }

    const startedAt = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      const elapsed = now - startedAt;
      element.style.transform = `rotate(${String(rotationAt(plan, elapsed))}deg)`;

      if (elapsed < plan.durationMs) {
        frame = requestAnimationFrame(step);
        return;
      }

      // 止まった。ここで初めて盤面から当たりを読む。
      rotationRef.current = plan.endRotation;
      const winner = itemAtPointer(spinItemsRef.current, plan.endRotation);
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
  }, [plan]);

  return { wheelRef, phase, result: history[0] ?? null, history, start, reset };
}
