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
 * - タイマー音は回答受付の間ずっと鳴らす（残り秒数で出し分けない）
 */

type Args = Parameters<typeof useStageSoundCues>[0];

function setup(initial: Partial<Args> = {}) {
  const play = vi.fn();
  const startLoop = vi.fn();
  const stopLoop = vi.fn();
  const base: Args = {
    play,
    startLoop,
    stopLoop,
    // 既定では「投影を開始」を押し済みとして扱う。
    isUnlocked: true,
    phase: 'lobby',
    stateVersion: 1,
    ...initial,
  };
  const view = renderHook((props: Args) => useStageSoundCues(props), { initialProps: base });
  return { play, startLoop, stopLoop, view, base };
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

  it('回答受付の間ずっとタイマー音を鳴らす', () => {
    // 残りわずかのときだけ鳴らす作りだと、「あと何秒か」が音から分からない。
    const { startLoop, stopLoop, view, base } = setup({ phase: 'question_ready', stateVersion: 3 });
    expect(startLoop).not.toHaveBeenCalled();

    view.rerender({ ...base, phase: 'question_open', stateVersion: 4 });
    expect(startLoop).toHaveBeenCalledWith('tick');

    stopLoop.mockClear();
    view.rerender({ ...base, phase: 'question_locked', stateVersion: 5 });
    expect(stopLoop).toHaveBeenCalledWith('tick');
  });

  it('出題中に投影画面を開いた場合、開始操作のあとからタイマー音を鳴らす', () => {
    // 「投影を開始」を押す前は音を鳴らせない。そこで諦めると、押したあとも
    // 鳴り始めず、その問題は最後まで無音になる。実際にその作りになっていた。
    const { startLoop, view, base } = setup({
      isUnlocked: false,
      phase: 'question_open',
      stateVersion: 4,
    });
    expect(startLoop).not.toHaveBeenCalled();

    view.rerender({ ...base, isUnlocked: true, phase: 'question_open', stateVersion: 4 });

    expect(startLoop).toHaveBeenCalledWith('tick');
  });

  it('延長してもタイマー音を鳴らし直さない', () => {
    const { startLoop, view, base } = setup({ phase: 'question_ready', stateVersion: 3 });
    view.rerender({ ...base, phase: 'question_open', stateVersion: 4 });
    startLoop.mockClear();

    // 延長（状態番号だけ増える）。鳴らし続けているものを止めたり鳴らし直したりしない。
    view.rerender({ ...base, phase: 'question_open', stateVersion: 5 });

    expect(startLoop).not.toHaveBeenCalled();
  });
});
