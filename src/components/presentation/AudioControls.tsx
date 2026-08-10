'use client';

import type { ChangeEvent } from 'react';
import { cn } from '@/lib/client/cn';

/**
 * 画面隅の音量・全画面の操作。
 *
 * 投影中は目立たせない（普段は半透明、操作しようとしたときだけはっきり見せる）。
 * ただし操作者が暗い会場で押せるよう、当たり判定は 44px 以上を確保する。
 *
 * ここは 16:9 のステージ外に置くため、寸法は cqw ではなく通常の単位で指定する。
 */
export function AudioControls({
  isUnlocked,
  muted,
  volume,
  warning,
  isFullscreen,
  onEnable,
  onToggleMute,
  onVolumeChange,
  onToggleFullscreen,
}: {
  isUnlocked: boolean;
  muted: boolean;
  volume: number;
  warning: string | null;
  isFullscreen: boolean;
  /** クリックイベント内で効果音を有効にする。 */
  onEnable: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
}) {
  const handleVolume = (event: ChangeEvent<HTMLInputElement>) => {
    onVolumeChange(Number(event.target.value) / 100);
  };

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex flex-col items-end gap-2">
      {warning !== null ? (
        <p
          role="status"
          className="bg-stage-950/90 pointer-events-auto max-w-sm rounded-lg border border-amber-300/60 px-3 py-2 text-xs font-bold text-amber-100"
        >
          {warning}
        </p>
      ) : null}

      <div
        className={cn(
          'bg-stage-950/80 pointer-events-auto flex items-center gap-2 rounded-full border border-white/20 px-3 py-2',
          'opacity-35 transition-opacity duration-200 focus-within:opacity-100 hover:opacity-100',
        )}
      >
        {isUnlocked ? (
          <>
            <button
              type="button"
              onClick={onToggleMute}
              aria-pressed={muted}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 text-sm font-bold text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <span aria-hidden="true">{muted ? '🔇' : '🔊'}</span>
              <span className="sr-only">{muted ? 'ミュートを解除' : 'ミュートにする'}</span>
            </button>

            <label className="flex items-center gap-2 pr-1 text-xs font-bold text-white/70">
              <span className="sr-only">効果音の音量</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(volume * 100)}
                onChange={handleVolume}
                aria-label="効果音の音量"
                className="accent-brand-400 h-11 w-28"
              />
              <span className="w-10 text-right tabular-nums">{Math.round(volume * 100)}%</span>
            </label>
          </>
        ) : (
          <button
            type="button"
            onClick={onEnable}
            className="text-stage-950 inline-flex min-h-11 items-center justify-center rounded-full bg-white px-4 text-sm font-bold hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            効果音を有効にする
          </button>
        )}

        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-pressed={isFullscreen}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 text-sm font-bold text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <span aria-hidden="true">{isFullscreen ? '⤢' : '⛶'}</span>
          <span className="sr-only">{isFullscreen ? '全画面をやめる' : '全画面にする'}</span>
        </button>
      </div>
    </div>
  );
}
