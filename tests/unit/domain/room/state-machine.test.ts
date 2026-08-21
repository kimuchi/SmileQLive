import { describe, expect, it } from 'vitest';
import {
  ROOM_ACTIONS,
  ROOM_ACTION_LABELS,
  ROOM_PHASES,
  ROOM_PHASE_LABELS,
  acceptsAnswers,
  actionAllowedInMode,
  availableActions,
  canTransition,
  isRoomAction,
  isRoomPhase,
  nextPhase,
  nextStep,
  requiresQuestionId,
  revealsAnswer,
  roomActionLabel,
  showsBreakdown,
  showsQuestion,
} from '@/domain/room/state-machine';
import type { RoomAction, RoomPhase } from '@/domain/room/state-machine';
import { ROOM_MODES, type RoomMode } from '@/domain/room/room-mode';

/**
 * ルーム進行の状態機械（仕様書 §37.1）。
 *
 * 状態遷移は runTransaction 内で stateVersion 検証とあわせて使うため、
 * 「どの遷移が許されるか」を表として固定し、意図しない緩和を検出する。
 */

/**
 * 各フェーズから実行できるアクション（仕様上の正）。
 *
 * モードを問わない素の遷移表。モードによる絞り込みは availableActions が行う
 * （クイズのルームで抽選の操作が出ない、など）。
 */
const EXPECTED_ACTIONS: Record<RoomPhase, RoomAction[]> = {
  lobby: ['show_question', 'open_draw', 'finish_room'],
  question_ready: ['open_question'],
  question_open: ['lock_question', 'extend_deadline'],
  question_locked: ['reopen_question', 'reveal_answer', 'finish_room'],
  answer_revealed: ['show_question', 'show_scoreboard', 'finish_room'],
  scoreboard: ['show_question', 'finish_room'],
  draw_ready: ['start_spin', 'draw_next', 'undo_draw', 'reset_draws', 'finish_room'],
  // ルーレットが回っている最中。止める・取り消す・やり直すだけができる。
  draw_spinning: ['draw_next', 'undo_draw', 'reset_draws', 'finish_room'],
  draw_revealed: [
    'start_spin',
    'draw_next',
    'continue_draw',
    'undo_draw',
    'reset_draws',
    'finish_room',
  ],
  finished: ['reopen_room'],
};

/** アクション成功後のフェーズ。 */
const EXPECTED_NEXT_PHASE: Record<RoomAction, RoomPhase> = {
  show_question: 'question_ready',
  open_question: 'question_open',
  lock_question: 'question_locked',
  extend_deadline: 'question_open',
  reopen_question: 'question_open',
  reveal_answer: 'answer_revealed',
  show_scoreboard: 'scoreboard',
  open_draw: 'draw_ready',
  start_spin: 'draw_spinning',
  draw_next: 'draw_revealed',
  continue_draw: 'draw_ready',
  undo_draw: 'draw_ready',
  reset_draws: 'draw_ready',
  finish_room: 'finished',
  // 出題前に終了した場合の戻り先。出題済みなら scoreboard（別途検証）。
  reopen_room: 'lobby',
};

describe('canTransition（全フェーズ × 全アクション）', () => {
  for (const phase of ROOM_PHASES) {
    for (const action of ROOM_ACTIONS) {
      const allowed = EXPECTED_ACTIONS[phase].includes(action);
      it(`${phase} から ${action} は ${allowed ? '可' : '不可'}`, () => {
        expect(canTransition(phase, action)).toBe(allowed);
      });
    }
  }

  it('finished から出られるのは reopen_room だけ', () => {
    for (const action of ROOM_ACTIONS) {
      expect(canTransition('finished', action)).toBe(action === 'reopen_room');
    }
  });

  it('延長できるのは回答受付中だけ（締切後に延ばさない）', () => {
    for (const phase of ROOM_PHASES) {
      expect(canTransition(phase, 'extend_deadline')).toBe(phase === 'question_open');
    }
  });

  it('受付を戻せるのは締切直後だけ（正解を出したあとは戻せない）', () => {
    // 正解を見てから回答できてしまうため、answer_revealed からは戻せない。
    for (const phase of ROOM_PHASES) {
      expect(canTransition(phase, 'reopen_question')).toBe(phase === 'question_locked');
    }
  });

  it('回答受付中は終了できない（誤操作で回答を捨てない）', () => {
    expect(canTransition('question_open', 'finish_room')).toBe(false);
  });
});

describe('nextPhase', () => {
  it('許可された遷移では次フェーズを返す', () => {
    for (const phase of ROOM_PHASES) {
      for (const action of EXPECTED_ACTIONS[phase]) {
        expect(nextPhase(phase, action)).toBe(EXPECTED_NEXT_PHASE[action]);
      }
    }
  });

  it('一巡する: lobby → question_ready → question_open → question_locked → answer_revealed → scoreboard → question_ready', () => {
    const ready = nextPhase('lobby', 'show_question');
    expect(ready).toBe('question_ready');
    const open = nextPhase(ready, 'open_question');
    expect(open).toBe('question_open');
    const locked = nextPhase(open, 'lock_question');
    expect(locked).toBe('question_locked');
    const revealed = nextPhase(locked, 'reveal_answer');
    expect(revealed).toBe('answer_revealed');
    const scoreboard = nextPhase(revealed, 'show_scoreboard');
    expect(scoreboard).toBe('scoreboard');
    expect(nextPhase(scoreboard, 'show_question')).toBe('question_ready');
  });

  it('許可されていない遷移では INVALID_TRANSITION を投げる', () => {
    expect(() => nextPhase('lobby', 'open_question')).toThrow(/INVALID_TRANSITION/);
    expect(() => nextPhase('question_open', 'reveal_answer')).toThrow(
      'INVALID_TRANSITION: question_open -> reveal_answer',
    );
    expect(() => nextPhase('finished', 'show_question')).toThrow(/INVALID_TRANSITION/);
  });

  it('延長してもフェーズは変わらない', () => {
    expect(nextPhase('question_open', 'extend_deadline')).toBe('question_open');
  });

  it('再開の戻り先は出題状況で決まる', () => {
    // まだ 1 問も出していない → 待機中から仕切り直す。
    expect(nextPhase('finished', 'reopen_room', { hasCurrentQuestion: false })).toBe('lobby');
    // 出題済み → ランキングへ戻す。ここからは出題も終了も選べる。
    expect(nextPhase('finished', 'reopen_room', { hasCurrentQuestion: true })).toBe('scoreboard');
  });

  it('再開した先から進行を続けられる', () => {
    const resumed = nextPhase('finished', 'reopen_room', { hasCurrentQuestion: true });
    expect(nextPhase(resumed, 'show_question')).toBe('question_ready');
    expect(nextPhase(resumed, 'finish_room')).toBe('finished');
  });
});

/** そのモードで使える操作（仕様上の正）。 */
const MODE_ACTIONS: Record<RoomMode, RoomAction[]> = {
  quiz: [
    'show_question',
    'open_question',
    'lock_question',
    'extend_deadline',
    'reopen_question',
    'reveal_answer',
    'show_scoreboard',
    'finish_room',
    'reopen_room',
  ],
  lottery: [
    'open_draw',
    'draw_next',
    'continue_draw',
    'undo_draw',
    'reset_draws',
    'finish_room',
    'reopen_room',
  ],
  bingo: [
    'open_draw',
    'draw_next',
    'continue_draw',
    'undo_draw',
    'reset_draws',
    'finish_room',
    'reopen_room',
  ],
  // ルーレットだけが「スタート」で回してから「ストップ」で止める。
  roulette: [
    'open_draw',
    'start_spin',
    'draw_next',
    'continue_draw',
    'undo_draw',
    'reset_draws',
    'finish_room',
    'reopen_room',
  ],
};

function expectedFor(phase: RoomPhase, mode: RoomMode): RoomAction[] {
  return EXPECTED_ACTIONS[phase].filter((action) => MODE_ACTIONS[mode].includes(action));
}

describe('availableActions', () => {
  it.each(ROOM_PHASES)('%s のボタン一覧（クイズ）', (phase) => {
    expect(availableActions(phase, 'quiz')).toEqual(expectedFor(phase, 'quiz'));
  });

  it.each(ROOM_PHASES)('%s のボタン一覧（抽選会）', (phase) => {
    expect(availableActions(phase, 'lottery')).toEqual(expectedFor(phase, 'lottery'));
  });

  it.each(ROOM_PHASES)('%s のボタン一覧（ビンゴ）', (phase) => {
    expect(availableActions(phase, 'bingo')).toEqual(expectedFor(phase, 'bingo'));
  });

  it('モードを省略したらクイズとして扱う（既存の呼び出しを変えない）', () => {
    for (const phase of ROOM_PHASES) {
      expect(availableActions(phase)).toEqual(availableActions(phase, 'quiz'));
    }
  });

  it('クイズのルームに抽選の操作は出ない', () => {
    // 出てしまうと、司会が押せてしまい、サーバー側でしか止められなくなる。
    for (const phase of ROOM_PHASES) {
      const actions = availableActions(phase, 'quiz');
      expect(actions).not.toContain('draw_next');
      expect(actions).not.toContain('open_draw');
      expect(actions).not.toContain('reset_draws');
    }
  });

  it('抽選会・ビンゴのルームにクイズの操作は出ない', () => {
    for (const mode of ['lottery', 'bingo'] as const) {
      for (const phase of ROOM_PHASES) {
        const actions = availableActions(phase, mode);
        expect(actions).not.toContain('show_question');
        expect(actions).not.toContain('open_question');
        expect(actions).not.toContain('reveal_answer');
      }
    }
  });

  it('ROOM_ACTIONS の宣言順を保つ（司会画面のボタン並びが安定する）', () => {
    const actions = availableActions('answer_revealed', 'quiz');
    const order = actions.map((action) => ROOM_ACTIONS.indexOf(action));

    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('返り値は canTransition とモードの両方に一致する', () => {
    for (const mode of ROOM_MODES) {
      for (const phase of ROOM_PHASES) {
        for (const action of ROOM_ACTIONS) {
          expect(availableActions(phase, mode).includes(action)).toBe(
            canTransition(phase, action) && actionAllowedInMode(action, mode),
          );
        }
      }
    }
  });
});

describe('モードごとの文言', () => {
  it('同じ操作でもモードに合わせた言い方になる', () => {
    // 司会は会場を見ながら片手で押す。画面の言葉がその場の言い方と違うと迷う。
    expect(roomActionLabel('draw_next', 'lottery')).toBe('抽選する');
    expect(roomActionLabel('draw_next', 'bingo')).toBe('1つ引く');
    expect(roomActionLabel('finish_room', 'quiz')).toBe('クイズを終了');
    expect(roomActionLabel('finish_room', 'lottery')).toBe('抽選会を終了');
    expect(roomActionLabel('finish_room', 'bingo')).toBe('ビンゴを終了');
  });

  it('すべての操作に文言がある（モードを問わず空にならない）', () => {
    for (const mode of ROOM_MODES) {
      for (const action of ROOM_ACTIONS) {
        expect(roomActionLabel(action, mode).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('終了からの再開（抽選会・ビンゴ）', () => {
  it('抽選会・ビンゴは「引ける状態」へ戻す', () => {
    // ランキングも問題も無いモードなので、クイズと同じ戻り先にはできない。
    expect(nextPhase('finished', 'reopen_room', { mode: 'lottery' })).toBe('draw_ready');
    expect(nextPhase('finished', 'reopen_room', { mode: 'bingo' })).toBe('draw_ready');
  });
});

describe('requiresQuestionId', () => {
  it('show_question だけが questionId を必要とする', () => {
    expect(requiresQuestionId('show_question')).toBe(true);
    for (const action of ROOM_ACTIONS.filter((a) => a !== 'show_question')) {
      expect(requiresQuestionId(action)).toBe(false);
    }
  });
});

describe('フェーズ別の公開可否', () => {
  it('acceptsAnswers は question_open だけ', () => {
    for (const phase of ROOM_PHASES) {
      expect(acceptsAnswers(phase)).toBe(phase === 'question_open');
    }
  });

  it('revealsAnswer は answer_revealed / scoreboard / finished だけ', () => {
    const allowed: RoomPhase[] = ['answer_revealed', 'scoreboard', 'finished'];
    for (const phase of ROOM_PHASES) {
      expect(revealsAnswer(phase)).toBe(allowed.includes(phase));
    }
  });

  it('正解発表前のフェーズでは絶対に正解を出さない', () => {
    for (const phase of ['lobby', 'question_ready', 'question_open', 'question_locked'] as const) {
      expect(revealsAnswer(phase)).toBe(false);
    }
  });

  it('showsBreakdown は回答受付中には出さない', () => {
    const allowed: RoomPhase[] = ['answer_revealed', 'scoreboard', 'finished'];
    for (const phase of ROOM_PHASES) {
      expect(showsBreakdown(phase)).toBe(allowed.includes(phase));
    }
    expect(showsBreakdown('question_open')).toBe(false);
    expect(showsBreakdown('question_locked')).toBe(false);
  });

  it('showsQuestion は既定では question_ready を含めない', () => {
    // 会場では「第3問！」で一度ためてから出す。既定では受付開始と同時に見せる。
    const allowed: RoomPhase[] = ['question_open', 'question_locked', 'answer_revealed'];
    for (const phase of ROOM_PHASES) {
      expect(showsQuestion(phase)).toBe(allowed.includes(phase));
    }
  });

  it('「受付前に見せる」設定なら question_ready でも出す', () => {
    const allowed: RoomPhase[] = [
      'question_ready',
      'question_open',
      'question_locked',
      'answer_revealed',
    ];
    for (const phase of ROOM_PHASES) {
      expect(showsQuestion(phase, { beforeOpen: true })).toBe(allowed.includes(phase));
    }
  });

  it('設定は question_ready 以外に影響しない', () => {
    for (const phase of ROOM_PHASES) {
      if (phase === 'question_ready') {
        continue;
      }
      expect(showsQuestion(phase, { beforeOpen: true })).toBe(showsQuestion(phase));
    }
  });
});

describe('型ガードと表示ラベル', () => {
  it('isRoomPhase / isRoomAction', () => {
    expect(isRoomPhase('lobby')).toBe(true);
    expect(isRoomPhase('unknown_phase')).toBe(false);
    expect(isRoomAction('open_question')).toBe(true);
    expect(isRoomAction('open')).toBe(false);
  });

  it('すべてのフェーズ・アクションに日本語ラベルがある', () => {
    for (const phase of ROOM_PHASES) {
      expect(ROOM_PHASE_LABELS[phase].length).toBeGreaterThan(0);
    }
    for (const action of ROOM_ACTIONS) {
      expect(ROOM_ACTION_LABELS[action].length).toBeGreaterThan(0);
    }
  });
});

describe('nextStep（司会の「次へ」）', () => {
  it('ふつうの進行を 1 ボタンで最後までたどれる', () => {
    // 6 問中 1 問目から始めて、順に押していくだけで終了まで行けること。
    const total = 2;
    let phase: RoomPhase = 'lobby';
    let done = 0;
    const trail: string[] = [];

    for (let guard = 0; guard < 20; guard += 1) {
      const step = nextStep({ phase, nextQuestionPosition: done < total ? done + 1 : null });
      if (step === null) {
        break;
      }
      trail.push(step.action);
      if (step.action === 'show_question') {
        done += 1;
      }
      phase = nextPhase(phase, step.action);
    }

    expect(phase).toBe('finished');
    expect(trail).toEqual([
      'show_question',
      'open_question',
      'lock_question',
      'reveal_answer',
      'show_question',
      'open_question',
      'lock_question',
      'reveal_answer',
      'show_scoreboard',
      'finish_room',
    ]);
  });

  it('返すのは、その時点で実行できる操作だけ', () => {
    for (const phase of ROOM_PHASES) {
      for (const position of [null, 3]) {
        const step = nextStep({ phase, nextQuestionPosition: position });
        if (step === null) {
          continue;
        }
        expect(canTransition(phase, step.action)).toBe(true);
      }
    }
  });

  it('問題番号をボタンの文言へ入れる', () => {
    expect(nextStep({ phase: 'lobby', nextQuestionPosition: 1 })?.label).toBe('第1問へ');
    expect(nextStep({ phase: 'answer_revealed', nextQuestionPosition: 4 })?.label).toBe('第4問へ');
  });

  it('最後の問題を発表したらランキングへ、そのあと終了へ', () => {
    expect(nextStep({ phase: 'answer_revealed', nextQuestionPosition: null })?.action).toBe(
      'show_scoreboard',
    );
    expect(nextStep({ phase: 'scoreboard', nextQuestionPosition: null })?.action).toBe(
      'finish_room',
    );
  });

  it('終了後は「次へ」を出さない（再開は専用の導線）', () => {
    expect(nextStep({ phase: 'finished', nextQuestionPosition: 1 })).toBeNull();
  });

  it('問題が 1 問も無ければ待機中では進めない', () => {
    expect(nextStep({ phase: 'lobby', nextQuestionPosition: null })).toBeNull();
  });
});

describe('nextStep（抽選会・ビンゴの1ボタン進行）', () => {
  it('待機中は「はじめる」', () => {
    expect(nextStep({ phase: 'lobby', mode: 'lottery', nextQuestionPosition: null })).toEqual({
      action: 'open_draw',
      label: '抽選をはじめる',
      questionPosition: null,
    });
    expect(nextStep({ phase: 'lobby', mode: 'bingo', nextQuestionPosition: null })?.label).toBe(
      'ビンゴをはじめる',
    );
  });

  it('残りがあれば「引く」を出す', () => {
    for (const phase of ['draw_ready', 'draw_revealed'] as const) {
      expect(
        nextStep({ phase, mode: 'lottery', nextQuestionPosition: null, remainingDrawCount: 3 }),
      ).toEqual({ action: 'draw_next', label: '抽選する', questionPosition: null });
    }
  });

  it('残りが無ければ「終了」へ導く（押せるのに何も起きないボタンを出さない）', () => {
    expect(
      nextStep({
        phase: 'draw_revealed',
        mode: 'bingo',
        nextQuestionPosition: null,
        remainingDrawCount: 0,
      }),
    ).toEqual({ action: 'finish_room', label: 'ビンゴを終了', questionPosition: null });
  });

  it('終了後は「次」を出さない（再開は専用の導線）', () => {
    expect(nextStep({ phase: 'finished', mode: 'lottery', nextQuestionPosition: null })).toBeNull();
  });

  it('抽選のモードではクイズの進行を返さない', () => {
    // 問題番号を渡しても、抽選のルームで「第1問へ」が出てはいけない。
    const step = nextStep({ phase: 'lobby', mode: 'bingo', nextQuestionPosition: 1 });
    expect(step?.action).toBe('open_draw');
  });

  it('モードを省略したらクイズとして扱う', () => {
    expect(nextStep({ phase: 'lobby', nextQuestionPosition: 1 })?.action).toBe('show_question');
  });
});
