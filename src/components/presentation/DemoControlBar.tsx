'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/client/cn';

/**
 * デモの操作帯。
 *
 * 投影の下へ固定で置く。投影の 16:9 はこの高さぶん縮めるので、盤面へは重ならない
 * （`StageFrame` の `bottomInset`）。
 *
 * 折り返さず横スクロールさせる。折り返すと高さが変わり、
 * 縮めた投影と食い違って盤面の最後の行が隠れる。
 */

/** 操作の帯の高さ (px)。`StageFrame` へ渡す値と同じにすること。 */
export const CONTROL_BAR_HEIGHT = 64;

export function DemoControlBar({
  isRoulette,
  spinning,
  exhausted,
  auto,
  onDrawNext,
  onStartSpin,
  onReset,
  onToggleAuto,
  leading,
  trailing,
}: {
  isRoulette: boolean;
  /** 回している最中か。ルーレットの「ストップ」はこのとき押す。 */
  spinning: boolean;
  exhausted: boolean;
  auto: boolean;
  onDrawNext: () => void;
  onStartSpin: () => void;
  onReset: () => void;
  onToggleAuto: () => void;
  /** 帯の左側へ足すもの（モード切替など）。 */
  leading?: ReactNode;
  /** 帯の右側へ足すもの（全画面・終了など）。 */
  trailing?: ReactNode;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] flex flex-nowrap items-center gap-2 overflow-x-auto bg-black/70 px-3 text-sm"
      style={{ height: CONTROL_BAR_HEIGHT }}
    >
      <span className="shrink-0 rounded-md bg-amber-300 px-2 py-1 text-xs font-bold text-black">
        デモ
      </span>

      {leading}

      <span className="mx-1 h-6 w-px shrink-0 bg-white/20" aria-hidden="true" />

      {isRoulette && !spinning ? (
        <button
          type="button"
          onClick={onStartSpin}
          className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-300 px-4 py-2 font-bold text-black"
        >
          スタート
        </button>
      ) : (
        <button
          type="button"
          onClick={onDrawNext}
          /*
            ルーレットの「ストップ」は回っている最中にこそ押す。
            回している間を塞ぐと、永久に止められなくなる。
          */
          disabled={isRoulette ? false : spinning || exhausted}
          className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-300 px-4 py-2 font-bold text-black disabled:opacity-40"
        >
          {isRoulette ? 'ストップ' : '1つ引く'}
        </button>
      )}

      <button
        type="button"
        onClick={onToggleAuto}
        className={cn(
          'shrink-0 rounded-lg border px-4 py-2 font-bold',
          auto ? 'border-amber-300 bg-amber-300 text-black' : 'border-white/30 text-white/80',
        )}
      >
        {auto ? '自動を止める' : '自動で回す'}
      </button>

      <button
        type="button"
        onClick={onReset}
        className="shrink-0 rounded-lg border border-white/30 px-4 py-2 font-bold text-white/80"
      >
        最初から
      </button>

      {trailing !== undefined ? (
        <span className="ml-auto flex shrink-0 items-center gap-2">{trailing}</span>
      ) : null}
    </div>
  );
}
