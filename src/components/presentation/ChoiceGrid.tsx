'use client';

import {
  STAGE_FONT,
  choiceCellClassName,
  choiceGridClassName,
  stageSize,
} from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import type { ChoiceBreakdown } from '@/domain/answer/answer-dto';
import type { PublicChoice } from '@/domain/quiz/public-question';
import { cn } from '@/lib/client/cn';
import { formatInteger, percent } from '@/lib/format';

/**
 * 選択肢グリッド。
 *
 * - 2→2列 / 3→3列 / 4→2x2 / 5→上段3・下段2（中央寄せ）。
 * - A〜E のラベル・枠線・アイコンを併用し、色だけで正解を示さない。
 * - `results` を渡すのは締切後だけ。回答受付中は選択肢別の人数を絶対に出さない。
 * - `correctChoiceId` は正解発表フェーズの Snapshot からしか渡らない。
 */

export type ChoiceGridProps = {
  choices: readonly PublicChoice[];
  /** 締切後の集計。受付中は null / 未指定にすること。 */
  results?: ChoiceBreakdown['choices'] | null;
  /** 正解発表後のみ。発表前は null。 */
  correctChoiceId?: string | null;
};

export function ChoiceGrid({ choices, results = null, correctChoiceId = null }: ChoiceGridProps) {
  const count = choices.length;
  const resultById = new Map(results?.map((entry) => [entry.choiceId, entry]) ?? []);
  const revealing = correctChoiceId !== null;

  return (
    <ul
      // stage-stagger: 選択肢を少しずつ遅らせて出す（出現順で視線を誘導する）。
      // key に count と revealing を含め、問題が変わったときと発表時に再生し直す。
      key={`${count}-${revealing}`}
      className={cn('stage-stagger grid w-full list-none', choiceGridClassName(count))}
      style={{ gap: stageSize(24) }}
    >
      {choices.map((choice, index) => {
        const result = resultById.get(choice.id) ?? null;
        const isCorrect = correctChoiceId !== null && choice.id === correctChoiceId;

        return (
          <li
            key={choice.id}
            className={cn(
              'flex flex-col border-4 transition-colors',
              choiceCellClassName(count, index),
              isCorrect
                ? // 正解は一度だけ弾ませ、発表の瞬間を見逃さないようにする。
                  'stage-pop border-emerald-300 bg-emerald-400/20 text-white shadow-[0_0_0_0.6cqw_rgba(16,185,129,0.25)]'
                : revealing
                  ? // 不正解は控えめにするが、会場から読める明るさは保つ。
                    'border-white/20 bg-white/5 text-white/80 opacity-70'
                  : 'border-white/30 bg-white/10 text-white',
            )}
            style={{
              borderRadius: stageSize(28),
              padding: stageSize(24),
              gap: stageSize(14),
            }}
          >
            <div className="flex items-center" style={{ gap: stageSize(18) }}>
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex shrink-0 items-center justify-center rounded-full font-bold',
                  isCorrect ? 'text-stage-950 bg-emerald-300' : 'text-stage-950 bg-white',
                )}
                style={{
                  width: stageSize(64),
                  height: stageSize(64),
                  fontSize: stageSize(STAGE_FONT.choice),
                }}
              >
                {choice.label}
              </span>
              {/* 読み上げ用（画面には上のバッジが見える） */}
              <span className="sr-only">選択肢 {choice.label}</span>

              {isCorrect ? (
                <span
                  className="text-stage-950 inline-flex items-center rounded-full bg-emerald-300 font-bold"
                  style={{
                    gap: stageSize(8),
                    paddingInline: stageSize(20),
                    paddingBlock: stageSize(6),
                    fontSize: stageSize(STAGE_FONT.small),
                  }}
                >
                  <span aria-hidden="true">✓</span>正解
                </span>
              ) : revealing ? (
                <span
                  className="inline-flex items-center rounded-full border border-white/30 font-bold text-white/70"
                  style={{
                    paddingInline: stageSize(20),
                    paddingBlock: stageSize(6),
                    fontSize: stageSize(STAGE_FONT.small),
                  }}
                >
                  不正解
                </span>
              ) : null}
            </div>

            {choice.text !== null && choice.text.length > 0 ? (
              <p
                className="font-bold break-words"
                style={{ fontSize: stageSize(STAGE_FONT.choice), lineHeight: 1.3 }}
              >
                {choice.text}
              </p>
            ) : null}

            {choice.image ? (
              <StageImage image={choice.image} maxHeightRatio={0.18} className="mx-0" />
            ) : null}

            {result ? (
              <div className="mt-auto flex flex-col" style={{ gap: stageSize(8) }}>
                <div className="flex items-baseline" style={{ gap: stageSize(12) }}>
                  <span
                    className="font-bold tabular-nums"
                    style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1 }}
                  >
                    {formatInteger(result.count)}
                  </span>
                  <span className="font-bold" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
                    人
                  </span>
                  <span
                    className="font-bold opacity-80"
                    style={{ fontSize: stageSize(STAGE_FONT.small) }}
                  >
                    {percent(result.ratio)}
                  </span>
                </div>
                <div
                  className="overflow-hidden rounded-full bg-white/15"
                  style={{ height: stageSize(16) }}
                >
                  <div
                    className={cn(
                      'h-full rounded-full',
                      isCorrect ? 'bg-emerald-300' : 'bg-white/50',
                    )}
                    style={{ width: `${Math.min(1, Math.max(0, result.ratio)) * 100}%` }}
                  />
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
