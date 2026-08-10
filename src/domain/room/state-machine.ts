/**
 * ルーム進行の状態機械。
 *
 * LOBBY → QUESTION_READY → QUESTION_OPEN → QUESTION_LOCKED → ANSWER_REVEALED
 *   → (SCOREBOARD) → QUESTION_READY ... → FINISHED
 *
 * すべての状態変更で state_version を 1 増やし、司会 API は expectedVersion を検証する。
 */

export const ROOM_PHASES = [
  'lobby',
  'question_ready',
  'question_open',
  'question_locked',
  'answer_revealed',
  'scoreboard',
  'finished',
] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];

export const ROOM_ACTIONS = [
  'show_question',
  'open_question',
  'lock_question',
  'reveal_answer',
  'show_scoreboard',
  'finish_room',
] as const;

export type RoomAction = (typeof ROOM_ACTIONS)[number];

/** 各アクションを実行できる現在フェーズ。 */
const ALLOWED_FROM: Record<RoomAction, readonly RoomPhase[]> = {
  show_question: ['lobby', 'answer_revealed', 'scoreboard'],
  open_question: ['question_ready'],
  lock_question: ['question_open'],
  reveal_answer: ['question_locked'],
  show_scoreboard: ['answer_revealed'],
  finish_room: ['lobby', 'answer_revealed', 'scoreboard', 'question_locked'],
};

/** アクション成功後のフェーズ。 */
const RESULT_PHASE: Record<RoomAction, RoomPhase> = {
  show_question: 'question_ready',
  open_question: 'question_open',
  lock_question: 'question_locked',
  reveal_answer: 'answer_revealed',
  show_scoreboard: 'scoreboard',
  finish_room: 'finished',
};

/** アクションが questionId を必要とするか。 */
const REQUIRES_QUESTION_ID: Record<RoomAction, boolean> = {
  show_question: true,
  open_question: false,
  lock_question: false,
  reveal_answer: false,
  show_scoreboard: false,
  finish_room: false,
};

export function isRoomPhase(value: string): value is RoomPhase {
  return (ROOM_PHASES as readonly string[]).includes(value);
}

export function isRoomAction(value: string): value is RoomAction {
  return (ROOM_ACTIONS as readonly string[]).includes(value);
}

export function canTransition(from: RoomPhase, action: RoomAction): boolean {
  return ALLOWED_FROM[action].includes(from);
}

export function nextPhase(from: RoomPhase, action: RoomAction): RoomPhase {
  if (!canTransition(from, action)) {
    throw new Error(`INVALID_TRANSITION: ${from} -> ${action}`);
  }
  return RESULT_PHASE[action];
}

export function requiresQuestionId(action: RoomAction): boolean {
  return REQUIRES_QUESTION_ID[action];
}

/** 現在フェーズから実行可能なアクション一覧（司会画面のボタン表示に使う）。 */
export function availableActions(phase: RoomPhase): RoomAction[] {
  return ROOM_ACTIONS.filter((action) => canTransition(phase, action));
}

/** 回答 API が受付可能なフェーズか。 */
export function acceptsAnswers(phase: RoomPhase): boolean {
  return phase === 'question_open';
}

/** 参加者へ正解情報を出してよいフェーズか。 */
export function revealsAnswer(phase: RoomPhase): boolean {
  return phase === 'answer_revealed' || phase === 'scoreboard' || phase === 'finished';
}

/** 投影・司会画面へ集計を出してよいフェーズか（回答受付中は出さない）。 */
export function showsBreakdown(phase: RoomPhase): boolean {
  return phase === 'answer_revealed' || phase === 'scoreboard' || phase === 'finished';
}

/** 参加者へ問題本文を出してよいフェーズか。 */
export function showsQuestion(phase: RoomPhase): boolean {
  return (
    phase === 'question_ready' ||
    phase === 'question_open' ||
    phase === 'question_locked' ||
    phase === 'answer_revealed'
  );
}

export const ROOM_PHASE_LABELS: Record<RoomPhase, string> = {
  lobby: '待機中',
  question_ready: '問題表示中',
  question_open: '回答受付中',
  question_locked: '回答締切',
  answer_revealed: '正解発表',
  scoreboard: 'ランキング',
  finished: '終了',
};

export const ROOM_ACTION_LABELS: Record<RoomAction, string> = {
  show_question: '問題を表示',
  open_question: '回答受付を開始',
  lock_question: '回答を締め切る',
  reveal_answer: '正解を発表',
  show_scoreboard: 'ランキングを表示',
  finish_room: 'クイズを終了',
};
