/**
 * ルーム進行の状態機械。
 *
 * ルームには 3 つのモードがある（domain/room/room-mode.ts）。
 * どのモードでも `lobby` で始まり `finished` で終わり、
 * `finished` からは `reopen_room` で復帰できる（誤って終了しても続きから再開できる）。
 *
 * クイズ:
 *   LOBBY → QUESTION_READY → QUESTION_OPEN → QUESTION_LOCKED → ANSWER_REVEALED
 *     → (SCOREBOARD) → QUESTION_READY ... → FINISHED
 *
 * 抽選会・ビンゴ（1 つずつ引くモード）:
 *   LOBBY → DRAW_READY ⇄ DRAW_REVEALED → FINISHED
 *
 * 投票:
 *   LOBBY → POLL_OPEN → POLL_CLOSED → POLL_REVEALING → FINISHED
 *   締め切った時点で集計を凍らせ、司会が確かめて（必要なら直して）から発表する。
 *   POLL_CLOSED からは POLL_OPEN へ戻せる（締切の押し間違いから復帰できる）。
 *
 * すべての状態変更で state_version を 1 増やし、司会 API は expectedVersion を検証する。
 * **同じフェーズ名を両方のモードで使い回さない。** 使い回すと
 * 「クイズのつもりの操作が抽選のルームで通る」事故が起きる。
 * どの操作が出せるかは availableActions(phase, mode) が決める。
 */

import { isDrawMode, type RoomMode } from '@/domain/room/room-mode';

export const ROOM_PHASES = [
  'lobby',
  // クイズ
  'question_ready',
  'question_open',
  'question_locked',
  'answer_revealed',
  'scoreboard',
  // 抽選会・ビンゴ・ルーレット
  'draw_ready',
  // ルーレットだけ。回っている最中（まだ当たりは決まっていない）。
  'draw_spinning',
  'draw_revealed',
  // 投票
  /** 投票を受け付けている。 */
  'poll_open',
  /** 締め切った。集計を確かめ、必要なら直す。まだ結果は出さない。 */
  'poll_closed',
  /** 結果発表中。下の順位から 1 つずつ出す。 */
  'poll_revealing',
  'finished',
] as const;

export type RoomPhase = (typeof ROOM_PHASES)[number];

export const ROOM_ACTIONS = [
  // クイズ
  'show_question',
  'open_question',
  'lock_question',
  'extend_deadline',
  'reopen_question',
  'reveal_answer',
  'show_scoreboard',
  // 抽選会・ビンゴ・ルーレット
  'open_draw',
  // ルーレットだけ。回し始める（この時点では当たりを決めない）。
  'start_spin',
  'draw_next',
  'continue_draw',
  'undo_draw',
  'reset_draws',
  // 投票
  'open_poll',
  'close_poll',
  'reopen_poll',
  'start_reveal',
  'reveal_next',
  // 共通
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
  // 締め切ったあとに受付へ戻す（時間切れの直後や、締切ボタンの誤操作から戻すため）。
  // 正解を出したあとには戻せない。答えを見てから回答できてしまう。
  reopen_question: ['question_locked'],
  reveal_answer: ['question_locked'],
  show_scoreboard: ['answer_revealed'],

  // --- 抽選会・ビンゴ・ルーレット ---
  open_draw: ['lobby'],
  // ルーレットの「スタート」。回すだけで、当たりはまだ決めない。
  start_spin: ['draw_ready', 'draw_revealed'],
  // 結果を出したまま続けて引ける（ビンゴは「引く」を繰り返すのが自然）。
  // ルーレットでは「ストップ」にあたり、回っている最中からだけ押せる。
  draw_next: ['draw_ready', 'draw_spinning', 'draw_revealed'],
  // 表示を READY へ戻す（抽選会の「次へ」）。
  continue_draw: ['draw_revealed'],
  // 引き間違い・二度押しからの復帰。直前の 1 件だけを取り消す。
  undo_draw: ['draw_ready', 'draw_spinning', 'draw_revealed'],
  // 全部戻して最初から。GAS 版の「当選リセット」に相当。
  reset_draws: ['draw_ready', 'draw_spinning', 'draw_revealed'],

  // --- 投票 ---
  open_poll: ['lobby'],
  // 締め切った時点で集計を凍らせる。ここから先、票は増えない。
  close_poll: ['poll_open'],
  // 締切の押し間違いから戻す。**発表を始めたあとは戻せない**
  // （結果を見てから投票できてしまう）。
  reopen_poll: ['poll_closed'],
  start_reveal: ['poll_closed'],
  // 次の順位を出す。下の順位から 1 つずつ。
  reveal_next: ['poll_revealing'],

  finish_room: [
    'lobby',
    'answer_revealed',
    'scoreboard',
    'question_locked',
    'draw_ready',
    'draw_spinning',
    'draw_revealed',
    'poll_open',
    'poll_closed',
    'poll_revealing',
  ],
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
  reopen_question: 'question_open',
  reveal_answer: 'answer_revealed',
  show_scoreboard: 'scoreboard',

  open_draw: 'draw_ready',
  start_spin: 'draw_spinning',
  draw_next: 'draw_revealed',
  continue_draw: 'draw_ready',
  // 取り消したあとは必ず READY へ戻す。直前の結果を出したままだと
  // 「取り消したのに画面に残っている」ように見える。
  undo_draw: 'draw_ready',
  reset_draws: 'draw_ready',

  open_poll: 'poll_open',
  close_poll: 'poll_closed',
  reopen_poll: 'poll_open',
  start_reveal: 'poll_revealing',
  // 順位を 1 つ出してもフェーズは変わらない（出した数だけが増える）。
  reveal_next: 'poll_revealing',

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
  reopen_question: false,
  reveal_answer: false,
  show_scoreboard: false,
  open_draw: false,
  start_spin: false,
  draw_next: false,
  continue_draw: false,
  undo_draw: false,
  reset_draws: false,
  open_poll: false,
  close_poll: false,
  reopen_poll: false,
  start_reveal: false,
  reveal_next: false,
  finish_room: false,
  reopen_room: false,
};

/** そのモードで使えるアクションか。モードをまたいだ操作を通さないための表。 */
const ACTION_MODES: Record<RoomAction, readonly RoomMode[]> = {
  show_question: ['quiz'],
  open_question: ['quiz'],
  lock_question: ['quiz'],
  extend_deadline: ['quiz'],
  reopen_question: ['quiz'],
  reveal_answer: ['quiz'],
  show_scoreboard: ['quiz'],
  open_draw: ['lottery', 'bingo', 'roulette'],
  // 回してから止める、という 2 段構えはルーレットだけ。
  // 抽選会・ビンゴは押した瞬間に決まる（演出の時間は投影側が持つ）。
  start_spin: ['roulette'],
  draw_next: ['lottery', 'bingo', 'roulette'],
  continue_draw: ['lottery', 'bingo', 'roulette'],
  undo_draw: ['lottery', 'bingo', 'roulette'],
  reset_draws: ['lottery', 'bingo', 'roulette'],
  open_poll: ['poll'],
  close_poll: ['poll'],
  reopen_poll: ['poll'],
  start_reveal: ['poll'],
  reveal_next: ['poll'],
  finish_room: ['quiz', 'lottery', 'bingo', 'roulette', 'poll'],
  reopen_room: ['quiz', 'lottery', 'bingo', 'roulette', 'poll'],
};

export function actionAllowedInMode(action: RoomAction, mode: RoomMode): boolean {
  return ACTION_MODES[action].includes(mode);
}

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
  context: { hasCurrentQuestion?: boolean; mode?: RoomMode } = {},
): RoomPhase {
  if (!canTransition(from, action)) {
    throw new Error(`INVALID_TRANSITION: ${from} -> ${action}`);
  }
  if (action === 'reopen_room') {
    // 抽選会・ビンゴには「ランキング」も「問題」も無い。引ける状態へ戻す。
    if (context.mode === 'lottery' || context.mode === 'bingo') {
      return 'draw_ready';
    }
    return context.hasCurrentQuestion ? 'scoreboard' : 'lobby';
  }
  return RESULT_PHASE[action];
}

export function requiresQuestionId(action: RoomAction): boolean {
  return REQUIRES_QUESTION_ID[action];
}

/**
 * 現在フェーズとモードから実行可能なアクション一覧（司会画面のボタン表示に使う）。
 *
 * モードを渡さないとクイズとして扱う。既存の呼び出しをそのまま通すため。
 */
export function availableActions(phase: RoomPhase, mode: RoomMode = 'quiz'): RoomAction[] {
  return ROOM_ACTIONS.filter(
    (action) => canTransition(phase, action) && actionAllowedInMode(action, mode),
  );
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
export function showsQuestion(phase: RoomPhase, options: { beforeOpen?: boolean } = {}): boolean {
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

/**
 * 抽選会・ビンゴの「次へ」。
 *
 * ふつうの進行は「引く」を繰り返すだけ。引くものが無くなったら終了へ導く。
 * 取り消し・リセットは事故からの復帰なので、この 1 ボタンには載せない。
 */
function nextDrawStep(
  phase: RoomPhase,
  mode: RoomMode,
  remainingDrawCount: number,
): NextStep | null {
  const drawNext: NextStep = {
    action: 'draw_next',
    label: roomActionLabel('draw_next', mode),
    questionPosition: null,
  };
  const finish: NextStep = {
    action: 'finish_room',
    label: roomActionLabel('finish_room', mode),
    questionPosition: null,
  };

  switch (phase) {
    case 'lobby':
      return {
        action: 'open_draw',
        label: roomActionLabel('open_draw', mode),
        questionPosition: null,
      };
    case 'draw_ready':
    case 'draw_revealed':
      // 残りが無ければ「引く」を出さない。押せるのに何も起きないボタンを出さない。
      if (remainingDrawCount <= 0) {
        return finish;
      }
      // ルーレットは「スタート」で回してから「ストップ」で止める 2 段構え。
      return mode === 'roulette'
        ? {
            action: 'start_spin',
            label: roomActionLabel('start_spin', mode),
            questionPosition: null,
          }
        : drawNext;
    case 'draw_spinning':
      // 回っている最中の次の一手は「ストップ」だけ。
      return drawNext;
    case 'finished':
      // 終了後は「次」ではなく再開。誤操作にならないよう専用の導線に任せる。
      return null;
    default:
      return null;
  }
}

/**
 * 投票の「次の一手」。
 *
 * 受付 → 締切 → （集計を確かめる）→ 発表 → 順位を出す → 終了、と一本道で進む。
 * 締め切ったあとすぐ発表へ進む大きなボタンは出すが、
 * **票数を直す操作は別の欄に置く**（誤って発表を始めないため）。
 */
function nextPollStep(
  phase: RoomPhase,
  mode: RoomMode,
  revealDepth: number,
  revealedCount: number,
): NextStep | null {
  const finish: NextStep = {
    action: 'finish_room',
    label: roomActionLabel('finish_room', mode),
    questionPosition: null,
  };

  switch (phase) {
    case 'lobby':
      return { action: 'open_poll', label: '投票をはじめる', questionPosition: null };
    case 'poll_open':
      return { action: 'close_poll', label: '投票を締め切る', questionPosition: null };
    case 'poll_closed':
      return { action: 'start_reveal', label: '結果発表をはじめる', questionPosition: null };
    case 'poll_revealing':
      if (revealComplete(revealDepth, revealedCount)) {
        return finish;
      }
      return {
        action: 'reveal_next',
        label: `${nextRevealRank(revealDepth, revealedCount)}位を発表`,
        questionPosition: null,
      };
    case 'finished':
      return null;
    default:
      return null;
  }
}

/** 次に出す順位。3 位まで発表する会なら 3 → 2 → 1 の順。 */
export function nextRevealRank(revealDepth: number, revealedCount: number): number {
  return Math.max(1, revealDepth - revealedCount);
}

/** 発表しきったか。 */
export function revealComplete(revealDepth: number, revealedCount: number): boolean {
  return revealedCount >= Math.max(1, revealDepth);
}

export function nextStep(input: {
  phase: RoomPhase;
  /** 省略時はクイズ。 */
  mode?: RoomMode;
  /** 次に出せる問題の番号。無ければ null。 */
  nextQuestionPosition: number | null;
  /** 抽選会・ビンゴ: まだ引いていない件数。 */
  remainingDrawCount?: number;
  /** 投票: 何位まで発表するか。 */
  revealDepth?: number;
  /** 投票: すでに出した順位の数。 */
  revealedCount?: number;
}): NextStep | null {
  const { phase, nextQuestionPosition } = input;
  const mode = input.mode ?? 'quiz';

  // 抽選会・ビンゴ・ルーレットはまとめて 1 つずつ引く進行。
  if (isDrawMode(mode)) {
    return nextDrawStep(phase, mode, input.remainingDrawCount ?? 0);
  }

  if (mode === 'poll') {
    return nextPollStep(phase, mode, input.revealDepth ?? 1, input.revealedCount ?? 0);
  }

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
      return (
        showNextQuestion() ?? {
          action: 'finish_room',
          label: 'クイズを終了',
          questionPosition: null,
        }
      );
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
  draw_ready: '抽選待ち',
  draw_spinning: '回転中',
  draw_revealed: '結果表示中',
  poll_open: '投票受付中',
  poll_closed: '締切・集計確認',
  poll_revealing: '結果発表中',
  finished: '終了',
};

export const ROOM_ACTION_LABELS: Record<RoomAction, string> = {
  show_question: '問題を表示',
  open_question: '回答受付を開始',
  lock_question: '回答を締め切る',
  extend_deadline: '回答時間を延長',
  reopen_question: '回答受付を再開',
  reveal_answer: '正解を発表',
  show_scoreboard: 'ランキングを表示',
  open_draw: 'はじめる',
  start_spin: 'スタート',
  draw_next: '抽選する',
  continue_draw: '次へ',
  undo_draw: '直前の1件を取り消す',
  reset_draws: '最初からやり直す',
  open_poll: '投票をはじめる',
  close_poll: '投票を締め切る',
  reopen_poll: '投票受付へ戻す',
  start_reveal: '結果発表をはじめる',
  reveal_next: '次の順位を出す',
  finish_room: '終了する',
  reopen_room: '再開する',
};

/**
 * モードに合わせた操作の文言。
 *
 * 同じ `draw_next` でも、抽選会では「抽選する」、ビンゴでは「1つ引く」のほうが
 * 会場での言い方に近い。司会が迷わないよう、その場の言葉に合わせる。
 */
const MODE_ACTION_LABELS: Partial<Record<RoomMode, Partial<Record<RoomAction, string>>>> = {
  quiz: {
    finish_room: 'クイズを終了',
    reopen_room: 'クイズを再開',
  },
  lottery: {
    open_draw: '抽選をはじめる',
    draw_next: '抽選する',
    continue_draw: '次の抽選へ',
    undo_draw: '直前の当選を取り消す',
    reset_draws: '当選をリセット',
    finish_room: '抽選会を終了',
    reopen_room: '抽選会を再開',
  },
  bingo: {
    open_draw: 'ビンゴをはじめる',
    draw_next: '1つ引く',
    continue_draw: '次へ',
    undo_draw: '直前の1件を取り消す',
    reset_draws: '出た球をリセット',
    finish_room: 'ビンゴを終了',
    reopen_room: 'ビンゴを再開',
  },
  roulette: {
    open_draw: 'ルーレットをはじめる',
    start_spin: 'スタート',
    // 回っている最中に押す。押してから止まるまでの時間は設定で決める。
    draw_next: 'ストップ',
    continue_draw: '次へ',
    undo_draw: '直前の結果を取り消す',
    reset_draws: '結果をリセット',
    finish_room: 'ルーレットを終了',
    reopen_room: 'ルーレットを再開',
  },
  poll: {
    finish_room: '投票を終了',
    reopen_room: '投票を再開',
  },
};

export function roomActionLabel(action: RoomAction, mode: RoomMode = 'quiz'): string {
  return MODE_ACTION_LABELS[mode]?.[action] ?? ROOM_ACTION_LABELS[action];
}
