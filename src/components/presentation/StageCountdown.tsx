'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { cn } from '@/lib/client/cn';
import { TICK_SECONDS } from '@/domain/room/timer';

/**
 * 残り時間の表示。
 *
 * - 表示するのはローカル補正した見込み時間。締切の判定はサーバー / DB が行う。
 * - 残り 5 秒からは数字を大きく・赤くし、同時に「まもなく締切」と文字でも伝える
 *   （色だけに頼らない）。
 */

/** 残りが少ないと判断する秒数（効果音 tick と同じ基準）。 */
const URGENT_SECONDS = Math.max(...TICK_SECONDS);

export function StageCountdown({
  remainingSeconds,
  remainingMs,
  timeLimitSeconds,
}: {
  remainingSeconds: number;
  remainingMs: number;
  timeLimitSeconds: number;
}) {
  const totalMs = Math.max(1, timeLimitSeconds * 1000);
  const leftRatio = Math.min(1, Math.max(0, remainingMs / totalMs));
  const seconds = Math.max(0, remainingSeconds);
  const urgent = seconds <= URGENT_SECONDS;

  return (
    <div className="flex flex-col items-end" style={{ gap: stageSize(10) }}>
      <div className="flex items-baseline" style={{ gap: stageSize(12) }}>
        <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
          残り
        </span>
        <span
          aria-live="off"
          className={cn('font-bold tabular-nums', urgent ? 'text-red-300' : 'text-white')}
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1 }}
        >
          {seconds}
        </span>
        <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
          秒
        </span>
      </div>

      <div
        className="overflow-hidden rounded-full bg-white/15"
        style={{ width: stageSize(560), height: stageSize(18) }}
      >
        <div
          className={cn('h-full rounded-full', urgent ? 'bg-red-400' : 'bg-brand-400')}
          style={{ width: `${leftRatio * 100}%` }}
        />
      </div>

      <p
        className={cn('font-bold', urgent ? 'text-red-200' : 'text-white/50')}
        style={{ fontSize: stageSize(STAGE_FONT.caption) }}
      >
        {urgent ? 'まもなく締切です' : '回答を受け付けています'}
      </p>
    </div>
  );
}
