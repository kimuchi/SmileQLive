import { describeNumberRule } from '@/domain/answer/number-judgement';
import { tryNormalizeNumberAnswer } from '@/domain/answer/number-normalizer';
import {
  CHOICE_MAX_COUNT,
  CHOICE_MIN_COUNT,
  DECIMAL_PLACES_MAX,
  DECIMAL_PLACES_MIN,
  DEFAULT_POINTS,
  DEFAULT_TIME_LIMIT_SECONDS,
  POINTS_MAX,
  POINTS_MIN,
  TIME_LIMIT_MAX_SECONDS,
  TIME_LIMIT_MIN_SECONDS,
  UNIT_MAX_LENGTH,
  choiceLabelFor,
  type NumberJudgementMode,
  type NumberRule,
  type QuestionType,
} from '@/domain/quiz/question';
import type { CreateQuestionInput, UpdateQuestionInput } from '@/lib/validation/schemas';
import type { AdminChoice, AdminMediaRef, AdminQuestion } from '@/types/api';

/**
 * 問題編集フォームの下書き。
 *
 * 重要:
 * - 数値（正解値・許容誤差・範囲・制限時間・配点・小数桁数）はすべて **文字列**で保持する。
 *   入力途中の「-」「1.」などを勝手に消さないため、および
 *   数値の判定条件を JavaScript の number へ通さないため。
 * - 検証は保存の直前に行う。検証に失敗しても入力は消さない。
 * - 選択肢ラベル A〜E は position から導出し、下書きにも DB にも保存しない。
 */

export const QUESTION_TEXT_MAX_LENGTH = 1000;
export const CHOICE_TEXT_MAX_LENGTH = 300;
export const EXPLANATION_TEXT_MAX_LENGTH = 1000;
export const ALT_TEXT_MAX_LENGTH = 120;

export type ChoiceDraft = {
  /** 既存の選択肢 ID。並べ替えても維持する。 */
  id: string;
  text: string;
  image: AdminMediaRef | null;
  imageAlt: string;
  isCorrect: boolean;
};

export type QuestionDraft = {
  id: string;
  position: number;
  type: QuestionType;
  text: string;
  image: AdminMediaRef | null;
  imageAlt: string;
  revealImage: AdminMediaRef | null;
  revealImageAlt: string;
  explanation: string;
  timeLimitSeconds: string;
  points: string;
  choices: ChoiceDraft[];
  numberMode: NumberJudgementMode;
  numberCorrectValue: string;
  numberTolerance: string;
  numberMinValue: string;
  numberMaxValue: string;
  unit: string;
  decimalPlaces: string;
};

export type QuestionDraftErrors = {
  timeLimitSeconds?: string;
  points?: string;
  unit?: string;
  decimalPlaces?: string;
  numberCorrectValue?: string;
  numberTolerance?: string;
  numberMinValue?: string;
  numberMaxValue?: string;
  choices?: string;
};

/** 選択肢の表示ラベル（position 由来。保存しない）。 */
export function labelForIndex(index: number): string {
  return choiceLabelFor(index + 1);
}

function toChoiceDraft(choice: AdminChoice): ChoiceDraft {
  return {
    id: choice.id,
    text: choice.text ?? '',
    image: choice.image,
    imageAlt: choice.image?.alt ?? '',
    isCorrect: choice.isCorrect,
  };
}

export function toQuestionDraft(question: AdminQuestion): QuestionDraft {
  return {
    id: question.id,
    position: question.position,
    type: question.type,
    text: question.text ?? '',
    image: question.image,
    imageAlt: question.image?.alt ?? '',
    revealImage: question.revealImage,
    revealImageAlt: question.revealImage?.alt ?? '',
    explanation: question.explanation ?? '',
    timeLimitSeconds: String(question.timeLimitSeconds),
    points: String(question.points),
    choices: [...question.choices].sort((a, b) => a.position - b.position).map(toChoiceDraft),
    numberMode: question.numberMode ?? 'exact',
    numberCorrectValue: question.numberCorrectValue ?? '',
    numberTolerance: question.numberTolerance ?? '',
    numberMinValue: question.numberMinValue ?? '',
    numberMaxValue: question.numberMaxValue ?? '',
    unit: question.unit ?? '',
    decimalPlaces: String(question.decimalPlaces),
  };
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function parseIntegerField(
  value: string,
  min: number,
  max: number,
  message: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const normalized = value.normalize('NFKC').trim();
  if (!/^-?\d+$/.test(normalized)) {
    return { ok: false, message };
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, message };
  }
  return { ok: true, value: parsed };
}

/** 数値条件の 1 項目を検証する。判定は decimal.js を通す（number へ落とさない）。 */
function parseNumberField(
  value: string,
  emptyMessage: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (value.trim().length === 0) {
    return { ok: false, message: emptyMessage };
  }
  const result = tryNormalizeNumberAnswer(value);
  if (!result.ok) {
    switch (result.code) {
      case 'NUMBER_TOO_LARGE':
        return { ok: false, message: '入力できる桁数を超えています' };
      case 'NUMBER_TOO_MANY_DECIMALS':
        return { ok: false, message: '小数点以下は10桁までです' };
      default:
        return { ok: false, message: '数値だけを入力してください' };
    }
  }
  return { ok: true, value: result.value.normalizedText };
}

/** 下書きから数値条件を組み立てる。未入力・不正なら errors を返す。 */
function buildNumberRule(
  draft: QuestionDraft,
): { ok: true; rule: NumberRule } | { ok: false; errors: QuestionDraftErrors } {
  if (draft.numberMode === 'range') {
    const min = parseNumberField(draft.numberMinValue, '最小値を入力してください');
    const max = parseNumberField(draft.numberMaxValue, '最大値を入力してください');
    const errors: QuestionDraftErrors = {};
    if (!min.ok) {
      errors.numberMinValue = min.message;
    }
    if (!max.ok) {
      errors.numberMaxValue = max.message;
    }
    if (!min.ok || !max.ok) {
      return { ok: false, errors };
    }
    const minDecimal = tryNormalizeNumberAnswer(min.value);
    const maxDecimal = tryNormalizeNumberAnswer(max.value);
    if (minDecimal.ok && maxDecimal.ok && minDecimal.value.decimal.gt(maxDecimal.value.decimal)) {
      return { ok: false, errors: { numberMinValue: '最小値は最大値以下にしてください' } };
    }
    return { ok: true, rule: { mode: 'range', minValue: min.value, maxValue: max.value } };
  }

  const correct = parseNumberField(draft.numberCorrectValue, '正解値を入力してください');
  if (draft.numberMode === 'exact') {
    if (!correct.ok) {
      return { ok: false, errors: { numberCorrectValue: correct.message } };
    }
    return { ok: true, rule: { mode: 'exact', correctValue: correct.value } };
  }

  const tolerance = parseNumberField(draft.numberTolerance, '許容誤差を入力してください');
  const errors: QuestionDraftErrors = {};
  if (!correct.ok) {
    errors.numberCorrectValue = correct.message;
  }
  if (!tolerance.ok) {
    errors.numberTolerance = tolerance.message;
  }
  if (!correct.ok || !tolerance.ok) {
    return { ok: false, errors };
  }
  const toleranceDecimal = tryNormalizeNumberAnswer(tolerance.value);
  if (toleranceDecimal.ok && toleranceDecimal.value.decimal.isNegative()) {
    return { ok: false, errors: { numberTolerance: '許容誤差は0以上にしてください' } };
  }
  return {
    ok: true,
    rule: {
      mode: 'absolute_tolerance',
      correctValue: correct.value,
      tolerance: tolerance.value,
    },
  };
}

export type BuildPayloadResult =
  | { ok: true; payload: UpdateQuestionInput }
  | { ok: false; errors: QuestionDraftErrors };

/** 保存用ペイロードを組み立てる。検証に落ちたら保存しない（入力は保持する）。 */
export function buildQuestionPayload(draft: QuestionDraft): BuildPayloadResult {
  const errors: QuestionDraftErrors = {};

  const timeLimit = parseIntegerField(
    draft.timeLimitSeconds,
    TIME_LIMIT_MIN_SECONDS,
    TIME_LIMIT_MAX_SECONDS,
    `制限時間は${TIME_LIMIT_MIN_SECONDS}〜${TIME_LIMIT_MAX_SECONDS}秒で入力してください`,
  );
  if (!timeLimit.ok) {
    errors.timeLimitSeconds = timeLimit.message;
  }

  const points = parseIntegerField(
    draft.points,
    POINTS_MIN,
    POINTS_MAX,
    `配点は${POINTS_MIN}〜${POINTS_MAX}で入力してください`,
  );
  if (!points.ok) {
    errors.points = points.message;
  }

  const common = {
    text: textOrNull(draft.text),
    imageAssetId: draft.image?.assetId ?? null,
    imageAlt: draft.image ? textOrNull(draft.imageAlt) : null,
    revealImageAssetId: draft.revealImage?.assetId ?? null,
    revealImageAlt: draft.revealImage ? textOrNull(draft.revealImageAlt) : null,
    explanation: textOrNull(draft.explanation),
  };

  if (draft.type === 'choice') {
    if (draft.choices.length < CHOICE_MIN_COUNT || draft.choices.length > CHOICE_MAX_COUNT) {
      errors.choices = `選択肢は${CHOICE_MIN_COUNT}〜${CHOICE_MAX_COUNT}個必要です`;
    }
    if (!timeLimit.ok || !points.ok || errors.choices !== undefined) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      payload: {
        type: 'choice',
        ...common,
        timeLimitSeconds: timeLimit.value,
        points: points.value,
        choices: draft.choices.map((choice, index) => ({
          id: choice.id,
          position: index + 1,
          text: textOrNull(choice.text),
          imageAssetId: choice.image?.assetId ?? null,
          imageAlt: choice.image ? textOrNull(choice.imageAlt) : null,
          isCorrect: choice.isCorrect,
        })),
      },
    };
  }

  const decimalPlaces = parseIntegerField(
    draft.decimalPlaces,
    DECIMAL_PLACES_MIN,
    DECIMAL_PLACES_MAX,
    `表示小数桁数は${DECIMAL_PLACES_MIN}〜${DECIMAL_PLACES_MAX}で入力してください`,
  );
  if (!decimalPlaces.ok) {
    errors.decimalPlaces = decimalPlaces.message;
  }
  if (draft.unit.length > UNIT_MAX_LENGTH) {
    errors.unit = `単位は${UNIT_MAX_LENGTH}文字以内です`;
  }

  const rule = buildNumberRule(draft);
  if (!rule.ok) {
    Object.assign(errors, rule.errors);
  }

  if (!timeLimit.ok || !points.ok || !decimalPlaces.ok || !rule.ok || errors.unit !== undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    payload: {
      type: 'number',
      ...common,
      timeLimitSeconds: timeLimit.value,
      points: points.value,
      numberRule: rule.rule,
      unit: textOrNull(draft.unit),
      decimalPlaces: decimalPlaces.value,
    },
  };
}

/** 正解の表示プレビュー。条件が未完成なら null。 */
export function numberRulePreview(draft: QuestionDraft): string | null {
  if (draft.type !== 'number') {
    return null;
  }
  const rule = buildNumberRule(draft);
  if (!rule.ok) {
    return null;
  }
  const decimalPlaces = parseIntegerField(
    draft.decimalPlaces,
    DECIMAL_PLACES_MIN,
    DECIMAL_PLACES_MAX,
    '',
  );
  if (!decimalPlaces.ok) {
    return null;
  }
  try {
    return describeNumberRule(rule.rule, decimalPlaces.value, textOrNull(draft.unit));
  } catch {
    return null;
  }
}

/** 回答形式を切り替えるときの初期ペイロード。切り替え前の共通項目は引き継ぐ。 */
export function buildTypeSwitchPayload(
  draft: QuestionDraft,
  nextType: QuestionType,
): UpdateQuestionInput {
  const timeLimit = parseIntegerField(
    draft.timeLimitSeconds,
    TIME_LIMIT_MIN_SECONDS,
    TIME_LIMIT_MAX_SECONDS,
    '',
  );
  const points = parseIntegerField(draft.points, POINTS_MIN, POINTS_MAX, '');

  const common = {
    text: textOrNull(draft.text),
    imageAssetId: draft.image?.assetId ?? null,
    imageAlt: draft.image ? textOrNull(draft.imageAlt) : null,
    revealImageAssetId: draft.revealImage?.assetId ?? null,
    revealImageAlt: draft.revealImage ? textOrNull(draft.revealImageAlt) : null,
    explanation: textOrNull(draft.explanation),
    timeLimitSeconds: timeLimit.ok ? timeLimit.value : DEFAULT_TIME_LIMIT_SECONDS,
    points: points.ok ? points.value : DEFAULT_POINTS,
  };

  if (nextType === 'choice') {
    return {
      type: 'choice',
      ...common,
      choices: Array.from({ length: CHOICE_MIN_COUNT }, (_unused, index) => ({
        position: index + 1,
        text: `選択肢${choiceLabelFor(index + 1)}`,
        imageAssetId: null,
        imageAlt: null,
        isCorrect: index === 0,
      })),
    };
  }

  return {
    type: 'number',
    ...common,
    // 数値式へ切り替えた直後は暫定値を入れ、司会者が上書きする。
    numberRule: { mode: 'exact', correctValue: '0' },
    unit: null,
    decimalPlaces: 0,
  };
}

/** 問題の複製ペイロード（新しい ID で作り直すため choice.id は渡さない）。 */
export function buildDuplicatePayload(question: AdminQuestion): CreateQuestionInput {
  const common = {
    text: question.text,
    imageAssetId: question.image?.assetId ?? null,
    imageAlt: question.image?.alt ?? null,
    revealImageAssetId: question.revealImage?.assetId ?? null,
    revealImageAlt: question.revealImage?.alt ?? null,
    explanation: question.explanation,
    timeLimitSeconds: question.timeLimitSeconds,
    points: question.points,
  };

  if (question.type === 'choice') {
    return {
      type: 'choice',
      ...common,
      choices: [...question.choices]
        .sort((a, b) => a.position - b.position)
        .map((choice, index) => ({
          position: index + 1,
          text: choice.text,
          imageAssetId: choice.image?.assetId ?? null,
          imageAlt: choice.image?.alt ?? null,
          isCorrect: choice.isCorrect,
        })),
    };
  }

  const mode: NumberJudgementMode = question.numberMode ?? 'exact';
  const rule: NumberRule =
    mode === 'range'
      ? {
          mode: 'range',
          minValue: question.numberMinValue ?? '0',
          maxValue: question.numberMaxValue ?? '0',
        }
      : mode === 'absolute_tolerance'
        ? {
            mode: 'absolute_tolerance',
            correctValue: question.numberCorrectValue ?? '0',
            tolerance: question.numberTolerance ?? '0',
          }
        : { mode: 'exact', correctValue: question.numberCorrectValue ?? '0' };

  return {
    type: 'number',
    ...common,
    numberRule: rule,
    unit: question.unit,
    decimalPlaces: question.decimalPlaces,
  };
}
