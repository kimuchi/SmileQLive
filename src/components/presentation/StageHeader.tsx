'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { ROOM_PHASE_LABELS, type RoomPhase } from '@/domain/room/state-machine';
import type { RoomChannelStatus } from '@/lib/client/realtime-status';
import { formatCount, formatQuestionProgress } from '@/lib/format';

/**
 * ステージ上部の帯。
 *
 * 会場の視線は中央へ向くため、ここは「今どこにいるか」だけを控えめに示す。
 * 通信が切れても画面は消さず、この帯に「再接続中」とだけ出して進行中の表示を残す。
 */
export function StageHeader({
  quizTitle,
  showTitle,
  phase,
  questionPosition,
  totalQuestions,
  showTotalQuestions,
  participantCount,
  showParticipants,
  status,
  stale,
}: {
  quizTitle: string;
  /**
   * 表題を出すか。
   *
   * 抽選会・ビンゴ・ルーレットでは出さない。
   * 会場のスクリーンにはいちばん見せたいもの（当選者・球）だけを出す。
   */
  showTitle: boolean;
  phase: RoomPhase;
  questionPosition: number | null;
  totalQuestions: number;
  /** 「/ 全n問」を出すか。 */
  showTotalQuestions: boolean;
  participantCount: number;
  /**
   * 参加人数を出すか。
   *
   * 抽選会・ビンゴ・ルーレットは参加者が入らない催しなので、
   * 出すと「参加 0人」とだけ書かれた帯になり、壊れているように見える。
   */
  showParticipants: boolean;
  status: RoomChannelStatus;
  /** 最新状態の取得に失敗している（表示は直前の状態のまま）。 */
  stale: boolean;
}) {
  const reconnecting = status !== 'connected' || stale;

  return (
    <header
      className="flex shrink-0 items-center justify-between text-white/70"
      style={{ fontSize: stageSize(STAGE_FONT.caption), gap: stageSize(24) }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: stageSize(20) }}>
        {showTitle ? <span className="truncate font-bold text-white/90">{quizTitle}</span> : null}
        {questionPosition !== null ? (
          <span className="shrink-0 whitespace-nowrap">
            {formatQuestionProgress(questionPosition, totalQuestions, {
              showTotal: showTotalQuestions,
            })}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center" style={{ gap: stageSize(20) }}>
        {reconnecting ? (
          <span
            role="status"
            aria-live="polite"
            className="inline-flex items-center rounded-full border border-amber-300/70 bg-amber-300/15 font-bold text-amber-100"
            style={{
              gap: stageSize(10),
              paddingInline: stageSize(20),
              paddingBlock: stageSize(8),
            }}
          >
            <span
              aria-hidden="true"
              className="inline-block rounded-full bg-amber-300"
              style={{ width: stageSize(14), height: stageSize(14) }}
            />
            再接続中
          </span>
        ) : null}

        <span className="whitespace-nowrap">{ROOM_PHASE_LABELS[phase]}</span>
        {showParticipants ? (
          <span className="font-bold whitespace-nowrap text-white/90">
            参加 {formatCount(participantCount)}
          </span>
        ) : null}
      </div>
    </header>
  );
}
