// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStageSoundCues } from '@/components/presentation/use-projector-audio';
import type { RoomPhase } from '@/domain/room/state-machine';

/**
 * 投影画面で「いつ鳴らすか」。
 *
 * 会場では鳴らしすぎるほうが事故になる。ここでは次を固定する。
 * - 画面を開いた直後は鳴らさない（進行中の部屋へ後から繋いでも、いきなり正解音を出さない）
 * - **フェーズが変わったときだけ**鳴らす。回答時間を延長しても出題音は鳴らさない
 * - 残り 5〜0 秒の合図は 1 秒に 1 回だけ
 */

type Args = Parameters<typeof useStageSoundCues>[0];

function setup(initial: Partial<Args> = {}) {
  const play = vi.fn();
  const base: Args = {
    play,
    phase: 'lobby',
    stateVersion: 1,
    remainingSeconds: 0,
    hasDeadline: false,
    ...initial,
  };
  const view = renderHook((props: Args) => useStageSoundCues(props), { initialProps: base });
  return { play, view, base };
}

/** 鳴った音の名前だけを取り出す。 */
function playedSounds(play: ReturnType<typeof vi.fn>): string[] {
  return play.mock.calls.map((call) => String(call[0]));
}

describe('投影画面の効果音を鳴らす場面', () => {
  it('開いた直後の状態では鳴らさない', () => {
    const { play } = setup({ phase: 'answer_revealed', stateVersion: 9 });
    expect(play).not.toHaveBeenCalled();
  });

  it('フェーズが進んだら鳴らす', () => {
    const { play, view, base } = setup({ phase: 'question_ready', stateVersion: 3 });
    view.rerender({ ...base, phase: 'question_open', stateVersion: 4 });

    expect(playedSounds(play)).toEqual(['question-start']);
  });

  it('回答時間を延長しても出題音は鳴らさない', () => {
    // 延長すると状態番号だけが増え、フェーズは question_open のまま。
    const { play, view, base } = setup({ phase: 'question_ready', stateVersion: 3 });
    view.rerender({ ...base, phase: 'question_open', stateVersion: 4 });
    play.mockClear();

    view.rerender({ ...base, phase: 'question_open', stateVersion: 5 });
    view.rerender({ ...base, phase: 'question_open', stateVersion: 6 });

    expect(play).not.toHaveBeenCalled();
  });

  it('ランキングではためる音だけを鳴らす（発表音は表示に合わせて別に鳴らす）', () => {
    const { play, view, base } = setup({ phase: 'answer_revealed', stateVersion: 7 });
    view.rerender({ ...base, phase: 'scoreboard', stateVersion: 8 });

    expect(playedSounds(play)).toEqual(['ranking']);
    expect(playedSounds(play)).not.toContain('fanfare');
  });

  it('一連の進行で、各フェーズの音が 1 回ずつ鳴る', () => {
    const { play, view, base } = setup({ phase: 'lobby', stateVersion: 1 });
    const steps: RoomPhase[] = [
      'question_ready',
      'question_open',
      'question_locked',
      'answer_revealed',
      'scoreboard',
      'finished',
    ];
    steps.forEach((phase, index) => {
      view.rerender({ ...base, phase, stateVersion: index + 2 });
    });

    expect(playedSounds(play)).toEqual([
      'question-start',
      'answer-lock',
      'answer-reveal',
      'ranking',
      'finish',
    ]);
  });

  it('残り 5〜0 秒で 1 回ずつ鳴る', () => {
    const { play, view, base } = setup({
      phase: 'question_open',
      stateVersion: 4,
      hasDeadline: true,
      remainingSeconds: 8,
    });

    for (const remainingSeconds of [7, 6, 5, 5, 4, 4, 3, 2, 1, 0]) {
      view.rerender({
        ...base,
        phase: 'question_open',
        stateVersion: 4,
        hasDeadline: true,
        remainingSeconds,
      });
    }

    expect(playedSounds(play)).toEqual(['tick', 'tick', 'tick', 'tick', 'tick', 'tick']);
  });
});
