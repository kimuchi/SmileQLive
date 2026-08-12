import type {
  AnswerBreakdown,
  MyAnswer,
  SubmitAnswerResult,
} from '@/domain/answer/answer-dto';
import type { PublishIssue } from '@/domain/quiz/publish-validation';
import type { ParticipantSnapshot, StaffSnapshot } from '@/domain/room/snapshot';
import type { RankedParticipant } from '@/domain/room/scoring';
import type { QuestionType } from '@/domain/quiz/question';
import type { RoomPhase } from '@/domain/room/state-machine';

/**
 * HTTP API のレスポンス契約。
 * サーバー（Route Handler）とクライアント（画面）の双方がこの型を import する。
 */

// ---------------------------------------------------------------------------
// 管理: クイズ
// ---------------------------------------------------------------------------

export type QuizListItem = {
  id: string;
  title: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  questionCount: number;
  choiceQuestionCount: number;
  numberQuestionCount: number;
  showLeaderboard: boolean;
  createdAt: string;
  updatedAt: string;
  /** 自分が所有者か。false は共有されているクイズ（編集できない）。 */
  owned: boolean;
};

/** 共有相手。 */
export type QuizShareTarget = {
  uid: string;
  email: string | null;
  displayName: string | null;
};

export type QuizShareResponse = { shares: QuizShareTarget[] };

export type QuizListResponse = { quizzes: QuizListItem[] };

export type AdminMediaRef = {
  assetId: string;
  url: string;
  alt: string;
  width: number;
  height: number;
};

export type AdminChoice = {
  id: string;
  position: number;
  text: string | null;
  image: AdminMediaRef | null;
  isCorrect: boolean;
};

export type AdminQuestion = {
  id: string;
  position: number;
  type: QuestionType;
  text: string | null;
  image: AdminMediaRef | null;
  revealImage: AdminMediaRef | null;
  explanation: string | null;
  timeLimitSeconds: number;
  points: number;
  choices: AdminChoice[];
  numberMode: 'exact' | 'absolute_tolerance' | 'range' | null;
  numberCorrectValue: string | null;
  numberTolerance: string | null;
  numberMinValue: string | null;
  numberMaxValue: string | null;
  unit: string | null;
  decimalPlaces: number;
};

export type AdminQuizDetail = {
  id: string;
  title: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  showLeaderboard: boolean;
  /** 「/ 全n問」を出すか。 */
  showTotalQuestions: boolean;
  /** 回答受付を開始する前に問題を見せるか。 */
  showQuestionBeforeOpen: boolean;
  soundTheme: string;
  updatedAt: string;
  questions: AdminQuestion[];
  /**
   * 閲覧者が所有者か。
   * false は共有されたクイズで、編集・削除・公開・共有設定はできない。
   * リポジトリは閲覧者を知らないため、サービス層で埋める。
   */
  owned?: boolean;
};

export type QuizDetailResponse = { quiz: AdminQuizDetail };
export type QuestionResponse = { question: AdminQuestion };
export type PublishResponse = { published: boolean; issues: PublishIssue[] };

export type MediaUploadResponse = {
  asset: { id: string; url: string; width: number; height: number; byteSize: number };
};

// ---------------------------------------------------------------------------
// ルーム・司会
// ---------------------------------------------------------------------------

export type CreateRoomResponse = {
  roomId: string;
  /** 平文の参加 URL。ここでしか返らない（DB にはハッシュのみ保存）。 */
  joinUrl: string;
  joinToken: string;
  quizTitle: string;
};

export type RotateJoinTokenResponse = {
  joinUrl: string;
  joinToken: string;
  rotatedAt: string;
};

export type PresentationLinkResponse = {
  presentationUrl: string;
  expiresAt: string;
};

export type RoomActionResponse = {
  phase: RoomPhase;
  stateVersion: number;
  serverTime: string;
};

export type HostSnapshotResponse = { snapshot: StaffSnapshot };
export type StaffSnapshotResponse = { snapshot: StaffSnapshot };

export type RoomListItem = {
  id: string;
  quizTitle: string;
  phase: RoomPhase;
  participantCount: number;
  createdAt: string;
  finishedAt: string | null;
};

export type RoomListResponse = { rooms: RoomListItem[] };

// ---------------------------------------------------------------------------
// 参加
// ---------------------------------------------------------------------------

export type JoinResolveResponse = {
  roomId: string;
  quizTitle: string;
  joinOpen: boolean;
  participantCount: number;
  maxParticipants: number;
  /** すでに参加済みなら nickname が入る（再訪時にニックネーム入力を省く）。 */
  alreadyJoinedNickname: string | null;
  captchaRequired: boolean;
};

export type JoinRegisterResponse = {
  roomId: string;
  participantId: string;
  nickname: string;
};

export type ParticipantSnapshotResponse = { snapshot: ParticipantSnapshot };

export type SubmitAnswerResponse = SubmitAnswerResult;

export type MyResultResponse = {
  questionId: string | null;
  myAnswer: MyAnswer | null;
  isCorrect: boolean | null;
  pointsAwarded: number | null;
  totalPoints: number;
  rank: number | null;
  participantCount: number;
};

// ---------------------------------------------------------------------------
// 集計（司会・投影）
// ---------------------------------------------------------------------------

export type BreakdownResponse = { breakdown: AnswerBreakdown | null };
export type LeaderboardResponse = { leaderboard: RankedParticipant[] };

// ---------------------------------------------------------------------------
// 診断
// ---------------------------------------------------------------------------

export type DiagnosticsResponse = {
  status: 'ok' | 'degraded';
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  environment: string;
  appBaseUrl: string;
};
