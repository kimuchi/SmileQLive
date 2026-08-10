import 'server-only';

/**
 * 管理用 DTO ⇔ ドメイン問題 ⇔ `rooms/{roomId}.quizSnapshot` の相互変換。
 *
 * 重要:
 * - スナップショットへ**期限付き URL を保存しない**。`storage://<bucket>/<path>` の参照だけを入れ、
 *   配信直前に resolveQuestionMedia() で解決する。
 * - 数値の正解値・許容誤差・範囲は文字列のまま持ち回る（JavaScript の number にしない）。
 * - スナップショットは**正解情報を含む**ため、参加者へ渡す前に必ず toPublicQuestion() を通す。
 *
 * 保存済みスナップショットの復元は `infrastructure/firebase/converters.ts` が持つ
 * 防御的なパーサーへ委譲する（壊れたデータでも参加者画面を落とさない）。
 */

import {
  type ChoiceOption,
  type ChoicePosition,
  type MediaRef,
  type NumberRule,
  type Question,
} from '@/domain/quiz/question';
import type { QuizSnapshot, QuizSnapshotSettings } from '@/domain/quiz/quiz-snapshot';
import {
  parseQuizSnapshot as parseStoredQuizSnapshot,
  snapshotToPlain,
} from '@/infrastructure/firebase/converters';
import type { AdminChoice, AdminMediaRef, AdminQuestion, AdminQuizDetail } from '@/types/api';

/** ランキング表示件数の既定値。 */
const DEFAULT_LEADERBOARD_SIZE = 10;

function toMediaRef(ref: AdminMediaRef | null): MediaRef | null {
  if (!ref) {
    return null;
  }
  return {
    assetId: ref.assetId,
    url: ref.url,
    alt: ref.alt,
    width: ref.width,
    height: ref.height,
  };
}

function toChoicePosition(position: number): ChoicePosition {
  const clamped = Math.min(5, Math.max(1, Math.trunc(position)));
  return clamped as ChoicePosition;
}

function toChoiceOption(choice: AdminChoice): ChoiceOption {
  return {
    id: choice.id,
    position: toChoicePosition(choice.position),
    text: choice.text,
    image: toMediaRef(choice.image),
    isCorrect: choice.isCorrect,
  };
}

function toNumberRule(question: AdminQuestion): NumberRule {
  switch (question.numberMode) {
    case 'absolute_tolerance':
      return {
        mode: 'absolute_tolerance',
        correctValue: question.numberCorrectValue ?? '0',
        tolerance: question.numberTolerance ?? '0',
      };
    case 'range':
      return {
        mode: 'range',
        minValue: question.numberMinValue ?? '0',
        maxValue: question.numberMaxValue ?? '0',
      };
    case 'exact':
    default:
      return { mode: 'exact', correctValue: question.numberCorrectValue ?? '0' };
  }
}

/** 管理用 DTO からドメイン問題へ。 */
export function toDomainQuestion(question: AdminQuestion): Question {
  const base = {
    id: question.id,
    position: question.position,
    text: question.text,
    image: toMediaRef(question.image),
    revealImage: toMediaRef(question.revealImage),
    timeLimitSeconds: question.timeLimitSeconds,
    points: question.points,
    explanation: question.explanation,
  };

  if (question.type === 'choice') {
    return {
      ...base,
      type: 'choice',
      choices: question.choices
        .slice()
        .sort((a, b) => a.position - b.position)
        .map(toChoiceOption),
    };
  }

  return {
    ...base,
    type: 'number',
    numberRule: toNumberRule(question),
    unit: question.unit,
    decimalPlaces: question.decimalPlaces,
  };
}

/**
 * ルーム作成時に固定するスナップショットを組み立てる。
 * `detail` は `resolveUrls: false` で取得したもの（＝画像は storage:// 参照）を渡すこと。
 */
export function buildQuizSnapshot(detail: AdminQuizDetail): QuizSnapshot {
  const settings: QuizSnapshotSettings = {
    showLeaderboard: detail.showLeaderboard,
    soundTheme: detail.soundTheme,
    leaderboardSize: DEFAULT_LEADERBOARD_SIZE,
  };

  return {
    quizId: detail.id,
    title: detail.title,
    settings,
    questions: detail.questions
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(toDomainQuestion),
  };
}

/**
 * Firestore へ書き込める素の形へ落とす（undefined を含めない）。
 * `rooms/{roomId}.quizSnapshot` はネストしたマップとして保存される。
 */
export function snapshotToJson(snapshot: QuizSnapshot): QuizSnapshot {
  return snapshotToPlain(snapshot);
}

/**
 * `rooms/{roomId}.quizSnapshot` をドメイン型へ復元する。
 * 保存済みデータが壊れていても画面を落とさないよう、既定値で埋めて返す。
 */
export function parseQuizSnapshot(value: unknown): QuizSnapshot {
  return parseStoredQuizSnapshot(value);
}
