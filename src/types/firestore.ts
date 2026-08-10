import type { Timestamp } from 'firebase-admin/firestore';
import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import type { QuestionType } from '@/domain/quiz/question';
import type { RoomPhase } from '@/domain/room/state-machine';

/**
 * Firestore ドキュメントの型定義。
 *
 * 重要な約束:
 * - **数値回答は必ず文字列で保存する**（Firestore の number は倍精度浮動小数点のため）。
 *   `numberRaw`（参加者の生入力）と `numberNormalized`（正規化後）を両方持つ。
 * - `rooms/{roomId}` は正解を含むため参加者へ読ませない。
 *   公開してよい状態だけを `rooms/{roomId}/public/state` へ複製する。
 * - 時刻は Timestamp。締切判定はサーバー時刻で行い、クライアント時刻を信用しない。
 */

export type FirestoreTimestamp = Timestamp;

// ---------------------------------------------------------------------------
// コレクション名（文字列の散在を防ぐ）
// ---------------------------------------------------------------------------
export const COLLECTIONS = {
  profiles: 'profiles',
  quizzes: 'quizzes',
  questions: 'questions',
  mediaAssets: 'mediaAssets',
  rooms: 'rooms',
  members: 'members',
  answers: 'answers',
  events: 'events',
  presentationLinks: 'presentationLinks',
} as const;

/** `rooms/{roomId}/public/state` — 参加者が購読する唯一のドキュメント。 */
export const PUBLIC_STATE_DOC = 'public/state';
/** `rooms/{roomId}/staff/progress` — 司会・投影のみ。 */
export const STAFF_PROGRESS_DOC = 'staff/progress';

/** 回答ドキュメントの決定的 ID。UNIQUE 制約の代わりになる。 */
export function answerDocId(questionId: string, participantId: string): string {
  return `${questionId}__${participantId}`;
}

// ---------------------------------------------------------------------------
// ドキュメント
// ---------------------------------------------------------------------------

export type ProfileDoc = {
  uid: string;
  email: string | null;
  displayName: string | null;
  /** Google Workspace のホストドメイン (hd クレーム)。 */
  hostedDomain: string | null;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
};

export type MediaAssetDoc = {
  id: string;
  ownerId: string;
  bucket: string;
  objectPath: string;
  mimeType: 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  createdAt: FirestoreTimestamp;
};

export type QuizStatus = 'draft' | 'published' | 'archived';

export type QuizDoc = {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  status: QuizStatus;
  showLeaderboard: boolean;
  soundTheme: string;
  questionCount: number;
  choiceQuestionCount: number;
  numberQuestionCount: number;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
};

/** 選択肢は最大 5 件なので問題ドキュメントへ埋め込む（1 問の更新が原子的になる）。 */
export type ChoiceEmbedded = {
  id: string;
  position: number;
  text: string | null;
  imageAssetId: string | null;
  imageAlt: string | null;
  isCorrect: boolean;
};

export type NumberJudgementMode = 'exact' | 'absolute_tolerance' | 'range';

export type QuestionDoc = {
  id: string;
  quizId: string;
  ownerId: string;
  position: number;
  questionType: QuestionType;
  questionText: string | null;
  questionImageAssetId: string | null;
  questionImageAlt: string | null;
  revealImageAssetId: string | null;
  revealImageAlt: string | null;
  explanation: string | null;
  timeLimitSeconds: number;
  points: number;

  /** 選択式のみ。数値式では空配列。 */
  choices: ChoiceEmbedded[];

  /** 数値式のみ。選択式では null。すべて文字列で保持する。 */
  numberMode: NumberJudgementMode | null;
  numberCorrectValue: string | null;
  numberTolerance: string | null;
  numberMinValue: string | null;
  numberMaxValue: string | null;
  numberUnit: string | null;
  numberDecimalPlaces: number;

  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
};

/** 正解を含む。参加者へ読ませない（Security Rules で所有者のみ）。 */
export type RoomDoc = {
  id: string;
  ownerId: string;
  quizId: string;
  joinTokenHash: string;
  joinTokenRotatedAt: FirestoreTimestamp;
  phase: RoomPhase;
  quizSnapshot: QuizSnapshot;
  currentQuestionId: string | null;
  currentQuestionPosition: number | null;
  phaseStartedAt: FirestoreTimestamp | null;
  answerDeadlineAt: FirestoreTimestamp | null;
  stateVersion: number;
  joinOpen: boolean;
  maxParticipants: number;
  participantCount: number;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
  finishedAt: FirestoreTimestamp | null;
};

/**
 * `rooms/{roomId}/public/state`
 *
 * 参加者・投影担当が onSnapshot で購読する。
 * **正解情報・問題文・選択肢を絶対に含めない。**
 * 「状態が変わった」ことだけを伝え、実データは Snapshot API から取り直す。
 */
export type RoomPublicStateDoc = {
  roomId: string;
  phase: RoomPhase;
  stateVersion: number;
  currentQuestionId: string | null;
  currentQuestionPosition: number | null;
  totalQuestions: number;
  answerDeadlineAt: FirestoreTimestamp | null;
  joinOpen: boolean;
  participantCount: number;
  /** 回答受付中も出してよい「合計回答数」だけ。内訳は含めない。 */
  answeredCount: number;
  updatedAt: FirestoreTimestamp;
};

/** `rooms/{roomId}/staff/progress` — 司会・投影のみ。 */
export type RoomStaffProgressDoc = {
  roomId: string;
  stateVersion: number;
  participantCount: number;
  onlineCount: number;
  answeredCount: number;
  /** 締切後のみ。回答受付中は null。 */
  breakdown: unknown | null;
  updatedAt: FirestoreTimestamp;
};

export type RoomMemberRole = 'host' | 'presenter' | 'participant';

export type RoomMemberDoc = {
  id: string;
  roomId: string;
  authUserId: string;
  role: RoomMemberRole;
  nickname: string | null;
  /** 重複判定用に小文字化したニックネーム。 */
  nicknameLower: string | null;
  joinedAt: FirestoreTimestamp;
  lastSeenAt: FirestoreTimestamp;
  isActive: boolean;
  /** ランキング算出のため回答と同じトランザクションで加算する。 */
  totalPoints: number;
  correctCount: number;
  correctElapsedMsTotal: number;
};

export type AnswerDoc = {
  id: string;
  roomId: string;
  questionId: string;
  participantId: string;
  nickname: string | null;
  answerType: QuestionType;
  choiceId: string | null;
  /** 参加者の生入力。本人の結果画面にだけ表示する。 */
  numberRaw: string | null;
  /** 正規化後の数値（文字列）。集計・判定はこちらを使う。 */
  numberNormalized: string | null;
  answeredAt: FirestoreTimestamp;
  elapsedMs: number;
  isCorrect: boolean;
  pointsAwarded: number;
};

export type RoomEventDoc = {
  roomId: string;
  stateVersion: number;
  eventType: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  createdAt: FirestoreTimestamp;
};

export type PresentationLinkDoc = {
  id: string;
  roomId: string;
  tokenHash: string;
  expiresAt: FirestoreTimestamp;
  consumedAt: FirestoreTimestamp | null;
  createdBy: string;
  createdAt: FirestoreTimestamp;
};
