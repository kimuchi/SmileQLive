'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DrawRecord } from '@/domain/draw/draw-list';
import type { StageDraw } from '@/domain/draw/draw-stage';
import { applyLocalDraw, pickLocalEntry } from '@/domain/draw/local-draw';
import { removesDrawnEntries, type RoomMode } from '@/domain/room/room-mode';
import { spinTotalMs } from '@/hooks/use-draw-roulette';

/**
 * デモの進行。
 *
 * サーバーの代わりにブラウザが引く。**何も送らないし、記録も残らない。**
 * 用意した抽選リストをそのまま使えるので、当日の画面を事前に見せられる。
 *
 * 本番のフェーズ（draw_ready / draw_spinning / draw_revealed）と
 * 同じ 3 つの状態を持つ。投影の描き分けを本番と共通にするため。
 */

/** 1 回終わってから次を回し始めるまで。会場の反応が入るくらいの間。 */
const AUTO_GAP_MS = 2000;
/** 自動のとき、ルーレットの「スタート」から「ストップ」までの間。 */
const AUTO_SPIN_MS = 1800;
/** 全部引き終わってから、最初へ戻すまでの間。 */
const AUTO_RESTART_MS = 4000;

export type LocalDrawPhase = 'ready' | 'spinning' | 'revealed';

export type LocalDraw = {
  /** 引いた記録を差し替えた抽選。デモ中でなければ null。 */
  draw: StageDraw | null;
  phase: LocalDrawPhase;
  auto: boolean;
  /** 引くものが残っていないか（ルーレットでは常に false）。 */
  exhausted: boolean;
  setAuto: (auto: boolean) => void;
  /** 1 件引いて結果を出す。ルーレットでは「ストップ」にあたる。 */
  drawNext: () => void;
  /** ルーレットの「スタート」。 */
  startSpin: () => void;
  /** 引いた記録を捨てて最初へ戻す。 */
  reset: () => void;
};

export function useLocalDraw(input: {
  /** 母集団と設定。本番の抽選リストをそのまま渡せる。 */
  pool: StageDraw | null;
  mode: RoomMode;
  /** デモ中か。false の間は何も持たない。 */
  active: boolean;
  /**
   * 母集団の見分け。
   *
   * これが変わったら引いた記録を捨てる（別のリストの記録を引き継がない）。
   * `pool` はレンダーのたびに作り直されることがあるので、
   * 物としての同一性ではなくこの鍵で判断する。
   */
  poolKey: string;
}): LocalDraw {
  const { pool, mode, active, poolKey } = input;

  const [drawn, setDrawn] = useState<DrawRecord[]>([]);
  const [phase, setPhase] = useState<LocalDrawPhase>('ready');
  const [autoState, setAutoState] = useState(false);

  /*
    母集団が変わったら記録を捨てる。

    「いつの分の記録か」を一緒に持ち、合わなくなったら空として扱う
    （効果を使わずレンダー中に判定できる）。
  */
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const currentKey = active ? poolKey : null;
  const owned = ownerKey === currentKey;

  /*
    デモを抜けたら記録を捨てる。

    捨てないと、同じルームでデモを入り直したときに**前回の続き**から始まる。
    props の変化に合わせて state を直す形（React が勧めている書き方）。
    効果でやると、1 フレームだけ古い記録が投影へ出る。
  */
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setOwnerKey(null);
      setDrawn([]);
      setPhase('ready');
      setAutoState(false);
    }
  }
  const effectiveDrawn = useMemo(() => (owned ? drawn : []), [drawn, owned]);
  const effectivePhase: LocalDrawPhase = owned ? phase : 'ready';
  // デモを抜けたら自動も止まる。戻ってきたときに勝手に回り出さない。
  const auto = owned && autoState;

  const draw = useMemo(
    () => (active && pool ? applyLocalDraw(pool, effectiveDrawn, mode) : null),
    [active, effectiveDrawn, mode, pool],
  );

  const exhausted = draw !== null && removesDrawnEntries(mode) && draw.remainingCount === 0;

  const drawNext = useCallback(() => {
    if (!pool) {
      return;
    }
    setOwnerKey(currentKey);
    setDrawn((records) => {
      const base = owned ? records : [];
      const picked = pickLocalEntry(pool, base, mode, Math.random);
      if (!picked) {
        return base;
      }
      return [...base, { order: base.length + 1, entryId: picked.id }];
    });
    setPhase('revealed');
  }, [currentKey, mode, owned, pool]);

  const startSpin = useCallback(() => {
    setOwnerKey(currentKey);
    setPhase('spinning');
  }, [currentKey]);

  const reset = useCallback(() => {
    setOwnerKey(currentKey);
    setDrawn([]);
    setPhase('ready');
  }, [currentKey]);

  const setAuto = useCallback(
    (next: boolean) => {
      setOwnerKey(currentKey);
      setAutoState(next);
    },
    [currentKey],
  );

  /*
    自動で回し続ける。

    「引く → 演出が終わる → 少し置いて次」を繰り返す。
    次の一手だけをタイマーで予約し、状態が動いたら予約を捨てる（二重に回さない）。
  */
  const stepRef = useRef({ drawNext, startSpin, reset });
  useEffect(() => {
    stepRef.current = { drawNext, startSpin, reset };
  });

  const isRoulette = !removesDrawnEntries(mode);
  const spinIntervalMs = draw?.settings.spinIntervalMs ?? 50;
  const spinDurationMs = draw?.settings.spinDurationMs ?? 2500;
  const stopDurationMs = draw?.settings.stopDurationMs ?? 4000;
  const drawnCount = effectiveDrawn.length;

  useEffect(() => {
    if (!auto || !active) {
      return;
    }

    let delay: number;
    let step: () => void;

    if (exhausted) {
      // 引き切ったら最初へ戻して、そのまま回し続ける。
      delay = AUTO_RESTART_MS;
      step = () => stepRef.current.reset();
    } else if (isRoulette && effectivePhase === 'spinning') {
      delay = AUTO_SPIN_MS;
      step = () => stepRef.current.drawNext();
    } else if (isRoulette) {
      // 止まってから次を回し始めるまで。減速にかかる時間も見込む。
      delay = effectivePhase === 'revealed' ? stopDurationMs + AUTO_GAP_MS : AUTO_GAP_MS;
      step = () => stepRef.current.startSpin();
    } else {
      /*
        回す時間そのものより、そのあとの減速のほうが長い。
        止まりきってから間を置くよう、合計から数える。
      */
      delay =
        effectivePhase === 'revealed'
          ? spinTotalMs(spinIntervalMs, spinDurationMs) + AUTO_GAP_MS
          : AUTO_GAP_MS;
      step = () => stepRef.current.drawNext();
    }

    const timer = window.setTimeout(step, delay);
    return () => {
      window.clearTimeout(timer);
    };
    // drawnCount を見ているのは、1 件引くごとに次を予約し直すため。
  }, [
    active,
    auto,
    drawnCount,
    effectivePhase,
    exhausted,
    isRoulette,
    spinDurationMs,
    spinIntervalMs,
    stopDurationMs,
  ]);

  return {
    draw,
    phase: effectivePhase,
    auto,
    exhausted,
    setAuto,
    drawNext,
    startSpin,
    reset,
  };
}
