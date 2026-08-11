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

  // 円環の描画。数字だけだと会場後方から「あとどれくらいか」が掴みにくいので、
  // 減っていく量そのものを面積で見せる。
  const RADIUS = 46;
  const circumference = 2 * Math.PI * RADIUS;

  return (
    <div className="flex items-center" style={{ gap: stageSize(28) }}>
      <div
        className="relative shrink-0"
        style={{ width: stageSize(200), height: stageSize(200) }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 110 110" className="h-full w-full -rotate-90">
          <circle cx="55" cy="55" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="10" />
          <circle
            cx="55"
            cy="55"
            r={RADIUS}
            fill="none"
            stroke={urgent ? '#fca5a5' : 'var(--color-brand-400)'}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - leftRatio)}
            // 秒ごとの更新でも滑らかに減らす。
            style={{ transition: 'stroke-dashoffset 200ms linear, stroke 300ms linear' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            aria-live="off"
            className={cn(
              'font-bold tabular-nums',
              urgent ? 'stage-urgent text-red-300' : 'text-white',
            )}
            style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1 }}
          >
            {seconds}
          </span>
        </div>
      </div>

      <div className="flex flex-col items-start" style={{ gap: stageSize(8) }}>
        <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
          残り秒数
        </span>
        <p
          className={cn('font-bold', urgent ? 'text-red-200' : 'text-white/50')}
          style={{ fontSize: stageSize(STAGE_FONT.caption) }}
        >
          {urgent ? 'まもなく締切です' : '回答を受け付けています'}
        </p>
      </div>
    </div>
  );
}
