import Decimal from 'decimal.js';
import {
  CHOICE_MAX_COUNT,
  CHOICE_MIN_COUNT,
  DECIMAL_PLACES_MAX,
  DECIMAL_PLACES_MIN,
  POINTS_MAX,
  POINTS_MIN,
  TIME_LIMIT_MAX_SECONDS,
  TIME_LIMIT_MIN_SECONDS,
  UNIT_MAX_LENGTH,
  type Question,
} from '@/domain/quiz/question';
import { tryNormalizeNumberAnswer } from '@/domain/answer/number-normalizer';

/**
 * 公開前検証。
 * 司会者が「第N問: ...」で原因を特定できるメッセージを返す。
 * DB 側でも同じ検証を行い、アプリ検証だけを唯一の防波堤にしない。
 */

export type PublishIssue = {
  /** 1 始まりの問題番号。クイズ全体の問題は null。 */
  questionPosition: number | null;
  questionId: string | null;
  code: string;
  message: string;
};

export type PublishValidationInput = {
  title: string;
  questions: readonly Question[];
};

export type PublishValidationResult = {
  ok: boolean;
  issues: PublishIssue[];
};

function issue(
  position: number | null,
  questionId: string | null,
  code: string,
  message: string,
): PublishIssue {
  return { questionPosition: position, questionId, code, message };
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateQuizForPublish(input: PublishValidationInput): PublishValidationResult {
  const issues: PublishIssue[] = [];

  if (!hasText(input.title)) {
    issues.push(issue(null, null, 'QUIZ_TITLE_REQUIRED', 'クイズタイトルを入力してください'));
  }

  if (input.questions.length === 0) {
    issues.push(issue(null, null, 'QUIZ_NO_QUESTIONS', '問題を1問以上作成してください'));
    return { ok: false, issues };
  }

  const positions = input.questions.map((q) => q.position).sort((a, b) => a - b);
  positions.forEach((position, index) => {
    if (position !== index + 1) {
      issues.push(
        issue(null, null, 'QUIZ_POSITION_NOT_SEQUENTIAL', '問題の並び順が連続していません'),
      );
    }
  });

  for (const question of input.questions) {
    const at = question.position;
    const prefix = `第${at}問`;
    const qid = question.id;

    if (!hasText(question.text) && question.image === null) {
      issues.push(
        issue(
          at,
          qid,
          'QUESTION_CONTENT_REQUIRED',
          `${prefix}: 問題文または問題画像のどちらかが必要です`,
        ),
      );
    }

    if (question.image && !hasText(question.image.alt)) {
      issues.push(
        issue(at, qid, 'QUESTION_IMAGE_ALT_REQUIRED', `${prefix}: 問題画像に代替テキストが必要です`),
      );
    }

    if (question.revealImage && !hasText(question.revealImage.alt)) {
      issues.push(
        issue(
          at,
          qid,
          'REVEAL_IMAGE_ALT_REQUIRED',
          `${prefix}: 正解・解説画像に代替テキストが必要です`,
        ),
      );
    }

    if (
      !Number.isInteger(question.timeLimitSeconds) ||
      question.timeLimitSeconds < TIME_LIMIT_MIN_SECONDS ||
      question.timeLimitSeconds > TIME_LIMIT_MAX_SECONDS
    ) {
      issues.push(
        issue(
          at,
          qid,
          'QUESTION_TIME_LIMIT_RANGE',
          `${prefix}: 制限時間は${TIME_LIMIT_MIN_SECONDS}〜${TIME_LIMIT_MAX_SECONDS}秒で設定してください`,
        ),
      );
    }

    if (
      !Number.isInteger(question.points) ||
      question.points < POINTS_MIN ||
      question.points > POINTS_MAX
    ) {
      issues.push(
        issue(
          at,
          qid,
          'QUESTION_POINTS_RANGE',
          `${prefix}: 配点は${POINTS_MIN}〜${POINTS_MAX}で設定してください`,
        ),
      );
    }

    if (question.type === 'choice') {
      validateChoiceQuestion(question, issues);
    } else {
      validateNumberQuestion(question, issues);
    }
  }

  return { ok: issues.length === 0, issues };
}

function validateChoiceQuestion(
  question: Extract<Question, { type: 'choice' }>,
  issues: PublishIssue[],
): void {
  const at = question.position;
  const prefix = `第${at}問`;
  const qid = question.id;
  const choices = question.choices;

  if (choices.length < CHOICE_MIN_COUNT || choices.length > CHOICE_MAX_COUNT) {
    issues.push(
      issue(
        at,
        qid,
        'CHOICE_COUNT_RANGE',
        `${prefix}: 選択肢は${CHOICE_MIN_COUNT}〜${CHOICE_MAX_COUNT}個必要です`,
      ),
    );
  }

  const correctCount = choices.filter((c) => c.isCorrect).length;
  if (correctCount !== 1) {
    issues.push(issue(at, qid, 'CHOICE_CORRECT_COUNT', `${prefix}: 正解を1つ選択してください`));
  }

  const sortedPositions = choices.map((c) => c.position).sort((a, b) => a - b);
  sortedPositions.forEach((position, index) => {
    if (position !== index + 1) {
      issues.push(
        issue(at, qid, 'CHOICE_POSITION_NOT_SEQUENTIAL', `${prefix}: 選択肢の並び順が不正です`),
      );
    }
  });

  choices.forEach((choice) => {
    const label = String.fromCharCode('A'.charCodeAt(0) + choice.position - 1);
    if (!hasText(choice.text) && choice.image === null) {
      issues.push(
        issue(
          at,
          qid,
          'CHOICE_CONTENT_REQUIRED',
          `${prefix}: 選択肢${label}には文章または画像が必要です`,
        ),
      );
    }
    if (choice.image && !hasText(choice.image.alt)) {
      issues.push(
        issue(
          at,
          qid,
          'CHOICE_IMAGE_ALT_REQUIRED',
          `${prefix}: 画像のみの選択肢${label}には代替テキストが必要です`,
        ),
      );
    }
  });
}

function validateNumberQuestion(
  question: Extract<Question, { type: 'number' }>,
  issues: PublishIssue[],
): void {
  const at = question.position;
  const prefix = `第${at}問`;
  const qid = question.id;
  const rule = question.numberRule;

  if (
    !Number.isInteger(question.decimalPlaces) ||
    question.decimalPlaces < DECIMAL_PLACES_MIN ||
    question.decimalPlaces > DECIMAL_PLACES_MAX
  ) {
    issues.push(
      issue(
        at,
        qid,
        'NUMBER_DECIMAL_PLACES_RANGE',
        `${prefix}: 表示小数桁数は${DECIMAL_PLACES_MIN}〜${DECIMAL_PLACES_MAX}で設定してください`,
      ),
    );
  }

  if (question.unit !== null && question.unit.length > UNIT_MAX_LENGTH) {
    issues.push(
      issue(at, qid, 'NUMBER_UNIT_TOO_LONG', `${prefix}: 単位は${UNIT_MAX_LENGTH}文字以内です`),
    );
  }

  const checkValue = (value: string, code: string, message: string): Decimal | null => {
    const result = tryNormalizeNumberAnswer(value);
    if (!result.ok) {
      issues.push(issue(at, qid, code, message));
      return null;
    }
    return result.value.decimal;
  };

  switch (rule.mode) {
    case 'exact': {
      checkValue(
        rule.correctValue ?? '',
        'NUMBER_CORRECT_VALUE_REQUIRED',
        `${prefix}: 数値の正解値を入力してください`,
      );
      break;
    }
    case 'absolute_tolerance': {
      checkValue(
        rule.correctValue ?? '',
        'NUMBER_CORRECT_VALUE_REQUIRED',
        `${prefix}: 数値の正解値を入力してください`,
      );
      const tolerance = checkValue(
        rule.tolerance ?? '',
        'NUMBER_TOLERANCE_REQUIRED',
        `${prefix}: 許容誤差を入力してください`,
      );
      if (tolerance && tolerance.isNegative()) {
        issues.push(
          issue(at, qid, 'NUMBER_TOLERANCE_NEGATIVE', `${prefix}: 許容誤差は0以上にしてください`),
        );
      }
      break;
    }
    case 'range': {
      const min = checkValue(
        rule.minValue ?? '',
        'NUMBER_MIN_REQUIRED',
        `${prefix}: 最小値を入力してください`,
      );
      const max = checkValue(
        rule.maxValue ?? '',
        'NUMBER_MAX_REQUIRED',
        `${prefix}: 最大値を入力してください`,
      );
      if (min && max && min.gt(max)) {
        issues.push(
          issue(at, qid, 'NUMBER_RANGE_INVALID', `${prefix}: 最小値は最大値以下にしてください`),
        );
      }
      break;
    }
    default: {
      issues.push(issue(at, qid, 'NUMBER_MODE_REQUIRED', `${prefix}: 判定方法を選択してください`));
    }
  }
}
