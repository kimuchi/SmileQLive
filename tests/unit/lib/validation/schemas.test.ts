import { describe, expect, it } from 'vitest';
import {
  createQuizSchema,
  joinTokenSchema,
  nicknameSchema,
  numberRuleSchema,
  registerParticipantSchema,
  roomActionSchema,
  submitAnswerSchema,
  updateQuestionSchema,
} from '@/lib/validation/schemas';

/**
 * API 入力の検証。
 * 「クライアントから送られた値を信用しない」ことの最初の関門。
 */

const UUID = '00000000-0000-4000-8000-000000000000';

describe('ニックネーム', () => {
  it('前後の空白を除去し全角を正規化する', () => {
    expect(nicknameSchema.parse('  木村  ')).toBe('木村');
    // NFKC により全角英数は半角へ
    expect(nicknameSchema.parse('Ｋｉｍｕｒａ')).toBe('Kimura');
  });

  it('1〜20文字を受け付ける', () => {
    expect(nicknameSchema.parse('あ')).toBe('あ');
    expect(nicknameSchema.parse('あ'.repeat(20))).toHaveLength(20);
  });

  it('空文字・空白のみ・21文字以上を拒否する', () => {
    expect(nicknameSchema.safeParse('').success).toBe(false);
    expect(nicknameSchema.safeParse('   ').success).toBe(false);
    expect(nicknameSchema.safeParse('あ'.repeat(21)).success).toBe(false);
  });
});

describe('参加トークンの形式', () => {
  it('base64url の 20〜64 文字を受け付ける', () => {
    expect(joinTokenSchema.safeParse('AbCdEfGhIjKlMnOpQrStUv').success).toBe(true);
    expect(joinTokenSchema.safeParse('a-b_c-d_e-f_g-h_i-j_k1').success).toBe(true);
  });

  it('短すぎる・不正な文字・パス断片を拒否する', () => {
    expect(joinTokenSchema.safeParse('short').success).toBe(false);
    expect(joinTokenSchema.safeParse('../../../etc/passwd').success).toBe(false);
    expect(joinTokenSchema.safeParse('has spaces in the token').success).toBe(false);
    expect(joinTokenSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('回答送信', () => {
  it('選択式は choiceId のみ', () => {
    const result = submitAnswerSchema.safeParse({ questionId: UUID, choiceId: UUID });
    expect(result.success).toBe(true);
  });

  it('数値式は numberValue のみ', () => {
    const result = submitAnswerSchema.safeParse({ questionId: UUID, numberValue: '３,７７６' });
    expect(result.success).toBe(true);
  });

  it('choiceId と numberValue の同時指定を拒否する', () => {
    const result = submitAnswerSchema.safeParse({
      questionId: UUID,
      choiceId: UUID,
      numberValue: '42',
    });
    expect(result.success).toBe(false);
  });

  it('どちらも無い場合を拒否する', () => {
    expect(submitAnswerSchema.safeParse({ questionId: UUID }).success).toBe(false);
  });

  it('questionId が UUID でなければ拒否する', () => {
    expect(submitAnswerSchema.safeParse({ questionId: 'not-uuid', choiceId: UUID }).success).toBe(
      false,
    );
  });

  it('異常に長い数値文字列を拒否する', () => {
    expect(
      submitAnswerSchema.safeParse({ questionId: UUID, numberValue: '9'.repeat(65) }).success,
    ).toBe(false);
  });
});

describe('状態遷移リクエスト', () => {
  it('許可された action と expectedVersion を受け付ける', () => {
    const result = roomActionSchema.safeParse({ action: 'open_question', expectedVersion: 3 });
    expect(result.success).toBe(true);
  });

  it('未知の action を拒否する', () => {
    expect(roomActionSchema.safeParse({ action: 'reset_room', expectedVersion: 0 }).success).toBe(
      false,
    );
    // DB を直接操作させるような値も当然拒否
    expect(roomActionSchema.safeParse({ action: 'DROP TABLE', expectedVersion: 0 }).success).toBe(
      false,
    );
  });

  it('expectedVersion の欠落・負値・小数を拒否する', () => {
    expect(roomActionSchema.safeParse({ action: 'open_question' }).success).toBe(false);
    expect(
      roomActionSchema.safeParse({ action: 'open_question', expectedVersion: -1 }).success,
    ).toBe(false);
    expect(
      roomActionSchema.safeParse({ action: 'open_question', expectedVersion: 1.5 }).success,
    ).toBe(false);
  });
});

describe('数値の判定条件', () => {
  it('3 つの判定モードを判別する', () => {
    expect(numberRuleSchema.safeParse({ mode: 'exact', correctValue: '3776' }).success).toBe(true);
    expect(
      numberRuleSchema.safeParse({
        mode: 'absolute_tolerance',
        correctValue: '100',
        tolerance: '2',
      }).success,
    ).toBe(true);
    expect(
      numberRuleSchema.safeParse({ mode: 'range', minValue: '9.5', maxValue: '10.5' }).success,
    ).toBe(true);
  });

  it('モードに必要な値が欠けていれば拒否する', () => {
    expect(numberRuleSchema.safeParse({ mode: 'exact' }).success).toBe(false);
    expect(
      numberRuleSchema.safeParse({ mode: 'absolute_tolerance', correctValue: '100' }).success,
    ).toBe(false);
    expect(numberRuleSchema.safeParse({ mode: 'range', minValue: '1' }).success).toBe(false);
  });

  it('モード違いの余計な値を混ぜても、そのモードとして解釈される', () => {
    // exact に tolerance を混ぜても、判定に使われるのは correctValue だけ
    const parsed = numberRuleSchema.parse({
      mode: 'exact',
      correctValue: '10',
      tolerance: '999',
    });
    expect(parsed.mode).toBe('exact');
    expect('tolerance' in parsed).toBe(false);
  });

  it('未知のモードを拒否する', () => {
    expect(numberRuleSchema.safeParse({ mode: 'regex', pattern: '.*' }).success).toBe(false);
  });
});

describe('問題の更新', () => {
  it('選択式は 2〜5 個の選択肢を要求する', () => {
    const base = {
      type: 'choice' as const,
      choices: [
        { position: 1, text: 'A', isCorrect: false },
        { position: 2, text: 'B', isCorrect: true },
      ],
    };
    expect(updateQuestionSchema.safeParse(base).success).toBe(true);

    expect(
      updateQuestionSchema.safeParse({
        ...base,
        choices: [{ position: 1, text: 'A', isCorrect: true }],
      }).success,
    ).toBe(false);

    expect(
      updateQuestionSchema.safeParse({
        ...base,
        choices: Array.from({ length: 6 }, (_, index) => ({
          position: index + 1,
          text: `選択肢${index + 1}`,
          isCorrect: index === 0,
        })),
      }).success,
    ).toBe(false);
  });

  it('数値式は判定条件と表示桁数を要求する', () => {
    expect(
      updateQuestionSchema.safeParse({
        type: 'number',
        numberRule: { mode: 'exact', correctValue: '3776' },
        decimalPlaces: 0,
      }).success,
    ).toBe(true);

    expect(updateQuestionSchema.safeParse({ type: 'number', decimalPlaces: 0 }).success).toBe(
      false,
    );
  });

  it('制限時間・配点の範囲外を拒否する', () => {
    const choices = [
      { position: 1, text: 'A', isCorrect: false },
      { position: 2, text: 'B', isCorrect: true },
    ];
    expect(
      updateQuestionSchema.safeParse({ type: 'choice', choices, timeLimitSeconds: 4 }).success,
    ).toBe(false);
    expect(
      updateQuestionSchema.safeParse({ type: 'choice', choices, timeLimitSeconds: 181 }).success,
    ).toBe(false);
    expect(updateQuestionSchema.safeParse({ type: 'choice', choices, points: -1 }).success).toBe(
      false,
    );
    expect(updateQuestionSchema.safeParse({ type: 'choice', choices, points: 10001 }).success).toBe(
      false,
    );
  });
});

describe('クイズ作成', () => {
  it('タイトルは 1〜100 文字', () => {
    expect(createQuizSchema.safeParse({ title: 'テストクイズ' }).success).toBe(true);
    expect(createQuizSchema.safeParse({ title: '' }).success).toBe(false);
    expect(createQuizSchema.safeParse({ title: 'あ'.repeat(101) }).success).toBe(false);
  });
});

describe('参加登録', () => {
  it('ニックネームを必須にする', () => {
    expect(registerParticipantSchema.safeParse({ nickname: '木村' }).success).toBe(true);
    expect(registerParticipantSchema.safeParse({}).success).toBe(false);
  });

  it('クライアントが role や参加者IDを詐称しても取り込まない', () => {
    const parsed = registerParticipantSchema.parse({
      nickname: '木村',
      role: 'host',
      participantId: 'forged',
      isCorrect: true,
    });
    expect(parsed).toEqual({ nickname: '木村' });
    expect('role' in parsed).toBe(false);
    expect('participantId' in parsed).toBe(false);
  });
});
