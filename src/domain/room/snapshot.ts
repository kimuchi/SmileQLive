import type { AnswerBreakdown, MyAnswer, RevealInfo } from '@/domain/answer/answer-dto';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import type { RankedParticipant } from '@/domain/room/scoring';
import type { RoomAction, RoomPhase } from '@/domain/room/state-machine';

/**
 * Snapshot は「現在状態の唯一の復元手段」。
 * Realtime イベントの欠落・再接続時は必ずこれを取得し直す。
 */

export type SnapshotBase = {
  roomId: string;
  quizTitle: string;
  phase: RoomPhase;
  stateVersion: number;
  /** ISO8601。クライアント時計の補正に使う。 */
  serverTime: string;
  currentQuestion: PublicQuestion | null;
  currentQuestionPosition: number | null;
  totalQuestions: number;
  answerDeadlineAt: string | null;
  showLeaderboard: boolean;
};

/** 参加者向け Snapshot。正解情報は phase が answer_revealed 以降のときだけ含まれる。 */
export type ParticipantSnapshot = SnapshotBase & {
  audience: 'participant';
  participant: {
    participantId: string;
    nickname: string;
  };
  participantCount: number;
  /** 現在問題に対する自分の回答（未回答なら null）。 */
  myAnswer: MyAnswer | null;
  /** 正解発表後のみ。 */
  reveal: RevealInfo | null;
  myResult: {
    isCorrect: boolean;
    pointsAwarded: number;
    totalPoints: number;
    rank: number | null;
  } | null;
  /** scoreboard フェーズのみ。 */
  leaderboard: RankedParticipant[] | null;
  joinOpen: boolean;
};

/** 投影・司会向け Snapshot。 */
export type StaffSnapshot = SnapshotBase & {
  audience: 'presenter' | 'host';
  participantCount: number;
  onlineCount: number;
  answeredCount: number;
  joinOpen: boolean;
  /** 締切後のみ。回答受付中は null。 */
  breakdown: AnswerBreakdown | null;
  reveal: RevealInfo | null;
  leaderboard: RankedParticipant[] | null;
  /** 次に実行可能な操作（司会画面のボタン制御）。 */
  availableActions: RoomAction[];
  /** 事前読込対象の画像 URL。 */
  preloadImageUrls: string[];
  /** 司会のみ: 参加 URL（投影担当には返さない）。 */
  joinUrl?: string | null;
  /** 司会のみ: 参加者一覧。 */
  participants?: Array<{
    participantId: string;
    nickname: string;
    isActive: boolean;
    joinedAt: string;
  }>;
};

export type RoomSnapshot = ParticipantSnapshot | StaffSnapshot;

export function isStaffSnapshot(snapshot: RoomSnapshot): snapshot is StaffSnapshot {
  return snapshot.audience === 'host' || snapshot.audience === 'presenter';
}
