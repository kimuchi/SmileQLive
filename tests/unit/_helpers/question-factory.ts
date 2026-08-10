import {
  DEFAULT_POINTS,
  DEFAULT_TIME_LIMIT_SECONDS,
  type ChoiceOption,
  type ChoicePosition,
  type ChoiceQuestion,
  type MediaRef,
  type NumberQuestion,
} from '@/domain/quiz/question';

/**
 * テスト用の問題ファクトリ。
 *
 * ドメイン層はバックエンド非依存なので、Firestore / Supabase いずれにも依存しない
 * 素のオブジェクトだけを組み立てる。
 */

export function mediaRef(overrides: Partial<MediaRef> = {}): MediaRef {
  return {
    assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    url: 'https://media.example.com/owner-1/quiz-1/asset-1.webp',
    alt: '問題画像の説明',
    width: 1200,
    height: 800,
    ...overrides,
  };
}

/**
 * 選択肢。position は 1〜5 が正当だが、
 * 「6 件で公開検証が落ちること」を確認するため範囲外も組み立てられるようにしている。
 */
export function choiceOption(
  position: number,
  overrides: Partial<ChoiceOption> = {},
): ChoiceOption {
  return {
    id: `choice-${position}`,
    position: position as ChoicePosition,
    text: `選択肢${position}`,
    image: null,
    isCorrect: false,
    ...overrides,
  };
}

/** position 1..count の選択肢を作り、correctIndex（0 始まり）だけ正解にする。 */
export function choiceOptions(
  count: number,
  correctIndexes: readonly number[] = [0],
): ChoiceOption[] {
  return Array.from({ length: count }, (_unused, index) =>
    choiceOption(index + 1, { isCorrect: correctIndexes.includes(index) }),
  );
}

export function choiceQuestion(
  overrides: Partial<Omit<ChoiceQuestion, 'type'>> = {},
): ChoiceQuestion {
  return {
    id: 'question-1',
    type: 'choice',
    position: 1,
    text: '日本で一番高い山はどれ？',
    image: null,
    revealImage: null,
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    points: DEFAULT_POINTS,
    explanation: null,
    choices: choiceOptions(4),
    ...overrides,
  };
}

export function numberQuestion(
  overrides: Partial<Omit<NumberQuestion, 'type'>> = {},
): NumberQuestion {
  return {
    id: 'question-1',
    type: 'number',
    position: 1,
    text: '富士山の標高は何メートル？',
    image: null,
    revealImage: null,
    timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
    points: DEFAULT_POINTS,
    explanation: null,
    numberRule: { mode: 'exact', correctValue: '3776' },
    unit: 'm',
    decimalPlaces: 0,
    ...overrides,
  };
}
