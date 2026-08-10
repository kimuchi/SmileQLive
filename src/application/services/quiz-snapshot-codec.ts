import 'server-only';

/**
 * 管理用 DTO ⇔ ドメイン問題 ⇔ jsonb スナップショットの相互変換。
 *
 * 重要:
 * - スナップショットへ**期限付き URL を保存しない**。`storage://<bucket>/<path>` の参照だけを入れ、
 *   配信直前に resolveMediaUrls() で解決する。
 * - 数値の正解値・許容誤差・範囲は文字列のまま持ち回る（JavaScript の number にしない）。
 * - スナップショットは正解情報を含むため、参加者へ渡す前に必ず toPublicQuestion() を通す。
 */

import {
  NUMBER_JUDGEMENT_MODES,
  type ChoiceOption,
  type ChoicePosition,
  type MediaRef,
  type NumberRule,
  type Question,
} from '@/domain/quiz/question';
import type { QuizSnapshot, QuizSnapshotSettings } from '@/domain/quiz/quiz-snapshot';
import {
  isRecord,
  readBoolean,
  readEnum,
  readInt,
  readNumericText,
  readString,
} from '@/infrastructure/supabase/repositories/row-utils';
import type { AdminChoice, AdminMediaRef, AdminQuestion, AdminQuizDetail } from '@/types/api';
import type { Json } from '@/types/database';

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
    leaderboardSize: 10,
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

/** jsonb へ入れる形へ変換する。 */
export function snapshotToJson(snapshot: QuizSnapshot): Json {
  return JSON.parse(JSON.stringify(snapshot)) as Json;
}

// ---------------------------------------------------------------------------
// jsonb からの復元
// ---------------------------------------------------------------------------

function parseMediaRef(value: unknown): MediaRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const assetId = readString(value, 'assetId');
  const url = readString(value, 'url');
  if (!assetId || !url) {
    return null;
  }
  return {
    assetId,
    url,
    alt: readString(value, 'alt') ?? '',
    width: readInt(value, 'width', 0),
    height: readInt(value, 'height', 0),
  };
}

function parseNumberRule(value: unknown): NumberRule {
  if (!isRecord(value)) {
    return { mode: 'exact', correctValue: '0' };
  }
  const mode = readEnum(value, 'mode', NUMBER_JUDGEMENT_MODES) ?? 'exact';
  if (mode === 'range') {
    return {
      mode: 'range',
      minValue: readNumericText(value, 'minValue') ?? '0',
      maxValue: readNumericText(value, 'maxValue') ?? '0',
    };
  }
  if (mode === 'absolute_tolerance') {
    return {
      mode: 'absolute_tolerance',
      correctValue: readNumericText(value, 'correctValue') ?? '0',
      tolerance: readNumericText(value, 'tolerance') ?? '0',
    };
  }
  return { mode: 'exact', correctValue: readNumericText(value, 'correctValue') ?? '0' };
}

function parseQuestion(value: unknown): Question | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value, 'id');
  if (!id) {
    return null;
  }

  const base = {
    id,
    position: readInt(value, 'position', 1),
    text: readString(value, 'text'),
    image: parseMediaRef(value.image),
    revealImage: parseMediaRef(value.revealImage),
    timeLimitSeconds: readInt(value, 'timeLimitSeconds', 20),
    points: readInt(value, 'points', 1000),
    explanation: readString(value, 'explanation'),
  };

  if (readString(value, 'type') === 'number') {
    return {
      ...base,
      type: 'number',
      numberRule: parseNumberRule(value.numberRule),
      unit: readString(value, 'unit'),
      decimalPlaces: readInt(value, 'decimalPlaces', 0),
    };
  }

  const rawChoices = Array.isArray(value.choices) ? value.choices : [];
  const choices: ChoiceOption[] = rawChoices.filter(isRecord).flatMap((choice) => {
    const choiceId = readString(choice, 'id');
    if (!choiceId) {
      return [];
    }
    return [
      {
        id: choiceId,
        position: toChoicePosition(readInt(choice, 'position', 1)),
        text: readString(choice, 'text'),
        image: parseMediaRef(choice.image),
        isCorrect: readBoolean(choice, 'isCorrect', false),
      },
    ];
  });

  return { ...base, type: 'choice', choices };
}

/** rooms.quiz_snapshot (jsonb) をドメイン型へ復元する。 */
export function parseQuizSnapshot(value: unknown): QuizSnapshot {
  if (!isRecord(value)) {
    return {
      quizId: '',
      title: '無題のクイズ',
      settings: { showLeaderboard: true, soundTheme: 'default', leaderboardSize: 10 },
      questions: [],
    };
  }

  const settingsValue = isRecord(value.settings) ? value.settings : {};

  return {
    quizId: readString(value, 'quizId') ?? '',
    title: readString(value, 'title') ?? '無題のクイズ',
    settings: {
      showLeaderboard: readBoolean(settingsValue, 'showLeaderboard', true),
      soundTheme: readString(settingsValue, 'soundTheme') ?? 'default',
      leaderboardSize: readInt(settingsValue, 'leaderboardSize', 10),
    },
    questions: (Array.isArray(value.questions) ? value.questions : [])
      .flatMap((question) => {
        const parsed = parseQuestion(question);
        return parsed ? [parsed] : [];
      })
      .sort((a, b) => a.position - b.position),
  };
}
