/**
 * ルーム進行の状態機械。
 *
 * LOBBY → QUESTION_READY → QUESTION_OPEN → QUESTION_LOCKED → ANSWER_REVEALED
 *   → (SCOREBOARD) → QUESTION_READY ... → FINISHED
 *
 * FINISHED からは reopen_room で復帰できる（誤って終了しても続きから再開できる）。
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
  'extend_deadline',
  'reveal_answer',
  'show_scoreboard',
  'finish_room',
  'reopen_room',
] as const;

export type RoomAction = (typeof ROOM_ACTIONS)[number];

/** 各アクションを実行できる現在フェーズ。 */
const ALLOWED_FROM: Record<RoomAction, readonly RoomPhase[]> = {
  show_question: ['lobby', 'answer_revealed', 'scoreboard'],
  open_question: ['question_ready'],
  lock_question: ['question_open'],
  // 延長は「受付中」の間だけ。締め切ったあとに延ばせると、
  // 締切を見て回答をやめた人が不利になる。
  extend_deadline: ['question_open'],
  reveal_answer: ['question_locked'],
  show_scoreboard: ['answer_revealed'],
  finish_room: ['lobby', 'answer_revealed', 'scoreboard', 'question_locked'],
  // 終了からの復帰。ここだけが finished から出る唯一の道。
  reopen_room: ['finished'],
};

/** アクション成功後のフェーズ。 */
const RESULT_PHASE: Record<RoomAction, RoomPhase> = {
  show_question: 'question_ready',
  open_question: 'question_open',
  lock_question: 'question_locked',
  // 延長してもフェーズは変わらない（締切時刻だけが伸びる）。
  extend_deadline: 'question_open',
  reveal_answer: 'answer_revealed',
  show_scoreboard: 'scoreboard',
  finish_room: 'finished',
  // 1 問も出していない場合の戻り先。出題済みなら nextPhase() が scoreboard を返す。
  reopen_room: 'lobby',
};

/** アクションが questionId を必要とするか。 */
const REQUIRES_QUESTION_ID: Record<RoomAction, boolean> = {
  show_question: true,
  open_question: false,
  lock_question: false,
  extend_deadline: false,
  reveal_answer: false,
  show_scoreboard: false,
  finish_room: false,
  reopen_room: false,
};

/** 延長できる秒数の範囲。1 回の操作で足せる秒数。 */
export const EXTEND_SECONDS_MIN = 5;
export const EXTEND_SECONDS_MAX = 300;
/** 司会画面に並べる延長ボタン。 */
export const EXTEND_SECONDS_PRESETS = [10, 30, 60] as const;

export function isRoomPhase(value: string): value is RoomPhase {
  return (ROOM_PHASES as readonly string[]).includes(value);
}

export function isRoomAction(value: string): value is RoomAction {
  return (ROOM_ACTIONS as readonly string[]).includes(value);
}

export function canTransition(from: RoomPhase, action: RoomAction): boolean {
  return ALLOWED_FROM[action].includes(from);
}

/**
 * アクション後のフェーズ。
 *
 * `reopen_room` だけは戻り先が状況で変わる。
 * 1 問も出していなければ待機中へ、出題済みならランキングへ戻す
 * （ランキングからは「問題を表示」も「終了」も選べるため、続きを再開しやすい）。
 */
export function nextPhase(
  from: RoomPhase,
  action: RoomAction,
  context: { hasCurrentQuestion?: boolean } = {},
): RoomPhase {
  if (!canTransition(from, action)) {
    throw new Error(`INVALID_TRANSITION: ${from} -> ${action}`);
  }
  if (action === 'reopen_room') {
    return context.hasCurrentQuestion ? 'scoreboard' : 'lobby';
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

/**
 * 参加者へ問題本文を出してよいフェーズか。
 *
 * `beforeOpen` は「回答受付を開始する前に問題を見せるか」の設定。
 * false（既定）なら question_ready では問題を出さない。
 * 会場では「第3問！」で一度ためてから出すほうが盛り上がるため。
 */
export function showsQuestion(
  phase: RoomPhase,
  options: { beforeOpen?: boolean } = {},
): boolean {
  if (phase === 'question_ready') {
    return options.beforeOpen === true;
  }
  return phase === 'question_open' || phase === 'question_locked' || phase === 'answer_revealed';
}

/**
 * 「次へ」で進む先。
 *
 * 司会は本番中、会場を見ながら片手で操作する。
 * 毎回ボタンを選ばせるのではなく、**ふつうの進行なら 1 つのボタンを押すだけ**で
 * 最後まで進めるようにする。細かい操作（ランキングを挟む・途中で終了する）は別に残す。
 */
export type NextStep = {
  action: RoomAction;
  /** ボタンに出す文言。問題番号を含めたいので呼び出し側では組み立てない。 */
  label: string;
  /** show_question のとき、対象の問題番号（表示用）。 */
  questionPosition: number | null;
};

export function nextStep(input: {
  phase: RoomPhase;
  /** 次に出せる問題の番号。無ければ null。 */
  nextQuestionPosition: number | null;
}): NextStep | null {
  const { phase, nextQuestionPosition } = input;

  const showNextQuestion = (): NextStep | null =>
    nextQuestionPosition === null
      ? null
      : {
          action: 'show_question',
          label: `第${nextQuestionPosition}問へ`,
          questionPosition: nextQuestionPosition,
        };

  switch (phase) {
    case 'lobby':
      return showNextQuestion();
    case 'question_ready':
      return { action: 'open_question', label: '回答受付を開始', questionPosition: null };
    case 'question_open':
      return { action: 'lock_question', label: '回答を締め切る', questionPosition: null };
    case 'question_locked':
      return { action: 'reveal_answer', label: '正解を発表', questionPosition: null };
    case 'answer_revealed':
      // 次の問題があれば進み、無ければ最終ランキングへ。
      return (
        showNextQuestion() ?? {
          action: 'show_scoreboard',
          label: 'ランキングを表示',
          questionPosition: null,
        }
      );
    case 'scoreboard':
      // ランキングを見せたあと。次があれば続け、無ければ終了。
      return showNextQuestion() ?? { action: 'finish_room', label: 'クイズを終了', questionPosition: null };
    case 'finished':
      // 終了後は「次」ではなく再開。誤操作にならないよう専用の導線に任せる。
      return null;
    default:
      return null;
  }
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
  extend_deadline: '回答時間を延長',
  reveal_answer: '正解を発表',
  show_scoreboard: 'ランキングを表示',
  finish_room: 'クイズを終了',
  reopen_room: 'クイズを再開',
};
