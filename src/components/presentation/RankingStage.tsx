'use client';

import { STAGE_FONT, rankAccentClassName, stageSize } from '@/components/presentation/stage-theme';
import type { RankedParticipant } from '@/domain/room/scoring';
import { cn } from '@/lib/client/cn';
import { formatCount, formatInteger, formatPoints } from '@/lib/format';

/**
 * ランキングの投影。
 *
 * - 上位 10 名まで（参加者が少なければ全員）。ニックネーム・得点・順位だけを出す。
 * - 参加者 ID や回答内容は出さない。
 * - ランキングを表示しない設定のクイズでは、順位を推測できる情報も出さない。
 */

/** 投影に載せる最大人数。 */
const MAX_VISIBLE = 10;
/** これを超えたら 2 段組みにする。 */
const TWO_COLUMN_THRESHOLD = 5;

export function RankingStage({
  leaderboard,
  showLeaderboard,
  participantCount,
  finished,
}: {
  leaderboard: readonly RankedParticipant[] | null;
  showLeaderboard: boolean;
  participantCount: number;
  /** クイズ終了フェーズかどうか。 */
  finished: boolean;
}) {
  const entries = (leaderboard ?? []).slice(0, MAX_VISIBLE);
  const title = finished ? 'クイズは終了しました' : 'ランキング';

  const columns: RankedParticipant[][] =
    entries.length > TWO_COLUMN_THRESHOLD
      ? [
          entries.slice(0, Math.ceil(entries.length / 2)),
          entries.slice(Math.ceil(entries.length / 2)),
        ]
      : [entries];

  return (
    <div className="flex h-full w-full flex-col" style={{ gap: stageSize(28) }}>
      <div className="flex shrink-0 items-baseline justify-between" style={{ gap: stageSize(24) }}>
        <h1
          className="font-bold text-white"
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.1 }}
        >
          {title}
        </h1>
        <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
          参加 {formatCount(participantCount)}
        </span>
      </div>

      {!showLeaderboard ? (
        <p
          className="flex flex-1 items-center justify-center text-center font-bold text-white/70"
          style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.4 }}
        >
          このクイズではランキングを表示しません
        </p>
      ) : entries.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center text-center font-bold text-white/70"
          style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.4 }}
        >
          まだ得点がありません
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 items-start" style={{ gap: stageSize(32) }}>
          {columns.map((column, columnIndex) => (
            <ol
              key={columnIndex}
              className="flex min-w-0 flex-1 list-none flex-col"
              style={{ gap: stageSize(16) }}
            >
              {column.map((entry) => (
                <li
                  key={entry.participantId}
                  className={cn(
                    'flex items-center border-4 text-white',
                    rankAccentClassName(entry.rank),
                  )}
                  style={{
                    borderRadius: stageSize(24),
                    padding: stageSize(20),
                    gap: stageSize(24),
                  }}
                >
                  <span
                    className="shrink-0 text-center font-bold tabular-nums"
                    style={{ width: stageSize(120), fontSize: stageSize(STAGE_FONT.heading) }}
                  >
                    {formatInteger(entry.rank)}
                    <span style={{ fontSize: stageSize(STAGE_FONT.caption) }}>位</span>
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-bold"
                    style={{ fontSize: stageSize(STAGE_FONT.choice) }}
                  >
                    {entry.nickname}
                  </span>
                  <span
                    className="shrink-0 font-bold tabular-nums"
                    style={{ fontSize: stageSize(STAGE_FONT.choice) }}
                  >
                    {formatPoints(entry.totalPoints)}
                  </span>
                </li>
              ))}
            </ol>
          ))}
        </div>
      )}

      {finished ? (
        <p
          className="text-brand-200 shrink-0 text-center font-bold"
          style={{ fontSize: stageSize(STAGE_FONT.heading) }}
        >
          ご参加ありがとうございました
        </p>
      ) : null}
    </div>
  );
}
