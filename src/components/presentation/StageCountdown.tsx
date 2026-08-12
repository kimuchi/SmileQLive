'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { cn } from '@/lib/client/cn';
import { URGENT_SECONDS } from '@/domain/room/timer';

/**
 * 残り時間の表示。
 *
 * - 表示するのはローカル補正した見込み時間。締切の判定はサーバー / DB が行う。
 * - 残り 5 秒からは数字を大きく・赤くし、同時に「まもなく締切」と文字でも伝える
 *   （色だけに頼らない）。
 */

/** 円の中へ収まる字の大きさ。桁が増えるほど小さくする。 */
function numberFontSize(seconds: number): number {
  const digits = String(seconds).length;
  if (digits >= 4) {
    return STAGE_FONT.body;
  }
  if (digits === 3) {
    return STAGE_FONT.heading;
  }
  return STAGE_FONT.emphasis;
}

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

  // 制限時間は最大 180 秒、延長するとさらに増えるため 3 桁以上になる。
  // 桁数に合わせて字を小さくしないと、数字が円からはみ出して隣の文字と重なる。
  const secondsFontSize = numberFontSize(seconds);

  // 円環の描画。数字だけだと会場後方から「あとどれくらいか」が掴みにくいので、
  // 減っていく量そのものを面積で見せる。
  const RADIUS = 46;
  const circumference = 2 * Math.PI * RADIUS;

  return (
    <div className="flex shrink-0 items-center" style={{ gap: stageSize(24) }}>
      {/*
        円環は問題文・画像・選択肢と高さを取り合う。
        後方から読める大きさを保ちつつ、本体の表示領域を圧迫しない寸法にしている。
      */}
      <div
        className="relative shrink-0"
        style={{ width: stageSize(156), height: stageSize(156) }}
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
            style={{ fontSize: stageSize(secondsFontSize), lineHeight: 1 }}
          >
            {seconds}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-col items-start" style={{ gap: stageSize(8) }}>
        <span
          className="font-bold whitespace-nowrap text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.small) }}
        >
          残り秒数
        </span>
        <p
          className={cn('font-bold whitespace-nowrap', urgent ? 'text-red-200' : 'text-white/50')}
          style={{ fontSize: stageSize(STAGE_FONT.caption) }}
        >
          {urgent ? 'まもなく締切です' : '回答を受け付けています'}
        </p>
      </div>
    </div>
  );
}
