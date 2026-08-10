import { describe, expect, it } from 'vitest';
import { validateQuizForPublish } from '@/domain/quiz/publish-validation';
import type { PublishValidationResult } from '@/domain/quiz/publish-validation';
import type { Question } from '@/domain/quiz/question';
import {
  choiceOption,
  choiceOptions,
  choiceQuestion,
  mediaRef,
  numberQuestion,
} from '../../_helpers/question-factory';

/**
 * 公開前検証（仕様書 §37.1）。
 * 司会者が「第N問: …」で原因を特定できるよう、コードと問題番号を検証する。
 */

function validate(questions: readonly Question[], title = 'テストクイズ'): PublishValidationResult {
  return validateQuizForPublish({ title, questions });
}

function codesOf(result: PublishValidationResult): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('validateQuizForPublish', () => {
  it('妥当なクイズは公開できる', () => {
    const result = validate([choiceQuestion(), numberQuestion({ id: 'question-2', position: 2 })]);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('タイトルが空なら QUIZ_TITLE_REQUIRED', () => {
    const result = validate([choiceQuestion()], '   ');

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('QUIZ_TITLE_REQUIRED');
  });

  it('問題が 0 件なら QUIZ_NO_QUESTIONS だけを返して打ち切る', () => {
    const result = validate([]);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['QUIZ_NO_QUESTIONS']);
  });

  describe('選択肢の件数', () => {
    it.each([2, 3, 4, 5])('%i 件なら通る', (count) => {
      const result = validate([choiceQuestion({ choices: choiceOptions(count) })]);

      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it.each([1, 6])('%i 件なら CHOICE_COUNT_RANGE で落ちる', (count) => {
      const result = validate([choiceQuestion({ choices: choiceOptions(count) })]);

      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('CHOICE_COUNT_RANGE');
    });

    it('件数エラーの問題番号が第N問として返る', () => {
      const result = validate([
        choiceQuestion(),
        choiceQuestion({ id: 'question-2', position: 2, choices: choiceOptions(1) }),
      ]);

      const issue = result.issues.find((i) => i.code === 'CHOICE_COUNT_RANGE');
      expect(issue?.questionPosition).toBe(2);
      expect(issue?.questionId).toBe('question-2');
      expect(issue?.message).toContain('第2問');
    });
  });

  describe('正解の個数', () => {
    it('正解 0 件なら CHOICE_CORRECT_COUNT', () => {
      const result = validate([choiceQuestion({ choices: choiceOptions(4, []) })]);

      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('CHOICE_CORRECT_COUNT');
    });

    it('正解 2 件なら CHOICE_CORRECT_COUNT', () => {
      const result = validate([choiceQuestion({ choices: choiceOptions(4, [0, 2]) })]);

      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('CHOICE_CORRECT_COUNT');
    });

    it('正解 1 件なら CHOICE_CORRECT_COUNT は出ない', () => {
      const result = validate([choiceQuestion({ choices: choiceOptions(4, [3]) })]);

      expect(codesOf(result)).not.toContain('CHOICE_CORRECT_COUNT');
    });
  });

  describe('数値問題の判定モード別 必須値', () => {
    it('exact: 正解値が無ければ NUMBER_CORRECT_VALUE_REQUIRED', () => {
      const result = validate([
        numberQuestion({ numberRule: { mode: 'exact', correctValue: '' } }),
      ]);

      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('NUMBER_CORRECT_VALUE_REQUIRED');
    });

    it('exact: 数値として解釈できない正解値も NUMBER_CORRECT_VALUE_REQUIRED', () => {
      const result = validate([
        numberQuestion({ numberRule: { mode: 'exact', correctValue: '約3776' } }),
      ]);

      expect(codesOf(result)).toContain('NUMBER_CORRECT_VALUE_REQUIRED');
    });

    it('absolute_tolerance: 正解値と許容誤差の両方が必要', () => {
      const missingBoth = validate([
        numberQuestion({
          numberRule: { mode: 'absolute_tolerance', correctValue: '', tolerance: '' },
        }),
      ]);
      expect(codesOf(missingBoth)).toEqual(
        expect.arrayContaining(['NUMBER_CORRECT_VALUE_REQUIRED', 'NUMBER_TOLERANCE_REQUIRED']),
      );

      const missingTolerance = validate([
        numberQuestion({
          numberRule: { mode: 'absolute_tolerance', correctValue: '100', tolerance: '' },
        }),
      ]);
      expect(codesOf(missingTolerance)).toEqual(['NUMBER_TOLERANCE_REQUIRED']);
    });

    it('absolute_tolerance: 正しく埋まっていれば通る', () => {
      const result = validate([
        numberQuestion({
          numberRule: { mode: 'absolute_tolerance', correctValue: '100', tolerance: '2' },
        }),
      ]);

      expect(result.ok).toBe(true);
    });

    it('range: 最小値と最大値の両方が必要', () => {
      const missingMin = validate([
        numberQuestion({ numberRule: { mode: 'range', minValue: '', maxValue: '10' } }),
      ]);
      expect(codesOf(missingMin)).toEqual(['NUMBER_MIN_REQUIRED']);

      const missingMax = validate([
        numberQuestion({ numberRule: { mode: 'range', minValue: '1', maxValue: '' } }),
      ]);
      expect(codesOf(missingMax)).toEqual(['NUMBER_MAX_REQUIRED']);
    });
  });

  it('range の min > max は NUMBER_RANGE_INVALID', () => {
    const result = validate([
      numberQuestion({ numberRule: { mode: 'range', minValue: '10.5', maxValue: '9.5' } }),
    ]);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('NUMBER_RANGE_INVALID');
  });

  it('range の min === max は許可する（両端を含む判定のため）', () => {
    const result = validate([
      numberQuestion({ numberRule: { mode: 'range', minValue: '10', maxValue: '10' } }),
    ]);

    expect(result.ok).toBe(true);
  });

  it('tolerance が負値なら NUMBER_TOLERANCE_NEGATIVE', () => {
    const result = validate([
      numberQuestion({
        numberRule: { mode: 'absolute_tolerance', correctValue: '100', tolerance: '-1' },
      }),
    ]);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('NUMBER_TOLERANCE_NEGATIVE');
  });

  it('tolerance が 0 なら通る（完全一致と同義）', () => {
    const result = validate([
      numberQuestion({
        numberRule: { mode: 'absolute_tolerance', correctValue: '100', tolerance: '0' },
      }),
    ]);

    expect(result.ok).toBe(true);
  });

  it('画像のみの選択肢は代替テキストが必須', () => {
    const result = validate([
      choiceQuestion({
        choices: [
          choiceOption(1, { isCorrect: true, text: null, image: mediaRef({ alt: '' }) }),
          choiceOption(2),
        ],
      }),
    ]);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('CHOICE_IMAGE_ALT_REQUIRED');
    // 画像があるので「文章または画像が必要」は出ない。
    expect(codesOf(result)).not.toContain('CHOICE_CONTENT_REQUIRED');
  });

  it('画像のみの選択肢でも代替テキストがあれば通る', () => {
    const result = validate([
      choiceQuestion({
        choices: [
          choiceOption(1, { isCorrect: true, text: null, image: mediaRef({ alt: '赤いりんご' }) }),
          choiceOption(2),
        ],
      }),
    ]);

    expect(result.ok).toBe(true);
  });

  it('文章も画像も無い選択肢は CHOICE_CONTENT_REQUIRED', () => {
    const result = validate([
      choiceQuestion({
        choices: [choiceOption(1, { isCorrect: true, text: '  ' }), choiceOption(2)],
      }),
    ]);

    expect(codesOf(result)).toContain('CHOICE_CONTENT_REQUIRED');
  });

  it('問題文も問題画像も無ければ QUESTION_CONTENT_REQUIRED', () => {
    const result = validate([choiceQuestion({ text: null, image: null })]);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('QUESTION_CONTENT_REQUIRED');
  });

  it('問題文が空白のみでも画像があれば通る', () => {
    const result = validate([choiceQuestion({ text: '   ', image: mediaRef() })]);

    expect(result.ok).toBe(true);
  });

  it('問題画像・正解画像の代替テキストが必須', () => {
    const result = validate([
      choiceQuestion({
        image: mediaRef({ alt: '' }),
        revealImage: mediaRef({ alt: '   ' }),
      }),
    ]);

    expect(codesOf(result)).toEqual(
      expect.arrayContaining(['QUESTION_IMAGE_ALT_REQUIRED', 'REVEAL_IMAGE_ALT_REQUIRED']),
    );
  });

  describe('並び順', () => {
    it('問題の position が不連続なら QUIZ_POSITION_NOT_SEQUENTIAL', () => {
      const result = validate([
        choiceQuestion({ id: 'question-1', position: 1 }),
        choiceQuestion({ id: 'question-3', position: 3 }),
      ]);

      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain('QUIZ_POSITION_NOT_SEQUENTIAL');
    });

    it('問題の position が重複していても検出する', () => {
      const result = validate([
        choiceQuestion({ id: 'question-1', position: 1 }),
        choiceQuestion({ id: 'question-2', position: 1 }),
      ]);

      expect(codesOf(result)).toContain('QUIZ_POSITION_NOT_SEQUENTIAL');
    });

    it('順序が入れ替わっていても 1..N が揃っていれば通る', () => {
      const result = validate([
        choiceQuestion({ id: 'question-2', position: 2 }),
        choiceQuestion({ id: 'question-1', position: 1 }),
      ]);

      expect(result.ok).toBe(true);
    });

    it('選択肢の position が不連続なら CHOICE_POSITION_NOT_SEQUENTIAL', () => {
      const result = validate([
        choiceQuestion({
          choices: [choiceOption(1, { isCorrect: true }), choiceOption(3)],
        }),
      ]);

      expect(codesOf(result)).toContain('CHOICE_POSITION_NOT_SEQUENTIAL');
    });
  });

  describe('数値・範囲の設定値', () => {
    it('制限時間が範囲外なら QUESTION_TIME_LIMIT_RANGE', () => {
      expect(codesOf(validate([choiceQuestion({ timeLimitSeconds: 4 })]))).toContain(
        'QUESTION_TIME_LIMIT_RANGE',
      );
      expect(codesOf(validate([choiceQuestion({ timeLimitSeconds: 181 })]))).toContain(
        'QUESTION_TIME_LIMIT_RANGE',
      );
      expect(codesOf(validate([choiceQuestion({ timeLimitSeconds: 20.5 })]))).toContain(
        'QUESTION_TIME_LIMIT_RANGE',
      );
    });

    it('配点が範囲外なら QUESTION_POINTS_RANGE', () => {
      expect(codesOf(validate([choiceQuestion({ points: -1 })]))).toContain(
        'QUESTION_POINTS_RANGE',
      );
      expect(codesOf(validate([choiceQuestion({ points: 10_001 })]))).toContain(
        'QUESTION_POINTS_RANGE',
      );
    });

    it('表示小数桁数が範囲外なら NUMBER_DECIMAL_PLACES_RANGE', () => {
      expect(codesOf(validate([numberQuestion({ decimalPlaces: 11 })]))).toContain(
        'NUMBER_DECIMAL_PLACES_RANGE',
      );
      expect(codesOf(validate([numberQuestion({ decimalPlaces: -1 })]))).toContain(
        'NUMBER_DECIMAL_PLACES_RANGE',
      );
    });

    it('単位が長すぎれば NUMBER_UNIT_TOO_LONG', () => {
      expect(codesOf(validate([numberQuestion({ unit: 'あ'.repeat(31) })]))).toContain(
        'NUMBER_UNIT_TOO_LONG',
      );
      expect(codesOf(validate([numberQuestion({ unit: 'あ'.repeat(30) })]))).not.toContain(
        'NUMBER_UNIT_TOO_LONG',
      );
    });
  });
});
