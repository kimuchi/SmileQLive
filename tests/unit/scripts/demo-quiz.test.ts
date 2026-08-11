import { describe, expect, it } from 'vitest';

import {
  DEMO_MEDIA,
  DEMO_QUESTIONS,
  DEMO_TITLE,
  questionsPath,
  toDomainQuestions,
} from '../../../scripts/lib/demo-quiz.mjs';
import { COLLECTIONS } from '@/types/firestore';
import { validateQuizForPublish } from '@/domain/quiz/publish-validation';
import { judgeNumberAnswerText } from '@/domain/answer/number-judgement';
import { normalizeNumberAnswer } from '@/domain/answer/number-normalizer';

/**
 * デモクイズが「そのまま公開して使える」ことを、アプリ本体の検証で確かめる。
 *
 * seed スクリプトは Admin SDK で直接書き込むため、
 * 検証を通らないクイズを作ってしまうと、会場で開いて初めて気付くことになる。
 */
const resolveMedia = (key: string) => {
  if (!(key in DEMO_MEDIA)) {
    throw new Error(`未定義の画像キー: ${key}`);
  }
  return { assetId: `asset-${key}`, url: `https://example.test/${key}.webp`, width: 1280, height: 720 };
};

describe('デモクイズ', () => {
  it('公開検証を通る', () => {
    const result = validateQuizForPublish({
      title: DEMO_TITLE,
      questions: toDomainQuestions(resolveMedia),
    });

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('選択式と数値式の両方を含み、問題型が偏っていない', () => {
    const questions = toDomainQuestions(resolveMedia);
    const choice = questions.filter((q) => q.type === 'choice');
    const number = questions.filter((q) => q.type === 'number');

    expect(choice.length).toBeGreaterThanOrEqual(3);
    expect(number.length).toBeGreaterThanOrEqual(3);

    // 選択肢の数に幅があること（2〜5 択を扱えることを示すため）。
    const counts = new Set(choice.map((q) => (q.type === 'choice' ? q.choices.length : 0)));
    expect(counts.size).toBeGreaterThanOrEqual(3);

    // 数値判定の 3 方式をすべて含むこと。
    const modes = new Set(number.map((q) => (q.type === 'number' ? q.numberRule.mode : '')));
    expect(modes).toEqual(new Set(['exact', 'absolute_tolerance', 'range']));
  });

  it('参照している画像キーがすべて定義済み', () => {
    // toDomainQuestions は未定義キーで例外を投げる。
    expect(() => toDomainQuestions(resolveMedia)).not.toThrow();
  });

  it('画像だけの選択肢には代替テキストがある', () => {
    for (const question of toDomainQuestions(resolveMedia)) {
      if (question.type !== 'choice') {
        continue;
      }
      for (const choice of question.choices) {
        if (choice.text === null) {
          expect(choice.image).not.toBeNull();
          expect(choice.image?.alt.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });

  it('数値問題の正解が、実際の判定でも正解になる', () => {
    const cases: Array<{ position: number; input: string; expected: boolean }> = [
      { position: 4, input: '47', expected: true },
      { position: 4, input: '４７', expected: true }, // 全角も正解
      { position: 4, input: '48', expected: false },
      { position: 5, input: '3776', expected: true },
      { position: 5, input: '3800', expected: true }, // 許容誤差の内側
      { position: 5, input: '3900', expected: false },
      { position: 6, input: '400', expected: true },
      { position: 6, input: '380', expected: true }, // 範囲の境界
      { position: 6, input: '431', expected: false },
    ];

    const questions = toDomainQuestions(resolveMedia);
    for (const testCase of cases) {
      const question = questions.find((q) => q.position === testCase.position);
      if (!question || question.type !== 'number') {
        throw new Error(`数値問題が見つかりません: ${testCase.position}`);
      }
      // 参加者の生入力と同じ経路を通す（全角・桁区切りの正規化を含む）。
      const normalized = normalizeNumberAnswer(testCase.input);
      const correct = judgeNumberAnswerText(normalized.normalizedText, question.numberRule);
      expect(
        correct,
        `第${testCase.position}問 "${testCase.input}" は ${testCase.expected ? '正解' : '不正解'} のはず`,
      ).toBe(testCase.expected);
    }
  });

  it('問題の保存先がアプリ側と一致している', () => {
    // questions はトップレベルではなく quizzes/{quizId} のサブコレクション
    // （src/infrastructure/firebase/paths.ts の questionsCollection）。
    // ここがずれるとクイズは一覧に出るのに中身が 0 問になり、
    // ルーム作成が「問題を1問以上作成してください」で止まる。
    expect(questionsPath('QUIZ')).toEqual([COLLECTIONS.quizzes, 'QUIZ', COLLECTIONS.questions]);
  });

  it('解説文が正解を説明している（空でない）', () => {
    for (const question of DEMO_QUESTIONS) {
      expect(question.explanation?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
