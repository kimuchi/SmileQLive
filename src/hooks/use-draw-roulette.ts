'use client';

import { useEffect, useRef, useState } from 'react';
import type { StageDrawEntry } from '@/domain/draw/draw-stage';

/**
 * 抽選のルーレット演出。
 *
 * サーバーは「引く」操作を受けた瞬間に当たりを決めて記録する。
 * 投影画面はそれを受け取ってから、**見せるためだけに**候補を高速で切り替え、
 * 減速して当たりの上で止める。GAS 版の抽選アプリと同じ見え方にしている。
 *
 * 守っていること:
 * - サーバーはタイマーを持たない（Cloud Run は状態を持たない）。演出はここだけで完結する。
 * - **画面を開いた直後は回さない。** 進行中のルームへ後から繋いだとき、
 *   いきなりルーレットが回り出すと「今引いた」ように見えてしまう。
 * - 同じ結果で二度回さない。Snapshot を取り直しても回り直さない。
 * - 回していない間に出すものは**計算で決める**（状態に持たない）。
 *   持つと、取り消し・リセットのたびに画面と食い違う。
 */

/** 減速しきったと判断する間隔 (ms)。GAS 版と同じ挙動にそろえている。 */
const SLOWEST_INTERVAL_MS = 700;
/** 1 回ごとに間隔を伸ばす倍率。 */
const SLOWDOWN_RATE = 1.1;

/**
 * 回し始めてから完全に止まるまでのおおよその時間 (ms)。
 *
 * 回す時間そのものより、**そのあとの減速のほうが長い**。
 * 自動送りの間隔をここから決めないと、止まりきる前に次を回してしまい、
 * 結果を見せる間が無くなる。
 */
export function spinTotalMs(intervalMs: number, durationMs: number): number {
  let interval = Math.max(16, intervalMs);
  let total = durationMs;
  while (interval < SLOWEST_INTERVAL_MS) {
    interval *= SLOWDOWN_RATE;
    total += interval;
  }
  return Math.round(total);
}

export type DrawRouletteState = {
  /** 回している最中か。効果音の出し分けに使う。 */
  spinning: boolean;
  /** いま画面に出すもの。回している間は候補が次々に入れ替わる。 */
  display: StageDrawEntry | null;
};

export function useDrawRoulette(input: {
  /** 直近に引いたものの通し番号。増えたら回し始める。 */
  latestOrder: number | null;
  /** 確定した当たり。回し終わったらこれを出す。 */
  winner: StageDrawEntry | null;
  /** 回している間に見せる候補（まだ引いていないものを含む一覧）。 */
  candidates: readonly StageDrawEntry[];
  /** 切り替える間隔 (ms)。 */
  intervalMs: number;
  /** 回し続ける時間 (ms)。 */
  durationMs: number;
  /** 演出を動かしてよいか（投影開始の操作が済んでいるか）。 */
  enabled: boolean;
}): DrawRouletteState {
  const { latestOrder, winner, candidates, intervalMs, durationMs, enabled } = input;

  /** 回している間だけ入る。null なら止まっている。 */
  const [shownId, setShownId] = useState<string | null>(null);
  const spinning = shownId !== null;

  /**
   * タイマーから読む最新の入力。
   *
   * **この効果を先に宣言しておくこと。** 効果は宣言順に走るので、
   * 引いた直後（候補と当たりが同時に変わる）でも、
   * 下の演出の効果が読むときには新しい値になっている。
   */
  const latestRef = useRef({ candidates, winner });
  useEffect(() => {
    latestRef.current = { candidates, winner };
  });

  /** 演出を済ませた通し番号。同じ結果で二度回さない。 */
  const handledOrderRef = useRef<number | null>(null);
  /**
   * 一度でも状態を見たか。
   *
   * 「まだ 1 件も引いていない (null)」と「まだ何も見ていない」を区別する。
   * 分けないと、**最初の 1 件を引いたときに回らない**（実際にそうなった）。
   */
  const observedRef = useRef(false);

  useEffect(() => {
    const firstObservation = !observedRef.current;
    observedRef.current = true;

    const handled = handledOrderRef.current;
    handledOrderRef.current = latestOrder;

    if (latestOrder === null) {
      // まだ 1 件も引いていない。次に引いたときは演出する。
      return;
    }
    // 画面を開いた直後に見えた結果は「いま引いた」ではない。
    if (firstObservation) {
      return;
    }
    // 取り消し・リセットで戻った、または同じ結果を見ている。
    if (handled !== null && handled >= latestOrder) {
      return;
    }
    if (!enabled) {
      return;
    }

    // 候補が 1 つしか無ければ回す意味が無い（GAS 版も同じ扱い）。
    if (latestRef.current.candidates.length <= 1) {
      return;
    }

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let interval = Math.max(16, intervalMs);
    let lastId: string | null = null;
    const startedAt = Date.now();

    const step = () => {
      if (cancelled) {
        return;
      }
      const pool = latestRef.current.candidates;
      if (pool.length === 0) {
        setShownId(null);
        return;
      }

      // 同じものが 2 回続くと止まって見える。できるだけ別のものを出す。
      let index = Math.floor(Math.random() * pool.length);
      if (pool.length > 1) {
        let guard = 0;
        while (pool[index]?.id === lastId && guard < 8) {
          index = Math.floor(Math.random() * pool.length);
          guard += 1;
        }
      }
      lastId = pool[index]?.id ?? null;
      setShownId(lastId);

      const elapsed = Date.now() - startedAt;
      if (elapsed < durationMs) {
        timerId = setTimeout(step, interval);
        return;
      }
      if (interval < SLOWEST_INTERVAL_MS) {
        // 減速。だんだん間隔を伸ばして「止まりそう」に見せる。
        interval *= SLOWDOWN_RATE;
        timerId = setTimeout(step, interval);
        return;
      }
      // 止める。ここで初めて当たりが見える。
      setShownId(null);
    };

    timerId = setTimeout(step, interval);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      setShownId(null);
    };
  }, [durationMs, enabled, intervalMs, latestOrder]);

  const display = spinning ? (candidates.find((entry) => entry.id === shownId) ?? winner) : winner;

  return { spinning, display };
}
