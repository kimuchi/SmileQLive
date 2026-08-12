import 'server-only';

/**
 * ルーム進行の「壊れてはいけない」書き込みをまとめた層。
 *
 * ここが移行の中核。次の不変条件をトランザクションで担保する。
 *
 * 1. 状態遷移は stateVersion を検証してから行う（不一致は STATE_VERSION_CONFLICT）。
 *    `rooms/{id}` と `rooms/{id}/public/state` は**必ず同じトランザクション**で更新し、
 *    参加者が見る公開状態が本体と食い違わないようにする。
 * 2. 締切判定は**サーバー時刻**（Cloud Run の時計）だけで行う。クライアント時刻は一切見ない。
 * 3. 1 参加者・1 問につき 1 回答。決定的ドキュメント ID + `create()` で担保する
 *    （UNIQUE 制約と同じ強さ。ALREADY_EXISTS を ANSWER_ALREADY_EXISTS へ写す）。
 * 4. 正誤判定は問題ドキュメント（quizSnapshot）の型を基準に行い、
 *    クライアントが送ってきた形は信用しない。数値は decimal.js だけで判定する。
 * 5. 公開状態には**正解・問題文・選択肢を書かない**。
 */

import { FieldValue, type Timestamp, type Transaction } from 'firebase-admin/firestore';
import Decimal from 'decimal.js';
import { getDb } from '@/infrastructure/firebase/admin';
import {
  answerRef,
  answersCollection,
  eventRef,
  memberRef,
  membersCollection,
  publicStateRef,
  roomRef,
  staffProgressRef,
} from '@/infrastructure/firebase/paths';
import {
  isRecord,
  nowTimestamp,
  parseQuizSnapshot,
  timestampFromMillis,
  toIso,
  toIsoOr,
} from '@/infrastructure/firebase/converters';
import { countAnswers } from '@/infrastructure/firebase/repositories/room-repository';
import { judgeNumberAnswer, toDecimalRule } from '@/domain/answer/number-judgement';
import { findSnapshotQuestion, type QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import type { Question } from '@/domain/quiz/question';
import { publicEventTypeForPhase } from '@/domain/room/events';
import { awardPoints } from '@/domain/room/scoring';
import {
  canTransition,
  nextPhase,
  EXTEND_SECONDS_MAX,
  EXTEND_SECONDS_MIN,
  type RoomAction,
  type RoomPhase,
} from '@/domain/room/state-machine';
import { AppError } from '@/lib/errors/app-error';
import type { AnswerDoc, RoomDoc, RoomMemberDoc, RoomMemberRole } from '@/types/firestore';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type TransitionRoomInput = {
  roomId: string;
  action: RoomAction;
  expectedVersion: number;
  /** show_question のときだけ必要。 */
  questionId?: string | null;
  /** extend_deadline のときだけ必要。足す秒数。 */
  extendSeconds?: number | null;
  /** 認可済みの司会者 uid。トランザクション内でも所有者一致を再確認する。 */
  actorUserId: string;
};

export type TransitionResult = {
  phase: RoomPhase;
  stateVersion: number;
  /** ISO8601。クライアント時計の補正基準。 */
  serverTime: string;
  currentQuestionId: string | null;
  currentQuestionPosition: number | null;
  answerDeadlineAt: string | null;
};

/** 締切自動処理の結果。`locked` が false なら状態は変えていない（冪等）。 */
export type LockQuestionResult = TransitionResult & { locked: boolean };

export type RegisterParticipantResult = {
  roomId: string;
  participantId: string;
  nickname: string;
  /** 既存行の役割。司会・投影担当が参加 URL を開いた場合は 'participant' 以外になる。 */
  role: RoomMemberRole;
  /** すでに登録済みだった（再訪・二重送信）。 */
  alreadyJoined: boolean;
};

export type SubmitAnswerDbInput = {
  questionId: string;
  /** 選択式のときだけ使う。 */
  choiceId?: string | null;
  /** 参加者の生入力（数値式）。 */
  numberRaw?: string | null;
  /** 正規化済み文字列（数値式）。判定・集計はこちらを使う。 */
  numberNormalized?: string | null;
};

export type SubmitAnswerDbResult = {
  accepted: true;
  answeredAt: string;
  /**
   * 現在問題の回答数。**null は「今回は数えていない」**という意味。
   *
   * 進捗は書き込みを間引いているため、毎回数え直さない
   * （500 人ぶん数え直すと、そのほとんどが捨てられる）。
   * 0 を返すと「まだ誰も答えていない」と読めてしまうので区別する。
   */
  answeredCount: number | null;
};

/** 進捗ドキュメントへの書き込み間隔の下限（§3.4 の書き込み集中対策）。 */
export const ANSWER_PROGRESS_MIN_INTERVAL_MS = 400;

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

/** Firestore の ALREADY_EXISTS（gRPC code 6）を判別する。 */
function isAlreadyExistsError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error.code === 6 || error.code === 'already-exists') {
    return true;
  }
  return typeof error.message === 'string' && error.message.includes('ALREADY_EXISTS');
}

function currentStateOf(room: RoomDoc): TransitionResult {
  return {
    phase: room.phase,
    stateVersion: room.stateVersion,
    serverTime: new Date().toISOString(),
    currentQuestionId: room.currentQuestionId,
    currentQuestionPosition: room.currentQuestionPosition,
    answerDeadlineAt: toIso(room.answerDeadlineAt),
  };
}

/** 現在問題を quizSnapshot から引く。 */
function currentQuestionOf(room: RoomDoc, snapshot: QuizSnapshot): Question | null {
  if (!room.currentQuestionId) {
    return null;
  }
  return findSnapshotQuestion(snapshot, room.currentQuestionId) ?? null;
}

/** トランザクション内で現在問題の回答数を正確に数える。 */
async function countAnswersInTransaction(
  tx: Transaction,
  roomId: string,
  questionId: string,
): Promise<number> {
  const snapshot = await tx.get(
    answersCollection(roomId).where('questionId', '==', questionId).count(),
  );
  return snapshot.data().count;
}

/**
 * 状態遷移の本体。**呼び出し前に読み取りを終えていること**（Firestore は読み取り→書き込みの順）。
 * ここで `rooms/{id}` / `public/state` / `staff/progress` / `events/{stateVersion}` を同時に書く。
 */
async function applyTransition(
  tx: Transaction,
  room: RoomDoc,
  action: RoomAction,
  options: {
    questionId?: string | null;
    extendSeconds?: number | null;
    actorUserId: string | null;
  },
): Promise<TransitionResult> {
  const roomId = room.id;
  const snapshot = parseQuizSnapshot(room.quizSnapshot);
  const now = nowTimestamp();
  const nextVersion = room.stateVersion + 1;
  const phase = nextPhase(room.phase, action, {
    hasCurrentQuestion: room.currentQuestionId !== null,
  });

  let currentQuestionId = room.currentQuestionId;
  let currentQuestionPosition = room.currentQuestionPosition;
  let answerDeadlineAt: Timestamp | null = room.answerDeadlineAt;
  let finishedAt: Timestamp | null = room.finishedAt;
  let joinOpen = room.joinOpen;

  // 公開してよい回答数。締切・正解発表では必ず正確な値を書く（§3.4）。
  const publicSnapshot = await tx.get(publicStateRef(roomId));
  let answeredCount = publicSnapshot.data()?.answeredCount ?? 0;

  switch (action) {
    case 'show_question': {
      const questionId = options.questionId ?? null;
      if (!questionId) {
        throw new AppError('QUESTION_NOT_FOUND');
      }
      const question = findSnapshotQuestion(snapshot, questionId);
      if (!question) {
        throw new AppError('QUESTION_NOT_FOUND');
      }
      currentQuestionId = question.id;
      currentQuestionPosition = question.position;
      answerDeadlineAt = null;
      // 表示する問題が変わるので進捗を数え直す（通常は 0 件）。
      answeredCount = await countAnswersInTransaction(tx, roomId, question.id);
      break;
    }
    case 'open_question': {
      const question = currentQuestionOf(room, snapshot);
      if (!question) {
        throw new AppError('QUESTION_NOT_FOUND');
      }
      // 締切時刻はサーバーがここで決めて保存する。以後クライアント時刻は参照しない。
      answerDeadlineAt = timestampFromMillis(now.toMillis() + question.timeLimitSeconds * 1000);
      break;
    }
    case 'extend_deadline': {
      const seconds = options.extendSeconds ?? 0;
      if (!Number.isInteger(seconds) || seconds < EXTEND_SECONDS_MIN || seconds > EXTEND_SECONDS_MAX) {
        throw new AppError('VALIDATION_FAILED', {
          details: { reason: 'extend_seconds_out_of_range' },
        });
      }
      // 締切をどこから伸ばすかは**サーバー時刻**だけで決める。
      // まだ残っていれば残り時間へ足し、すでに過ぎていれば今から数え直す
      // （締切直後に押しても「もう一度その秒数だけ受け付ける」になる）。
      const base = Math.max(now.toMillis(), room.answerDeadlineAt?.toMillis() ?? 0);
      answerDeadlineAt = timestampFromMillis(base + seconds * 1000);
      break;
    }
    case 'reopen_question': {
      // 締め切ったあとに受付へ戻す。時間切れの直後や、締切ボタンの誤操作からの復帰。
      // 締切時刻は**今から**数え直す（残っていた時間は戻さない）。
      const question = currentQuestionOf(room, snapshot);
      if (!question) {
        throw new AppError('QUESTION_NOT_FOUND');
      }
      const seconds = options.extendSeconds ?? question.timeLimitSeconds;
      if (!Number.isInteger(seconds) || seconds < EXTEND_SECONDS_MIN || seconds > EXTEND_SECONDS_MAX) {
        throw new AppError('VALIDATION_FAILED', {
          details: { reason: 'extend_seconds_out_of_range' },
        });
      }
      answerDeadlineAt = timestampFromMillis(now.toMillis() + seconds * 1000);
      break;
    }
    case 'lock_question':
    case 'reveal_answer': {
      answerDeadlineAt = null;
      answeredCount = currentQuestionId
        ? await countAnswersInTransaction(tx, roomId, currentQuestionId)
        : 0;
      break;
    }
    case 'show_scoreboard': {
      answerDeadlineAt = null;
      break;
    }
    case 'finish_room': {
      answerDeadlineAt = null;
      finishedAt = now;
      joinOpen = false;
      break;
    }
    case 'reopen_room': {
      // 得点・回答は消さない。終了の記録だけを取り消して続きから再開できるようにする。
      answerDeadlineAt = null;
      finishedAt = null;
      // 終了時に閉じた参加受付を戻す。二次元コードもそのまま使える
      // （参加 URL を無効にしたい場合は司会画面から改めて再発行する）。
      joinOpen = true;
      break;
    }
  }

  tx.update(roomRef(roomId), {
    phase,
    stateVersion: nextVersion,
    currentQuestionId,
    currentQuestionPosition,
    // 延長はフェーズを変えないので「いつこのフェーズに入ったか」も動かさない。
    phaseStartedAt: action === 'extend_deadline' ? room.phaseStartedAt : now,
    answerDeadlineAt,
    joinOpen,
    finishedAt,
    updatedAt: now,
  });

  // 参加者・投影担当が購読するドキュメント。正解・問題文・選択肢は絶対に入れない。
  tx.set(publicStateRef(roomId), {
    roomId,
    phase,
    stateVersion: nextVersion,
    currentQuestionId,
    currentQuestionPosition,
    totalQuestions: snapshot.questions.length,
    answerDeadlineAt,
    joinOpen,
    participantCount: room.participantCount,
    answeredCount,
    updatedAt: now,
  });

  // 司会・投影向けの進捗。内訳は締切後にだけ書く（ここでは触らない）。
  tx.set(
    staffProgressRef(roomId),
    {
      roomId,
      stateVersion: nextVersion,
      participantCount: room.participantCount,
      answeredCount,
      updatedAt: now,
      ...(action === 'show_question' ? { breakdown: null } : {}),
    },
    { merge: true },
  );

  // 監査ログ。ドキュメント ID を stateVersion にすることで二重記録を防ぐ。
  tx.create(eventRef(roomId, nextVersion), {
    roomId,
    stateVersion: nextVersion,
    eventType: publicEventTypeForPhase(phase),
    payload: {
      action,
      phase,
      questionId: currentQuestionId,
      questionPosition: currentQuestionPosition,
      answerDeadlineAt: toIso(answerDeadlineAt),
    },
    actorUserId: options.actorUserId,
    createdAt: now,
  });

  return {
    phase,
    stateVersion: nextVersion,
    serverTime: toIsoOr(now),
    currentQuestionId,
    currentQuestionPosition,
    answerDeadlineAt: toIso(answerDeadlineAt),
  };
}

// ---------------------------------------------------------------------------
// 1. 状態遷移
// ---------------------------------------------------------------------------

/**
 * 司会操作による状態遷移。
 *
 * - stateVersion が一致しなければ STATE_VERSION_CONFLICT（画面の再取得を促す）。
 * - 実行できないフェーズなら INVALID_TRANSITION。
 * - 所有者の再確認をトランザクション内でも行う（呼び出し側の検証と二重にする）。
 */
export async function transitionRoom(input: TransitionRoomInput): Promise<TransitionResult> {
  return getDb().runTransaction(async (tx) => {
    const snapshot = await tx.get(roomRef(input.roomId));
    const room = snapshot.data();
    if (!room) {
      throw new AppError('ROOM_NOT_FOUND');
    }

    if (room.ownerId !== input.actorUserId) {
      throw new AppError('FORBIDDEN');
    }
    if (room.stateVersion !== input.expectedVersion) {
      throw new AppError('STATE_VERSION_CONFLICT', {
        details: { currentVersion: room.stateVersion },
      });
    }
    // 終了済みからは reopen_room だけが出られる。
    // それ以外は「終了しています」と伝えたほうが分かりやすいので先に返す。
    if (room.phase === 'finished' && input.action !== 'reopen_room') {
      throw new AppError('ROOM_FINISHED');
    }
    if (!canTransition(room.phase, input.action)) {
      throw new AppError('INVALID_TRANSITION');
    }

    return applyTransition(tx, room, input.action, {
      questionId: input.questionId ?? null,
      extendSeconds: input.extendSeconds ?? null,
      actorUserId: input.actorUserId,
    });
  });
}

// ---------------------------------------------------------------------------
// 2. 締切の自動反映（冪等）
// ---------------------------------------------------------------------------

/**
 * 締切時刻を過ぎていれば question_locked へ進める。
 *
 * 複数端末（司会・投影）から同時に呼ばれても、進むのは 1 回だけ。
 * すでに締切済み・受付中でない場合は**現在状態をそのまま返す**（エラーにしない）。
 * 判定に使うのはサーバー時刻だけ。
 */
export async function lockQuestionIfExpired(
  roomId: string,
  actorUserId: string | null = null,
): Promise<LockQuestionResult> {
  return getDb().runTransaction(async (tx) => {
    const snapshot = await tx.get(roomRef(roomId));
    const room = snapshot.data();
    if (!room) {
      throw new AppError('ROOM_NOT_FOUND');
    }

    const deadlineMs = room.answerDeadlineAt?.toMillis() ?? null;
    const expired = deadlineMs !== null && deadlineMs <= Date.now();

    if (room.phase !== 'question_open' || !expired || !canTransition(room.phase, 'lock_question')) {
      return { ...currentStateOf(room), locked: false };
    }

    const result = await applyTransition(tx, room, 'lock_question', {
      questionId: null,
      actorUserId,
    });
    return { ...result, locked: true };
  });
}

// ---------------------------------------------------------------------------
// 3. 参加登録
// ---------------------------------------------------------------------------

/**
 * 参加者を登録する（冪等）。
 *
 * - すでに参加済みなら既存の行をそのまま返す（再訪・二重送信でも増えない）。
 * - 人数上限は ROOM_FULL、受付終了は JOIN_CLOSED、終了済みは ROOM_FINISHED。
 * - ニックネーム重複は nicknameLower の等価検索で判定する。
 *   （Firestore は「まだ存在しない行」を締め出せないため、
 *     ほぼ同時の登録で重複がすり抜ける可能性は残る。会場運用上は許容範囲。）
 *
 * ---------------------------------------------------------------------------
 * なぜトランザクションを使わないか
 * ---------------------------------------------------------------------------
 * 以前はこの全体を 1 つのトランザクションで行い、その中で
 * `rooms/{id}` を読んで `participantCount + 1` を書き戻していた。
 * 同じドキュメントを読んで書くトランザクションは、同時に走ると
 * 片方がやり直しになる。開場直後は全員が同時に二次元コードを読むため、
 * **500 人で試したところ 499 人が ABORTED で入れなかった**
 * （tests/load/scale.test.ts で再現できる）。
 *
 * 二重登録を防いでいるのはトランザクションではなく
 * 「参加者 uid を丸ごとドキュメント ID にした create()」であり、
 * これは UNIQUE 制約と同じ強さで、同時実行でも 1 件しか通らない。
 * そこでトランザクションをやめ、人数の加算は競合しない
 * FieldValue.increment に置き換えた。
 *
 * 代償として人数上限の判定はわずかに緩くなる（同時に来た人が上限を
 * 数人超えることがある）。会場の上限は運用の目安なので、
 * 「入れなかった人が出る」よりこちらを選ぶ。
 */
export async function registerParticipant(
  roomId: string,
  uid: string,
  nickname: string,
): Promise<RegisterParticipantResult> {
  const nicknameLower = nickname.toLowerCase();

  const existingMember = (await memberRef(roomId, uid).get()).data();
  if (existingMember) {
    // 司会・投影担当を参加者へ降格させない。参加者ならそのまま返す。
    return {
      roomId,
      participantId: existingMember.id,
      nickname: existingMember.nickname ?? nickname,
      role: existingMember.role,
      alreadyJoined: true,
    };
  }

  const room = (await roomRef(roomId).get()).data();
  if (!room) {
    throw new AppError('ROOM_NOT_FOUND');
  }
  if (room.finishedAt || room.phase === 'finished') {
    throw new AppError('ROOM_FINISHED');
  }
  if (!room.joinOpen) {
    throw new AppError('JOIN_CLOSED');
  }
  if (room.participantCount >= room.maxParticipants) {
    throw new AppError('ROOM_FULL');
  }

  const duplicate = await membersCollection(roomId)
    .where('nicknameLower', '==', nicknameLower)
    .limit(1)
    .get();
  if (!duplicate.empty) {
    throw new AppError('NICKNAME_TAKEN');
  }

  const now = nowTimestamp();
  const member: RoomMemberDoc = {
    id: uid,
    roomId,
    authUserId: uid,
    role: 'participant',
    nickname,
    nicknameLower,
    joinedAt: now,
    lastSeenAt: now,
    isActive: true,
    totalPoints: 0,
    correctCount: 0,
    correctElapsedMsTotal: 0,
  };

  try {
    // 決定的なドキュメント ID + create() が UNIQUE 制約の役目を果たす。
    // 同じ人が連打しても、ここを通るのは 1 回だけ。
    await memberRef(roomId, uid).create(member);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      // ほぼ同時の二重送信。先に通ったほうの行をそのまま返す。
      const stored = (await memberRef(roomId, uid).get()).data();
      return {
        roomId,
        participantId: uid,
        nickname: stored?.nickname ?? nickname,
        role: stored?.role ?? 'participant',
        alreadyJoined: true,
      };
    }
    throw error;
  }

  await bumpParticipantCount(roomId);

  return { roomId, participantId: uid, nickname, role: 'participant', alreadyJoined: false };
}

/**
 * 参加人数の表示値を 1 増やす。
 *
 * `rooms/{id}` は誰も購読していないので、都度きっちり増やす（表示と実数がずれない）。
 * `public/state` は**参加者全員が購読している**ため、1 件書くたびに人数ぶんの
 * 読み取りが発生する。500 人が一斉に入ると 500×500 になってしまうので、
 * こちらは間引いて書く（遅れても「参加 N 人」の表示が少し遅れるだけ）。
 * 進行操作のたびに applyTransition が正確な値で上書きするため、ずれは残らない。
 */
async function bumpParticipantCount(roomId: string): Promise<void> {
  const now = nowTimestamp();
  try {
    await roomRef(roomId).update({
      participantCount: FieldValue.increment(1),
      updatedAt: now,
    });
  } catch {
    // 人数表示のための更新。失敗しても参加そのものは成立している。
    return;
  }

  if (!shouldWriteProgress(participantCountThrottleKey(roomId))) {
    return;
  }

  try {
    const participantCount = (await roomRef(roomId).get()).data()?.participantCount ?? 0;
    const batch = getDb().batch();
    batch.set(publicStateRef(roomId), { participantCount, updatedAt: now }, { merge: true });
    batch.set(staffProgressRef(roomId), { participantCount, updatedAt: now }, { merge: true });
    await batch.commit();
  } catch {
    // 同上。
  }
}

// ---------------------------------------------------------------------------
// 4. 回答の登録
// ---------------------------------------------------------------------------

type JudgedAnswer = {
  choiceId: string | null;
  numberRaw: string | null;
  numberNormalized: string | null;
  isCorrect: boolean;
};

/**
 * 正誤判定。**問題の型を基準**にし、クライアントが送ってきた形は信用しない。
 * 数値は decimal.js だけで判定する（JavaScript の number を経由させない）。
 */
function judgeAnswer(question: Question, input: SubmitAnswerDbInput): JudgedAnswer {
  if (question.type === 'choice') {
    const choiceId = input.choiceId ?? null;
    if (!choiceId) {
      throw new AppError('ANSWER_TYPE_MISMATCH');
    }
    const choice = question.choices.find((entry) => entry.id === choiceId);
    if (!choice) {
      throw new AppError('INVALID_CHOICE');
    }
    return { choiceId, numberRaw: null, numberNormalized: null, isCorrect: choice.isCorrect };
  }

  const normalized = input.numberNormalized ?? null;
  if (normalized === null || normalized.length === 0) {
    throw new AppError('ANSWER_TYPE_MISMATCH');
  }

  let value: Decimal;
  try {
    value = new Decimal(normalized);
  } catch (error) {
    throw new AppError('INVALID_NUMBER_FORMAT', { cause: error });
  }

  return {
    choiceId: null,
    numberRaw: input.numberRaw ?? normalized,
    numberNormalized: normalized,
    isCorrect: judgeNumberAnswer(value, toDecimalRule(question.numberRule)),
  };
}

/**
 * 回答を登録する。
 *
 * 締切判定はサーバー時刻のみ。二重回答は決定的 ID + create() で防ぐ。
 * 得点集計は同じトランザクションで members へ加算し、
 * ランキング算出時に回答を全件読まなくて済むようにする。
 */
export async function submitAnswer(
  roomId: string,
  uid: string,
  input: SubmitAnswerDbInput,
): Promise<SubmitAnswerDbResult> {
  let answeredAt: string;

  try {
    answeredAt = await getDb().runTransaction(async (tx) => {
      const memberSnapshot = await tx.get(memberRef(roomId, uid));
      const member = memberSnapshot.data();
      if (!member || member.role !== 'participant') {
        throw new AppError('NOT_A_PARTICIPANT');
      }

      const roomSnapshot = await tx.get(roomRef(roomId));
      const room = roomSnapshot.data();
      if (!room) {
        throw new AppError('ROOM_NOT_FOUND');
      }
      if (room.phase !== 'question_open') {
        throw new AppError('ANSWER_NOT_OPEN');
      }
      if (!room.currentQuestionId || room.currentQuestionId !== input.questionId) {
        throw new AppError('ANSWER_QUESTION_MISMATCH');
      }

      // 締切はサーバー時刻で判定する。クライアントが送る時刻は一切見ない。
      const now = nowTimestamp();
      const deadlineMs = room.answerDeadlineAt?.toMillis() ?? null;
      if (deadlineMs !== null && now.toMillis() > deadlineMs) {
        throw new AppError('ANSWER_DEADLINE_PASSED');
      }

      const snapshot = parseQuizSnapshot(room.quizSnapshot);
      const question = findSnapshotQuestion(snapshot, room.currentQuestionId);
      if (!question) {
        throw new AppError('QUESTION_NOT_FOUND');
      }

      const ref = answerRef(roomId, question.id, uid);
      const existing = await tx.get(ref);
      if (existing.exists) {
        throw new AppError('ANSWER_ALREADY_EXISTS');
      }

      const judged = judgeAnswer(question, input);
      const elapsedMs = Math.max(
        0,
        now.toMillis() - (room.phaseStartedAt?.toMillis() ?? now.toMillis()),
      );
      const pointsAwarded = awardPoints(judged.isCorrect, question.points);

      const answer: AnswerDoc = {
        id: ref.id,
        roomId,
        questionId: question.id,
        participantId: uid,
        nickname: member.nickname,
        answerType: question.type,
        choiceId: judged.choiceId,
        numberRaw: judged.numberRaw,
        numberNormalized: judged.numberNormalized,
        answeredAt: now,
        elapsedMs,
        isCorrect: judged.isCorrect,
        pointsAwarded,
      };

      // create() なので、既に回答があればコミット時に ALREADY_EXISTS で失敗する。
      tx.create(ref, answer);

      tx.update(memberRef(roomId, uid), {
        totalPoints: FieldValue.increment(pointsAwarded),
        correctCount: FieldValue.increment(judged.isCorrect ? 1 : 0),
        correctElapsedMsTotal: FieldValue.increment(judged.isCorrect ? elapsedMs : 0),
        lastSeenAt: now,
        isActive: true,
      });

      return toIsoOr(now);
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new AppError('ANSWER_ALREADY_EXISTS', { cause: error });
    }
    throw error;
  }

  // 進捗はトランザクションの外で更新する（1 ドキュメントへの書き込み集中を避ける）。
  const progress = await updateAnswerProgress(roomId, { questionId: input.questionId });

  return { accepted: true, answeredAt, answeredCount: progress.answeredCount };
}

// ---------------------------------------------------------------------------
// 5. 回答進捗（書き込み集中対策）
// ---------------------------------------------------------------------------

export type AnswerProgressOptions = {
  /** 省略時はルームの現在問題を読み直す。 */
  questionId?: string | null;
  /** すでに数えてある場合は再集計しない。 */
  answeredCount?: number;
  /** 締切・正解発表など、必ず正確な件数を書きたいときに true。 */
  force?: boolean;
};

export type AnswerProgressResult = {
  /** 数えたときだけ件数が入る。間引いた回は null。 */
  answeredCount: number | null;
  written: boolean;
};

/**
 * 直近に共有ドキュメントへ書いた時刻（用途ごと・ルームごと）。
 * 進行状態そのものではなく「書き込みを間引くためのヒント」なので、
 * インスタンスごとに独立していても問題ない（最悪、少し多く書くだけ）。
 */
const lastProgressWriteAt = new Map<string, number>();

/** 参加人数の間引き用キー。回答進捗とは別枠で数える。 */
function participantCountThrottleKey(roomId: string): string {
  return `participants:${roomId}`;
}

/**
 * 間引きの判定。書いてよければ true を返し、同時に時刻を記録する。
 * 「判定してから重い処理をする」ために、集計より**先に**呼ぶこと。
 */
function shouldWriteProgress(key: string): boolean {
  const now = Date.now();
  const last = lastProgressWriteAt.get(key) ?? 0;
  if (now - last < ANSWER_PROGRESS_MIN_INTERVAL_MS) {
    return false;
  }
  lastProgressWriteAt.set(key, now);
  return true;
}

/** テスト用にスロットリング状態を破棄する。 */
export function resetAnswerProgressThrottle(): void {
  lastProgressWriteAt.clear();
}

/**
 * `public/state.answeredCount` と `staff/progress.answeredCount` を更新する。
 *
 * 200 人が 10 秒で回答すると 1 ドキュメントへ毎秒 20 回書き込むことになり、
 * Firestore の 1 ドキュメントあたりの上限に当たる。
 * そこで **前回書き込みから 400ms 未満はスキップ**する（docs/FIRESTORE_MODEL.md §3.4）。
 *
 * 間引きの判定は集計クエリより**先に**行う。あとで判定すると、
 * 書かないと決まっている呼び出しでも人数ぶんの count() が走ってしまう
 * （500 人なら 1 問につき 500 回。これは丸ごと無駄になる）。
 * そのぶん、書かなかったときに返す件数は「呼び出し側が渡した値か 0」になる。
 * 締切・正解発表など正確な件数が要る場面は force: true で呼ぶこと。
 */
export async function updateAnswerProgress(
  roomId: string,
  options: AnswerProgressOptions = {},
): Promise<AnswerProgressResult> {
  let questionId = options.questionId ?? null;
  if (!questionId) {
    const room = await roomRef(roomId).get();
    questionId = room.data()?.currentQuestionId ?? null;
  }
  if (!questionId) {
    return { answeredCount: 0, written: false };
  }

  if (options.force !== true && !shouldWriteProgress(roomId)) {
    return { answeredCount: options.answeredCount ?? null, written: false };
  }

  const answeredCount = options.answeredCount ?? (await countAnswers(roomId, questionId));

  const updatedAt = nowTimestamp();
  const batch = getDb().batch();
  batch.set(publicStateRef(roomId), { answeredCount, updatedAt }, { merge: true });
  batch.set(staffProgressRef(roomId), { answeredCount, updatedAt }, { merge: true });
  await batch.commit();

  return { answeredCount, written: true };
}
