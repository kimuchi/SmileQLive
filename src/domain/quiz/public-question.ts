import {
  choiceLabelFor,
  type ChoiceLabel,
  type ChoicePosition,
  type Question,
} from '@/domain/quiz/question';

/**
 * 参加者・投影画面へ配信してよい問題 DTO。
 *
 * 次の情報を絶対に含めない:
 * - isCorrect / 正解選択肢 ID
 * - 数値の正解値・許容誤差・範囲
 * - 解説
 * - 正解・解説画像 URL
 */

export type PublicImage = { url: string; alt: string; width: number; height: number };

export type PublicChoice = {
  id: string;
  position: ChoicePosition;
  label: ChoiceLabel;
  text: string | null;
  image: PublicImage | null;
};

export type PublicChoiceQuestion = {
  id: string;
  type: 'choice';
  position: number;
  text: string | null;
  image: PublicImage | null;
  timeLimitSeconds: number;
  points: number;
  choices: PublicChoice[];
};

export type PublicNumberQuestion = {
  id: string;
  type: 'number';
  position: number;
  text: string | null;
  image: PublicImage | null;
  timeLimitSeconds: number;
  points: number;
  unit: string | null;
  decimalPlaces: number;
};

export type PublicQuestion = PublicChoiceQuestion | PublicNumberQuestion;

function toPublicImage(
  image: { url: string; alt: string; width: number; height: number } | null,
): PublicImage | null {
  if (!image) {
    return null;
  }
  return { url: image.url, alt: image.alt, width: image.width, height: image.height };
}

/**
 * スナップショット上の問題から、正解情報を完全に除去した DTO を生成する。
 * この関数を通していないオブジェクトを参加者へ返さないこと。
 */
export function toPublicQuestion(question: Question): PublicQuestion {
  const base = {
    id: question.id,
    position: question.position,
    text: question.text,
    image: toPublicImage(question.image),
    timeLimitSeconds: question.timeLimitSeconds,
    points: question.points,
  };

  if (question.type === 'choice') {
    return {
      ...base,
      type: 'choice',
      choices: [...question.choices]
        .sort((a, b) => a.position - b.position)
        .map((choice) => ({
          id: choice.id,
          position: choice.position,
          label: choiceLabelFor(choice.position),
          text: choice.text,
          image: toPublicImage(choice.image),
        })),
    };
  }

  return {
    ...base,
    type: 'number',
    unit: question.unit,
    decimalPlaces: question.decimalPlaces,
  };
}

/** 正解発表後にだけ返す情報。 */
export type QuestionRevealPayload =
  | {
      questionId: string;
      type: 'choice';
      correctChoiceId: string;
      explanation: string | null;
      revealImage: PublicImage | null;
    }
  | {
      questionId: string;
      type: 'number';
      /** 表示用の正解条件文字列。 */
      answerRuleDisplay: string;
      explanation: string | null;
      revealImage: PublicImage | null;
    };
