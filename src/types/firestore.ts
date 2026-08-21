import type { Timestamp } from 'firebase-admin/firestore';
import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import type {
  DrawListKind,
  DrawRecord,
  DrawSettings,
  DrawSnapshot,
} from '@/domain/draw/draw-list';
import type { RoomMode } from '@/domain/room/room-mode';
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
  drawLists: 'drawLists',
  drawEntries: 'entries',
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
  /**
   * 閲覧・利用を許可した司会者の uid。
   *
   * 共有された側は「見る」「ルームを作る」ができるが、**編集・削除・共有はできない**。
   * 所有者を 1 人に保つことで、同じクイズを同時に編集して壊す事故を避ける。
   * 未設定（古いドキュメント）は共有なしとして扱う。
   */
  sharedWith?: string[];
  title: string;
  description: string | null;
  status: QuizStatus;
  showLeaderboard: boolean;
  /**
   * 投影・参加者画面へ「/ 全n問」を出すか。
   * 未設定（古いドキュメント）は出す扱い。
   */
  showTotalQuestions?: boolean;
  /**
   * 回答受付を開始する前に問題を見せるか。
   *
   * 既定は false（受付開始と同時に出す）。会場では「第3問！」で一度ためてから
   * 出すほうが盛り上がるため。true にすると、先に問題を読ませてから受け付けられる。
   */
  showQuestionBeforeOpen?: boolean;
  /**
   * 参加用の二次元コードを、開始前だけでなく**ずっと**投影の隅に出すか。
   *
   * 途中から来た人がその場で入れるようになる。
   * 既定は false（開始前の待機画面にだけ大きく出す）。
   * 未設定（古いドキュメント）は false 扱い。
   */
  alwaysShowJoinCode?: boolean;
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
/**
 * 抽選リスト（抽選会の名簿・ビンゴの球）。
 * クイズと同じく、司会者が事前に用意して使い回す資産。
 */
export type DrawListDoc = {
  id: string;
  ownerId: string;
  title: string;
  kind: DrawListKind;
  /** kind === 'number' のときだけ意味を持つ。 */
  numberMin: number | null;
  numberMax: number | null;
  settings: DrawSettings;
  /** 一覧表示用のキャッシュ。数字モードでは範囲から導いた件数。 */
  entryCount: number;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
};

/** `drawLists/{listId}/entries/{entryId}` — 数字モードでは作らない（範囲から展開する）。 */
export type DrawListEntryDoc = {
  id: string;
  listId: string;
  position: number;
  label: string;
  /** 品目モードのみ。クイズの画像と同じく ID と代替テキストだけを持つ。 */
  imageAssetId: string | null;
  imageAlt: string | null;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
};

export type RoomDoc = {
  id: string;
  ownerId: string;
  /**
   * ルームのモード。
   * この項目が増える前に作られたルームには入っていない。
   * 読むときは必ず `roomModeOf()` を通すこと（既定はクイズ）。
   */
  mode?: RoomMode;
  /** 抽選会・ビンゴのルームでは null。 */
  quizId: string | null;
  joinTokenHash: string;
  /**
   * 参加 URL の平文トークン。
   *
   * 投影担当は司会と違う端末で画面を開くため、ここに持っていないと
   * 会場で参加 URL を貼り付けさせることになる（当日いちばん詰まる場所）。
   * このドキュメントは**司会本人しか読めず、すでに正解を含んでいる**ので、
   * 同じ場所へ置いても新しく晒すものは無い。
   * この項目が増える前に作られたルームには入っていない（読み側で null 許容）。
   */
  joinToken?: string;
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
  /**
   * 抽選会・ビンゴで引くものの一覧。ルームを作った瞬間の内容を写し取る
   * （当日リストを編集されても、進行中のルームの中身は変わらない）。
   * クイズのルームでは null。
   */
  drawSnapshot: DrawSnapshot | null;
  /**
   * 引いた記録。引いた順に増える。`order` がそのまま当選順位になる。
   *
   * 引く操作をするのは司会 1 人だけなので、1 ドキュメントへの書き込みが
   * 集中することはない（参加登録と違い、ここは配列で持って良い）。
   */
  drawn: DrawRecord[];
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
