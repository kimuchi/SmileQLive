import 'server-only';

/**
 * 保存済み回答から参加者本人向け DTO への変換。
 *
 * 本人の回答内容は正解発表前でも返してよいが、
 * 正誤 (isCorrect) と得点はここに含めない（呼び出し側がフェーズを見て付与する）。
 */

import type { MyAnswer } from '@/domain/answer/answer-dto';
import type { StoredAnswer } from '@/application/ports/answer-repository-port';

export function toMyAnswerDto(stored: StoredAnswer | null): MyAnswer | null {
  if (!stored) {
    return null;
  }

  if (stored.answerType === 'choice') {
    if (!stored.choiceId) {
      // DB 制約上ありえないが、壊れたデータを participant へ返さない。
      return null;
    }
    return {
      questionId: stored.questionId,
      type: 'choice',
      choiceId: stored.choiceId,
      answeredAt: stored.answeredAt,
    };
  }

  if (stored.numberRaw === null || stored.numberValue === null) {
    return null;
  }

  return {
    questionId: stored.questionId,
    type: 'number',
    raw: stored.numberRaw,
    normalizedText: stored.numberValue,
    answeredAt: stored.answeredAt,
  };
}
