import { describe, expect, it } from 'vitest';
import { toPublicQuestion } from '@/domain/quiz/public-question';
import { CHOICE_LABELS, choiceLabelFor } from '@/domain/quiz/question';
import type { ChoiceQuestion, NumberQuestion } from '@/domain/quiz/question';
import {
  choiceOption,
  choiceQuestion,
  mediaRef,
  numberQuestion,
} from '../../_helpers/question-factory';

/**
 * 最重要の回帰防止テスト（仕様書 §37.1）。
 *
 * toPublicQuestion() は参加者・投影画面へ渡す唯一の入口であり、
 * 正解・解説・正解画像が 1 バイトでも漏れてはならない。
 * プロパティ単位の検査だけでは将来のフィールド追加を取りこぼすため、
 * JSON.stringify した文字列そのものに対しても検査する。
 */

/** 秘匿対象であることが一目で分かるマーカー。公開 DTO に現れてはならない。 */
const SECRET_EXPLANATION = 'SECRET-EXPLANATION-解説文-0007';
const SECRET_REVEAL_URL = 'https://media.example.com/SECRET-REVEAL-IMAGE.webp';
const SECRET_REVEAL_ALT = 'SECRET-REVEAL-ALT-正解画像';
const SECRET_NUMBER_ANSWER = '3776.25';
const SECRET_TOLERANCE = '98765';

/** ネストを含めたすべてのオブジェクトキーを集める。 */
function collectKeys(value: unknown, acc: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, acc);
    }
    return acc;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

function secretChoiceQuestion(): ChoiceQuestion {
  return choiceQuestion({
    id: 'question-1',
    text: '日本で一番高い山はどれ？',
    image: mediaRef({ url: 'https://media.example.com/question-1.webp', alt: '山の写真' }),
    revealImage: mediaRef({ url: SECRET_REVEAL_URL, alt: SECRET_REVEAL_ALT }),
    explanation: SECRET_EXPLANATION,
    choices: [
      choiceOption(2, { id: 'choice-b', text: '北岳' }),
      choiceOption(1, { id: 'choice-a', text: '富士山', isCorrect: true }),
      choiceOption(3, { id: 'choice-c', text: '奥穂高岳' }),
    ],
  });
}

function secretNumberQuestion(): NumberQuestion {
  return numberQuestion({
    id: 'question-2',
    position: 2,
    revealImage: mediaRef({ url: SECRET_REVEAL_URL, alt: SECRET_REVEAL_ALT }),
    explanation: SECRET_EXPLANATION,
    numberRule: {
      mode: 'absolute_tolerance',
      correctValue: SECRET_NUMBER_ANSWER,
      tolerance: SECRET_TOLERANCE,
    },
    unit: 'm',
    decimalPlaces: 2,
  });
}

describe('toPublicQuestion（選択式）', () => {
  it('正解情報を含むキーを一切持たない', () => {
    const publicQuestion = toPublicQuestion(secretChoiceQuestion());
    const keys = collectKeys(publicQuestion);

    for (const forbidden of [
      'isCorrect',
      'correctChoiceId',
      'explanation',
      'revealImage',
      'numberRule',
      'correctValue',
      'tolerance',
      'minValue',
      'maxValue',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('JSON 文字列にも正解・解説・正解画像が現れない', () => {
    const json = JSON.stringify(toPublicQuestion(secretChoiceQuestion()));

    expect(json).not.toContain('isCorrect');
    expect(json).not.toContain('explanation');
    expect(json).not.toContain('revealImage');
    expect(json).not.toContain(SECRET_EXPLANATION);
    expect(json).not.toContain(SECRET_REVEAL_URL);
    expect(json).not.toContain(SECRET_REVEAL_ALT);
    expect(json).not.toContain('SECRET');
  });

  it('公開してよいキーだけを持つ', () => {
    const publicQuestion = toPublicQuestion(secretChoiceQuestion());

    expect(Object.keys(publicQuestion).sort()).toEqual(
      ['choices', 'id', 'image', 'points', 'position', 'text', 'timeLimitSeconds', 'type'].sort(),
    );
    expect(publicQuestion.type).toBe('choice');
    if (publicQuestion.type !== 'choice') {
      throw new Error('選択式として生成されていない');
    }
    for (const choice of publicQuestion.choices) {
      expect(Object.keys(choice).sort()).toEqual(
        ['id', 'image', 'label', 'position', 'text'].sort(),
      );
    }
  });

  it('選択肢を position 昇順へ並べ替え、ラベル A〜E を導出する', () => {
    const publicQuestion = toPublicQuestion(secretChoiceQuestion());
    if (publicQuestion.type !== 'choice') {
      throw new Error('選択式として生成されていない');
    }

    expect(publicQuestion.choices.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(publicQuestion.choices.map((c) => c.id)).toEqual(['choice-a', 'choice-b', 'choice-c']);
    expect(publicQuestion.choices.map((c) => c.label)).toEqual(['A', 'B', 'C']);
  });

  it('5 件の選択肢では A〜E が付く', () => {
    const publicQuestion = toPublicQuestion(
      choiceQuestion({
        choices: [1, 2, 3, 4, 5].map((position) =>
          choiceOption(position, { isCorrect: position === 1 }),
        ),
      }),
    );
    if (publicQuestion.type !== 'choice') {
      throw new Error('選択式として生成されていない');
    }

    expect(publicQuestion.choices.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('公開してよい値はそのまま引き継ぐ', () => {
    const source = secretChoiceQuestion();
    const publicQuestion = toPublicQuestion(source);

    expect(publicQuestion.id).toBe(source.id);
    expect(publicQuestion.position).toBe(source.position);
    expect(publicQuestion.text).toBe(source.text);
    expect(publicQuestion.timeLimitSeconds).toBe(source.timeLimitSeconds);
    expect(publicQuestion.points).toBe(source.points);
    expect(publicQuestion.image).toEqual({
      url: 'https://media.example.com/question-1.webp',
      alt: '山の写真',
      width: 1200,
      height: 800,
    });
  });

  it('問題画像が無ければ null になる', () => {
    expect(toPublicQuestion(choiceQuestion({ image: null })).image).toBeNull();
  });

  it('画像から assetId を落とす（内部識別子を配信しない）', () => {
    const json = JSON.stringify(toPublicQuestion(choiceQuestion({ image: mediaRef() })));

    expect(json).not.toContain('assetId');
    expect(json).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});

describe('toPublicQuestion（数値式）', () => {
  it('正解値・許容誤差・解説・正解画像を含まない', () => {
    const publicQuestion = toPublicQuestion(secretNumberQuestion());
    const json = JSON.stringify(publicQuestion);

    expect(json).not.toContain(SECRET_NUMBER_ANSWER);
    expect(json).not.toContain(SECRET_TOLERANCE);
    expect(json).not.toContain(SECRET_EXPLANATION);
    expect(json).not.toContain(SECRET_REVEAL_URL);
    expect(json).not.toContain('numberRule');
    expect(json).not.toContain('correctValue');
    expect(json).not.toContain('tolerance');
    expect(json).not.toContain('explanation');
    expect(json).not.toContain('revealImage');
  });

  it('公開してよいキーだけを持つ', () => {
    const publicQuestion = toPublicQuestion(secretNumberQuestion());

    expect(Object.keys(publicQuestion).sort()).toEqual(
      [
        'decimalPlaces',
        'id',
        'image',
        'points',
        'position',
        'text',
        'timeLimitSeconds',
        'type',
        'unit',
      ].sort(),
    );
  });

  it('単位と表示小数桁数は参加者へ渡す（入力補助のため）', () => {
    const publicQuestion = toPublicQuestion(secretNumberQuestion());
    if (publicQuestion.type !== 'number') {
      throw new Error('数値式として生成されていない');
    }

    expect(publicQuestion.unit).toBe('m');
    expect(publicQuestion.decimalPlaces).toBe(2);
    expect(publicQuestion.type).toBe('number');
  });

  it('range モードの最小値・最大値も漏れない', () => {
    const json = JSON.stringify(
      toPublicQuestion(
        numberQuestion({
          numberRule: { mode: 'range', minValue: '11111', maxValue: '22222' },
        }),
      ),
    );

    expect(json).not.toContain('11111');
    expect(json).not.toContain('22222');
    expect(json).not.toContain('minValue');
    expect(json).not.toContain('maxValue');
  });
});

describe('choiceLabelFor', () => {
  it('position 1〜5 から A〜E を導出する', () => {
    expect([1, 2, 3, 4, 5].map(choiceLabelFor)).toEqual([...CHOICE_LABELS]);
  });

  it('範囲外の position では例外を投げる', () => {
    expect(() => choiceLabelFor(0)).toThrow('INVALID_CHOICE_POSITION');
    expect(() => choiceLabelFor(6)).toThrow('INVALID_CHOICE_POSITION');
  });
});
