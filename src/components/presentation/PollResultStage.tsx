'use client';

import { useCallback, useMemo } from 'react';
import { STAGE_FONT, rankAccentClassName, stageSize } from '@/components/presentation/stage-theme';
import type { ProjectorAudio } from '@/components/presentation/use-projector-audio';
import { fitFontSize } from '@/domain/draw/fit-text';
import { rankLabel } from '@/domain/poll/ballot';
import type { PollResult, PollStage } from '@/domain/poll/poll-stage';
import { usePollReveal } from '@/hooks/use-poll-reveal';
import { cn } from '@/lib/client/cn';

/**
 * 投票結果の発表。
 *
 * **下の順位から 1 つずつ**出す。1 位から出すと、そのあとを誰も見ない。
 *
 * 司会が「◯位を発表」を押すと 1 件増えた結果が届くが、そのまま出すと
 * 押した瞬間に答えが出て会場が沸かない。まず「◯位は…」だけを出して
 * ためる音を鳴らし、鳴り終わったところで中身を出す。
 *
 * **まだ出していない順位はそもそも届いていない**（サーバーが送らない）。
 * ここで隠しているのではないので、画面の中身を覗いても先は読めない。
 */

/**
 * 名前を収める幅（1920 基準の px）。
 *
 * 発表済みの一覧を右へ出している間はそのぶん狭い。
 * 実際の幅より広い値を渡すと、収まったつもりで折り返してしまう。
 */
const NAME_MAX_WIDTH_WITH_LIST = 1120;
const NAME_MAX_WIDTH_ALONE = 1720;
/** 発表済みの一覧に出す 1 件の文字の大きさ。 */
const PAST_FONT_SIZE = 52;
/** 一覧に並べる最大件数。あふれたら新しいものから残す。 */
const PAST_MAX_COUNT = 5;

export function PollResultStage({
  poll,
  result,
  audio,
}: {
  poll: PollStage;
  result: PollResult;
  audio: ProjectorAudio;
}) {
  const { play, startLoop, stopLoop, durationOf } = audio;

  const handleBuildUpStart = useCallback(() => {
    startLoop('poll-drumroll');
  }, [startLoop]);

  const handleReveal = useCallback(
    (rank: number) => {
      stopLoop('poll-drumroll');
      // 1 位だけは特別扱い。会場がいちばん沸くところなのでファンファーレにする。
      play(rank === 1 ? 'fanfare' : 'poll-result', `poll:${rank}`);
    },
    [play, stopLoop],
  );

  /** ためている間に見出しへ出す順位。届いている中でいちばん新しいもの。 */
  const nextRank = result.entries.at(-1)?.rank ?? 1;

  const { pendingRank, shownCount } = usePollReveal({
    revealedCount: result.entries.length,
    nextRank,
    buildUpSeconds: durationOf('poll-drumroll'),
    onBuildUpStart: handleBuildUpStart,
    onReveal: handleReveal,
  });

  /** 出してよい分だけ。ためている間は最後の 1 件を伏せる。 */
  const shown = useMemo(() => result.entries.slice(0, shownCount), [result.entries, shownCount]);
  const latest = shown.at(-1) ?? null;
  const past = shown.slice(0, -1).slice(-PAST_MAX_COUNT).reverse();

  const maxFontSize = poll.settings.resultFontSize;

  if (shown.length === 0 && pendingRank === null) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center">
        <p
          className="font-bold text-white/80"
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.2 }}
        >
          結果発表
        </p>
        <p
          className="text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.heading), marginTop: stageSize(24) }}
        >
          {poll.title}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center" style={{ gap: stageSize(56) }}>
      <div
        className="flex min-w-0 flex-1 flex-col items-center justify-center"
        style={{ gap: stageSize(24) }}
      >
        {pendingRank !== null ? (
          <>
            <p
              className="animate-pulse font-bold text-amber-200"
              style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.1 }}
            >
              {rankLabel(pendingRank)}は
            </p>
            <p
              className="text-white/60"
              style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.3 }}
            >
              ……
            </p>
          </>
        ) : latest !== null ? (
          <>
            <p
              className={cn(
                'inline-flex items-center rounded-full border-4 font-bold text-white',
                rankAccentClassName(latest.rank),
              )}
              style={{
                paddingInline: stageSize(40),
                paddingBlock: stageSize(10),
                fontSize: stageSize(STAGE_FONT.emphasis),
                lineHeight: 1.1,
              }}
            >
              {rankLabel(latest.rank)}
            </p>
            <p
              className="text-center font-bold break-words text-white"
              style={{
                fontSize: stageSize(
                  fitFontSize(latest.label, {
                    maxWidth: past.length > 0 ? NAME_MAX_WIDTH_WITH_LIST : NAME_MAX_WIDTH_ALONE,
                    maxFontSize,
                  }),
                ),
                lineHeight: 1.15,
              }}
            >
              {latest.label}
            </p>
            {latest.groupLabel !== null || latest.note !== null ? (
              <p
                className="text-center text-white/70"
                style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.3 }}
              >
                {[latest.groupLabel, latest.note].filter((value) => value !== null).join('／')}
              </p>
            ) : null}
            <p
              className="text-white/60 tabular-nums"
              style={{ fontSize: stageSize(STAGE_FONT.body) }}
            >
              {latest.score}点／{latest.totalVotes}票
            </p>
          </>
        ) : null}
      </div>

      {past.length > 0 ? (
        <div
          className="flex shrink-0 flex-col justify-center"
          style={{ gap: stageSize(14), width: stageSize(560) }}
        >
          <p
            className="font-bold text-white/50"
            style={{ fontSize: stageSize(STAGE_FONT.caption) }}
          >
            発表済み
          </p>
          {past.map((entry) => (
            <div
              key={entry.optionId}
              className={cn(
                'flex items-center rounded-2xl border-2 text-white',
                rankAccentClassName(entry.rank),
              )}
              style={{
                gap: stageSize(16),
                paddingInline: stageSize(20),
                paddingBlock: stageSize(10),
              }}
            >
              <span
                className="shrink-0 font-bold tabular-nums"
                style={{ fontSize: stageSize(PAST_FONT_SIZE) }}
              >
                {rankLabel(entry.rank)}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-bold"
                style={{ fontSize: stageSize(PAST_FONT_SIZE) }}
              >
                {entry.label}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
