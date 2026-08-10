/**
 * 問題ドメインの共通型。
 *
 * 重要:
 * - `question_type` は判別可能 union (`type` フィールド) として扱う。
 * - 数値はすべて文字列で保持し、判定時に `decimal.js` / PostgreSQL `numeric` へ渡す。
 *   JavaScript の `number` へ暗黙変換しない。
 */

export const QUESTION_TYPES = ['choice', 'number'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const NUMBER_JUDGEMENT_MODES = ['exact', 'absolute_tolerance', 'range'] as const;
export type NumberJudgementMode = (typeof NUMBER_JUDGEMENT_MODES)[number];

export const CHOICE_MIN_COUNT = 2;
export const CHOICE_MAX_COUNT = 5;

export const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export type ChoiceLabel = (typeof CHOICE_LABELS)[number];
export type ChoicePosition = 1 | 2 | 3 | 4 | 5;

export const TIME_LIMIT_MIN_SECONDS = 5;
export const TIME_LIMIT_MAX_SECONDS = 180;
export const DEFAULT_TIME_LIMIT_SECONDS = 20;

export const POINTS_MIN = 0;
export const POINTS_MAX = 10_000;
export const DEFAULT_POINTS = 1000;

export const DECIMAL_PLACES_MIN = 0;
export const DECIMAL_PLACES_MAX = 10;

export const UNIT_MAX_LENGTH = 30;
export const IMAGE_ALT_MAX_LENGTH = 120;
export const EXPLANATION_MAX_LENGTH = 1000;

/** 画像参照。URL は配信時に解決するため、ドメイン層では識別子と代替テキストだけ保持する。 */
export type MediaRef = {
  assetId: string;
  /** 配信用 URL。スナップショット生成時に解決して埋め込む。 */
  url: string;
  alt: string;
  width: number;
  height: number;
};

export type QuestionBase = {
  id: string;
  position: number;
  text: string | null;
  image: MediaRef | null;
  revealImage: MediaRef | null;
  timeLimitSeconds: number;
  points: number;
  explanation: string | null;
};

export type ChoiceOption = {
  id: string;
  position: ChoicePosition;
  text: string | null;
  image: MediaRef | null;
  isCorrect: boolean;
};

export type ChoiceQuestion = QuestionBase & {
  type: 'choice';
  choices: ChoiceOption[];
};

export type NumberRule =
  | { mode: 'exact'; correctValue: string }
  | { mode: 'absolute_tolerance'; correctValue: string; tolerance: string }
  | { mode: 'range'; minValue: string; maxValue: string };

export type NumberQuestion = QuestionBase & {
  type: 'number';
  numberRule: NumberRule;
  unit: string | null;
  decimalPlaces: number;
};

export type Question = ChoiceQuestion | NumberQuestion;

export function isChoiceQuestion(question: Question): question is ChoiceQuestion {
  return question.type === 'choice';
}

export function isNumberQuestion(question: Question): question is NumberQuestion {
  return question.type === 'number';
}

/** position (1-5) から表示ラベル A-E を導出する。DB へラベル文字列を保存しない。 */
export function choiceLabelFor(position: number): ChoiceLabel {
  const label = CHOICE_LABELS[position - 1];
  if (!label) {
    throw new Error(`INVALID_CHOICE_POSITION: ${position}`);
  }
  return label;
}

export function isChoicePosition(value: number): value is ChoicePosition {
  return Number.isInteger(value) && value >= CHOICE_MIN_COUNT - 1 && value <= CHOICE_MAX_COUNT;
}
