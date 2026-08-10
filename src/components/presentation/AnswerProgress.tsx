'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { formatInteger, percent, safeRatio } from '@/lib/format';

/**
 * 回答済み人数と進捗率。
 *
 * 回答受付中に出してよいのは「何人が答えたか」だけ。
 * どの選択肢が何人か・どんな数値が来ているかは、締切まで絶対に表示しない。
 */
export function AnswerProgress({
  answeredCount,
  participantCount,
}: {
  answeredCount: number;
  participantCount: number;
}) {
  const ratio = safeRatio(answeredCount, participantCount);

  return (
    <div className="flex flex-col" style={{ gap: stageSize(10) }}>
      <div className="flex items-baseline" style={{ gap: stageSize(16) }}>
        <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
          回答済み
        </span>
        <span
          className="font-bold text-white tabular-nums"
          style={{ fontSize: stageSize(STAGE_FONT.emphasis), lineHeight: 1 }}
        >
          {formatInteger(answeredCount)}
        </span>
        <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
          / {formatInteger(participantCount)}人（{percent(ratio)}）
        </span>
      </div>

      <div
        className="overflow-hidden rounded-full bg-white/15"
        style={{ width: stageSize(560), height: stageSize(18) }}
      >
        <div
          className="h-full rounded-full bg-emerald-400"
          style={{ width: `${Math.min(1, ratio) * 100}%` }}
        />
      </div>
    </div>
  );
}
