// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuestionStage } from '@/components/presentation/QuestionStage';
import type { PublicQuestion } from '@/domain/quiz/public-question';

/**
 * 写真つき問題の置き方。
 *
 * 会場の投影は 16:9。見出し・選択肢・残り時間と縦に積むと、
 * 写真は画面高の 15% ほどにしかならず、写真を見て答えるクイズが成立しない
 * （実測で 1920x1080 のとき 155px しか出ていなかった）。
 * 写真と回答欄を**左右**に並べることで、同じ余白のまま 3 倍以上の高さで出す。
 *
 * jsdom は寸法を計算しないため、ここでは「どう並べる指定になっているか」を見る。
 * 実寸は投影画面の実ブラウザ計測で確かめている。
 */

const image = { url: 'https://example.test/photo.jpg', alt: '塔の写真', width: 1600, height: 1200 };

function choiceQuestion(overrides: Partial<Extract<PublicQuestion, { type: 'choice' }>> = {}) {
  return {
    id: 'q1',
    type: 'choice',
    position: 1,
    points: 10,
    text: 'この塔の名前は？',
    image: null,
    timeLimitSeconds: 20,
    choices: [
      { id: 'c1', position: 1, label: 'A', text: '東京タワー', image: null },
      { id: 'c2', position: 2, label: 'B', text: '通天閣', image: null },
    ],
    ...overrides,
  } as Extract<PublicQuestion, { type: 'choice' }>;
}

function renderStage(question: PublicQuestion) {
  return render(
    <QuestionStage
      question={question}
      phase="question_open"
      questionPosition={1}
      totalQuestions={5}
      showTotalQuestions
      remainingSeconds={12}
      remainingMs={12_000}
      answeredCount={3}
      participantCount={10}
    />,
  );
}

/** 2 つの要素の最も近い共通の親。 */
function commonAncestor(a: Element, b: Element): Element | null {
  let node: Element | null = a.parentElement;
  while (node) {
    if (node.contains(b)) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

describe('写真つき問題の投影', () => {
  it('写真と回答欄を左右に並べる（縦に積まない）', () => {
    const { container } = renderStage(choiceQuestion({ image }));

    const photo = container.querySelector('img');
    const choices = container.querySelector('ul');
    expect(photo).not.toBeNull();
    expect(choices).not.toBeNull();

    const shared = commonAncestor(photo!, choices!);
    expect(shared).not.toBeNull();
    // 縦積み (flex-col) に戻すと写真が潰れる。
    expect(shared!.className).toContain('flex-row');
    expect(shared!.className).not.toContain('flex-col');
  });

  it('写真の高さ上限を、行の高さより十分に大きく取る', () => {
    // 上限が低いと、左右に並べても上限のほうが先に効いて写真が小さいままになる。
    // 実測では行の高さが画面高の 45% 前後になるため、上限はそれを上回っている必要がある。
    const { container } = renderStage(choiceQuestion({ image }));

    const photo = container.querySelector('img');
    const maxHeight = photo?.style.maxHeight ?? '';
    const cqw = Number.parseFloat(maxHeight);

    expect(maxHeight).toMatch(/cqw$/);
    // cqw は「ステージ幅に対する割合」。1920x1080 なので画面高 = 幅の 56.25%。
    const ratioOfHeight = cqw / 100 / (1080 / 1920);
    expect(ratioOfHeight).toBeGreaterThan(0.5);
  });

  it('写真が無い問題は今まで通り縦に積む（選択肢に幅をすべて使う）', () => {
    const { container } = renderStage(choiceQuestion());

    expect(container.querySelector('img')).toBeNull();
    const choices = container.querySelector('ul');
    expect(choices).not.toBeNull();
    // 左右分割用の行は作らない。
    expect(container.querySelector('.flex-row')).toBeNull();
  });

  it('数値問題でも写真を左右に並べる', () => {
    const question: PublicQuestion = {
      id: 'q2',
      type: 'number',
      position: 2,
      points: 10,
      text: 'この建物の高さは？',
      image,
      timeLimitSeconds: 30,
      unit: 'm',
      decimalPlaces: 0,
    };

    const { getByText, container } = renderStage(question);

    const photo = container.querySelector('img');
    const panel = getByText('数値で回答してください');
    expect(photo).not.toBeNull();
    const shared = commonAncestor(photo!, panel);
    expect(shared!.className).toContain('flex-row');
  });
});
