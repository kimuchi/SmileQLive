'use client';

import { useEffect, useRef } from 'react';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import type { ProjectorAudio } from '@/components/presentation/use-projector-audio';
import type { PollStage } from '@/domain/poll/poll-stage';
import { QrCode } from '@/components/shared/QrCode';
import { formatInteger } from '@/lib/format';

/**
 * 投票の受付画面。
 *
 * 会場の全員がここから入るので、**二次元コードを進行中もずっと出す**。
 * 途中から来た人がその場で読めるようにするため。
 *
 * 出すのは「何票入ったか」だけ。**どれに何票入ったかは出さない**
 * （途中経過が見えると、あとの人の投票が引っぱられる）。
 * サーバーもそもそも票の内訳を投影へ送っていない。
 *
 * 票が増えたら短い音を鳴らす。会場へ「入った」と伝わると投票が進む。
 * 票数は取り直しのたびにまとめて増えるので、1 回の増加につき 1 回だけ鳴らす。
 */
export function PollVotingStage({
  poll,
  joinUrl,
  joinOpen,
  closed,
  audio,
}: {
  poll: PollStage;
  joinUrl: string | null;
  joinOpen: boolean;
  /** 締め切ったあと（結果発表の前）。 */
  closed: boolean;
  audio: ProjectorAudio;
}) {
  const rankDepth = poll.settings.rankDepth;
  const { play } = audio;

  /** 直前の票数。画面を開いた時点の数では鳴らさない。 */
  const lastVoteCountRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = lastVoteCountRef.current;
    lastVoteCountRef.current = poll.voteCount;
    if (previous === null || poll.voteCount <= previous || closed) {
      return;
    }
    play('poll-vote');
  }, [closed, play, poll.voteCount]);

  return (
    <div className="flex h-full w-full items-center" style={{ gap: stageSize(64) }}>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: stageSize(28) }}>
        <h1
          className="font-bold break-words text-white"
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.15 }}
        >
          {poll.title}
        </h1>

        {closed ? (
          <p
            className="font-bold text-amber-200"
            style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.3 }}
          >
            投票を締め切りました
          </p>
        ) : (
          <>
            <p
              className="text-brand-200 font-bold"
              style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.3 }}
            >
              二次元コードを読んで投票
            </p>
            <p
              className="text-white/70"
              style={{ fontSize: stageSize(STAGE_FONT.body), lineHeight: 1.5 }}
            >
              {rankDepth === 1
                ? 'いちばん良かったものを1つ選んでください。'
                : `良かった順に${rankDepth}つまで選べます。`}
              <br />
              1台につき1票です。アプリのインストールは不要です。
            </p>
          </>
        )}

        <div className="flex items-baseline" style={{ gap: stageSize(20) }}>
          <span
            className="font-bold text-white/60"
            style={{ fontSize: stageSize(STAGE_FONT.small) }}
          >
            投票
          </span>
          <span
            className="font-bold text-white tabular-nums"
            style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1 }}
          >
            {formatInteger(poll.voteCount)}
          </span>
          <span
            className="font-bold text-white/60"
            style={{ fontSize: stageSize(STAGE_FONT.small) }}
          >
            票
          </span>
          <span
            className="font-bold text-white/40"
            style={{ fontSize: stageSize(STAGE_FONT.small) }}
          >
            ／ 参加 {formatInteger(poll.participantCount)}人
          </span>
        </div>

        {!joinOpen && !closed ? (
          <p
            className="inline-flex w-fit items-center rounded-full border-2 border-amber-300/70 bg-amber-300/15 font-bold text-amber-100"
            style={{
              paddingInline: stageSize(28),
              paddingBlock: stageSize(12),
              fontSize: stageSize(STAGE_FONT.small),
            }}
          >
            現在、新しい参加を締め切っています
          </p>
        ) : null}
      </div>

      {/* 締め切ったあとは二次元コードを出さない（読んでも投票できない）。 */}
      {closed ? (
        <div
          className="flex shrink-0 flex-col items-center justify-center rounded-3xl border-4 border-white/20 bg-white/5"
          style={{ gap: stageSize(20), width: stageSize(680), height: stageSize(560) }}
        >
          <p
            className="font-bold text-white/80"
            style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.3 }}
          >
            集計中
          </p>
          <p className="text-white/60" style={{ fontSize: stageSize(STAGE_FONT.body) }}>
            まもなく結果を発表します
          </p>
        </div>
      ) : (
        <div
          className="flex shrink-0 flex-col items-center"
          style={{ gap: stageSize(20), width: stageSize(680) }}
        >
          {joinUrl ? (
            <QrCode
              // 参加 URL が変わったら、古いコードを DOM ごと作り直して残さない。
              key={joinUrl}
              value={joinUrl}
              size={640}
              title="投票用の二次元コード"
              className="w-full"
            />
          ) : (
            <p
              className="rounded-3xl border-4 border-dashed border-white/30 bg-white/5 text-center font-bold text-white/70"
              style={{ padding: stageSize(36), fontSize: stageSize(STAGE_FONT.body) }}
            >
              参加用の二次元コードがまだ設定されていません
            </p>
          )}
        </div>
      )}
    </div>
  );
}
