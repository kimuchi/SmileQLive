import { describe, expect, it } from 'vitest';
import {
  ROOM_ACTIONS,
  ROOM_ACTION_LABELS,
  ROOM_PHASES,
  ROOM_PHASE_LABELS,
  acceptsAnswers,
  availableActions,
  canTransition,
  isRoomAction,
  isRoomPhase,
  nextPhase,
  requiresQuestionId,
  revealsAnswer,
  showsBreakdown,
  showsQuestion,
} from '@/domain/room/state-machine';
import type { RoomAction, RoomPhase } from '@/domain/room/state-machine';

/**
 * ルーム進行の状態機械（仕様書 §37.1）。
 *
 * 状態遷移は runTransaction 内で stateVersion 検証とあわせて使うため、
 * 「どの遷移が許されるか」を表として固定し、意図しない緩和を検出する。
 */

/** 各フェーズから実行できるアクション（仕様上の正）。 */
const EXPECTED_ACTIONS: Record<RoomPhase, RoomAction[]> = {
  lobby: ['show_question', 'finish_room'],
  question_ready: ['open_question'],
  question_open: ['lock_question'],
  question_locked: ['reveal_answer', 'finish_room'],
  answer_revealed: ['show_question', 'show_scoreboard', 'finish_room'],
  scoreboard: ['show_question', 'finish_room'],
  finished: [],
};

/** アクション成功後のフェーズ。 */
const EXPECTED_NEXT_PHASE: Record<RoomAction, RoomPhase> = {
  show_question: 'question_ready',
  open_question: 'question_open',
  lock_question: 'question_locked',
  reveal_answer: 'answer_revealed',
  show_scoreboard: 'scoreboard',
  finish_room: 'finished',
};

describe('canTransition（全 7 フェーズ × 全 6 アクション）', () => {
  for (const phase of ROOM_PHASES) {
    for (const action of ROOM_ACTIONS) {
      const allowed = EXPECTED_ACTIONS[phase].includes(action);
      it(`${phase} から ${action} は ${allowed ? '可' : '不可'}`, () => {
        expect(canTransition(phase, action)).toBe(allowed);
      });
    }
  }

  it('finished からはどのアクションも実行できない', () => {
    for (const action of ROOM_ACTIONS) {
      expect(canTransition('finished', action)).toBe(false);
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
});

describe('availableActions', () => {
  it.each(ROOM_PHASES)('%s のボタン一覧', (phase) => {
    expect(availableActions(phase)).toEqual(EXPECTED_ACTIONS[phase]);
  });

  it('ROOM_ACTIONS の宣言順を保つ（司会画面のボタン並びが安定する）', () => {
    const actions = availableActions('answer_revealed');
    const order = actions.map((action) => ROOM_ACTIONS.indexOf(action));

    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('返り値は canTransition と一致する', () => {
    for (const phase of ROOM_PHASES) {
      for (const action of ROOM_ACTIONS) {
        expect(availableActions(phase).includes(action)).toBe(canTransition(phase, action));
      }
    }
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

  it('showsQuestion は問題提示中のフェーズだけ', () => {
    const allowed: RoomPhase[] = [
      'question_ready',
      'question_open',
      'question_locked',
      'answer_revealed',
    ];
    for (const phase of ROOM_PHASES) {
      expect(showsQuestion(phase)).toBe(allowed.includes(phase));
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
