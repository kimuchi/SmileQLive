import 'server-only';

/**
 * Firestore ドキュメント ⇔ ドメイン型 / API DTO の相互変換。
 *
 * 重要な約束:
 * - **数値項目（正解値・許容誤差・範囲・回答値）は必ず文字列のまま扱う。**
 *   Firestore の number は倍精度浮動小数点なので、number へ変換した時点で桁落ちする。
 * - 時刻は Firestore の `Timestamp` と ISO8601 文字列を相互変換する。
 *   締切判定に使う時刻は必ずサーバー側で作る（クライアント時刻を通さない）。
 * - 画像は `{ assetId, url, alt, width, height }` で表し、`url` には
 *   `storage://<bucket>/<objectPath>` 形式の参照を入れる。
 *   期限付き URL は配信直前に media-storage.ts で解決する（保存しない）。
 * - 参加者へ渡す前に必ず `toPublicQuestion()` を通すこと。ここでの変換結果は正解を含む。
 */

import { Timestamp } from 'firebase-admin/firestore';
import {
  NUMBER_JUDGEMENT_MODES,
  QUESTION_TYPES,
  DEFAULT_POINTS,
  DEFAULT_TIME_LIMIT_SECONDS,
  type ChoiceOption,
  type ChoicePosition,
  type MediaRef,
  type NumberRule,
  type Question,
} from '@/domain/quiz/question';
import type { QuizSnapshot, QuizSnapshotSettings } from '@/domain/quiz/quiz-snapshot';
import type { AdminChoice, AdminMediaRef, AdminQuestion } from '@/types/api';
import type { ChoiceEmbedded, QuestionDoc } from '@/types/firestore';

// ---------------------------------------------------------------------------
// unknown を安全に読むための小道具
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function readInt(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 数値項目を**文字列のまま**取り出す。
 * 万一 number で保存されていても String() で文字列化し、number のまま扱わない。
 */
export function readNumericText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = record[key];
  if (typeof value !== 'string') {
    return null;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

// ---------------------------------------------------------------------------
// Timestamp ⇔ ISO8601
// ---------------------------------------------------------------------------

/** Firestore の Timestamp を ISO8601 文字列へ。null / 未設定は null。 */
export function toIso(value: Timestamp | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.toDate().toISOString();
}

/** null を許さない場面向け。未設定なら fallback（既定はエポック）を返す。 */
export function toIsoOr(
  value: Timestamp | null | undefined,
  fallback: string = new Date(0).toISOString(),
): string {
  return toIso(value) ?? fallback;
}

/** ISO8601 文字列 / Date / ミリ秒を Timestamp へ。不正な値は null。 */
export function toTimestamp(value: string | number | Date | null | undefined): Timestamp | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : Timestamp.fromDate(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Timestamp.fromMillis(value) : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Timestamp.fromMillis(parsed);
}

/** サーバー時刻（Cloud Run の時計）。締切判定の基準はこれだけを使う。 */
export function nowTimestamp(): Timestamp {
  return Timestamp.now();
}

/** ミリ秒から Timestamp を作る（締切時刻の算出に使う）。 */
export function timestampFromMillis(millis: number): Timestamp {
  return Timestamp.fromMillis(millis);
}

/** Timestamp をミリ秒へ。未設定は null。 */
export function toMillis(value: Timestamp | null | undefined): number | null {
  return value ? value.toMillis() : null;
}

// ---------------------------------------------------------------------------
// 画像参照
// ---------------------------------------------------------------------------

/**
 * assetId から画像情報を引くための表。
 * `url` には `storage://<bucket>/<objectPath>` 参照、
 * あるいは配信直前に解決した署名付き URL のどちらかが入る。
 */
export type MediaAssetLookup = ReadonlyMap<string, { url: string; width: number; height: number }>;

export const EMPTY_MEDIA_LOOKUP: MediaAssetLookup = new Map();

/** 画像参照を組み立てる。表に無い（＝削除済みなど）場合は null。 */
export function toMediaRef(
  assetId: string | null,
  alt: string | null,
  lookup: MediaAssetLookup,
): MediaRef | null {
  if (!assetId) {
    return null;
  }
  const entry = lookup.get(assetId);
  if (!entry || entry.url.length === 0) {
    return null;
  }
  return {
    assetId,
    url: entry.url,
    alt: alt ?? '',
    width: entry.width,
    height: entry.height,
  };
}

/** API 応答用の画像参照（ドメインの MediaRef と同形）。 */
export function toAdminMediaRef(
  assetId: string | null,
  alt: string | null,
  lookup: MediaAssetLookup,
): AdminMediaRef | null {
  return toMediaRef(assetId, alt, lookup);
}

// ---------------------------------------------------------------------------
// QuestionDoc → ドメイン / API DTO
// ---------------------------------------------------------------------------

function toChoicePosition(position: number): ChoicePosition {
  const clamped = Math.min(5, Math.max(1, Math.trunc(position)));
  return clamped as ChoicePosition;
}

function sortedChoices(choices: readonly ChoiceEmbedded[]): ChoiceEmbedded[] {
  return [...choices].sort((a, b) => a.position - b.position);
}

/** 埋め込み選択肢 → ドメイン。 */
export function toChoiceOption(choice: ChoiceEmbedded, lookup: MediaAssetLookup): ChoiceOption {
  return {
    id: choice.id,
    position: toChoicePosition(choice.position),
    text: choice.text,
    image: toMediaRef(choice.imageAssetId, choice.imageAlt, lookup),
    isCorrect: choice.isCorrect,
  };
}

/** 埋め込み選択肢 → 管理画面 DTO。 */
export function toAdminChoice(choice: ChoiceEmbedded, lookup: MediaAssetLookup): AdminChoice {
  return {
    id: choice.id,
    position: choice.position,
    text: choice.text,
    image: toAdminMediaRef(choice.imageAssetId, choice.imageAlt, lookup),
    isCorrect: choice.isCorrect,
  };
}

/** 数値判定条件。文字列のまま組み立てる（number へ変換しない）。 */
export function toNumberRule(doc: {
  numberMode: QuestionDoc['numberMode'];
  numberCorrectValue: string | null;
  numberTolerance: string | null;
  numberMinValue: string | null;
  numberMaxValue: string | null;
}): NumberRule {
  switch (doc.numberMode) {
    case 'absolute_tolerance':
      return {
        mode: 'absolute_tolerance',
        correctValue: doc.numberCorrectValue ?? '0',
        tolerance: doc.numberTolerance ?? '0',
      };
    case 'range':
      return {
        mode: 'range',
        minValue: doc.numberMinValue ?? '0',
        maxValue: doc.numberMaxValue ?? '0',
      };
    case 'exact':
    default:
      return { mode: 'exact', correctValue: doc.numberCorrectValue ?? '0' };
  }
}

/** NumberRule → ドキュメントの数値カラム群（未使用のモードは null で潰す）。 */
export function fromNumberRule(
  rule: NumberRule,
): Pick<
  QuestionDoc,
  'numberMode' | 'numberCorrectValue' | 'numberTolerance' | 'numberMinValue' | 'numberMaxValue'
> {
  switch (rule.mode) {
    case 'absolute_tolerance':
      return {
        numberMode: 'absolute_tolerance',
        numberCorrectValue: rule.correctValue,
        numberTolerance: rule.tolerance,
        numberMinValue: null,
        numberMaxValue: null,
      };
    case 'range':
      return {
        numberMode: 'range',
        numberCorrectValue: null,
        numberTolerance: null,
        numberMinValue: rule.minValue,
        numberMaxValue: rule.maxValue,
      };
    case 'exact':
    default:
      return {
        numberMode: 'exact',
        numberCorrectValue: rule.correctValue,
        numberTolerance: null,
        numberMinValue: null,
        numberMaxValue: null,
      };
  }
}

/**
 * QuestionDoc → ドメインの Question。
 * **正解情報を含む**ので、参加者へ返す前に必ず toPublicQuestion() を通すこと。
 */
export function toDomainQuestion(doc: QuestionDoc, lookup: MediaAssetLookup): Question {
  const base = {
    id: doc.id,
    position: doc.position,
    text: doc.questionText,
    image: toMediaRef(doc.questionImageAssetId, doc.questionImageAlt, lookup),
    revealImage: toMediaRef(doc.revealImageAssetId, doc.revealImageAlt, lookup),
    timeLimitSeconds: doc.timeLimitSeconds,
    points: doc.points,
    explanation: doc.explanation,
  };

  if (doc.questionType === 'number') {
    return {
      ...base,
      type: 'number',
      numberRule: toNumberRule(doc),
      unit: doc.numberUnit,
      decimalPlaces: doc.numberDecimalPlaces,
    };
  }

  return {
    ...base,
    type: 'choice',
    choices: sortedChoices(doc.choices).map((choice) => toChoiceOption(choice, lookup)),
  };
}

/** QuestionDoc → 管理画面 DTO。数値項目は文字列のまま渡す。 */
export function toAdminQuestion(doc: QuestionDoc, lookup: MediaAssetLookup): AdminQuestion {
  return {
    id: doc.id,
    position: doc.position,
    type: doc.questionType,
    text: doc.questionText,
    image: toAdminMediaRef(doc.questionImageAssetId, doc.questionImageAlt, lookup),
    revealImage: toAdminMediaRef(doc.revealImageAssetId, doc.revealImageAlt, lookup),
    explanation: doc.explanation,
    timeLimitSeconds: doc.timeLimitSeconds,
    points: doc.points,
    choices: sortedChoices(doc.choices).map((choice) => toAdminChoice(choice, lookup)),
    numberMode: doc.numberMode,
    numberCorrectValue: doc.numberCorrectValue,
    numberTolerance: doc.numberTolerance,
    numberMinValue: doc.numberMinValue,
    numberMaxValue: doc.numberMaxValue,
    unit: doc.numberUnit,
    decimalPlaces: doc.numberDecimalPlaces,
  };
}

/**
 * ドメインの Question → QuestionDoc の本体フィールド。
 * 画像は assetId と alt だけを保存し、URL は保存しない（期限切れ URL を残さないため）。
 */
export function fromDomainQuestion(
  question: Question,
  context: { quizId: string; ownerId: string },
): Omit<QuestionDoc, 'createdAt' | 'updatedAt'> {
  const base = {
    id: question.id,
    quizId: context.quizId,
    ownerId: context.ownerId,
    position: question.position,
    questionText: question.text,
    questionImageAssetId: question.image?.assetId ?? null,
    questionImageAlt: question.image?.alt ?? null,
    revealImageAssetId: question.revealImage?.assetId ?? null,
    revealImageAlt: question.revealImage?.alt ?? null,
    explanation: question.explanation,
    timeLimitSeconds: question.timeLimitSeconds,
    points: question.points,
  };

  if (question.type === 'number') {
    return {
      ...base,
      questionType: 'number',
      choices: [],
      ...fromNumberRule(question.numberRule),
      numberUnit: question.unit,
      numberDecimalPlaces: question.decimalPlaces,
    };
  }

  return {
    ...base,
    questionType: 'choice',
    choices: question.choices.map((choice) => ({
      id: choice.id,
      position: choice.position,
      text: choice.text,
      imageAssetId: choice.image?.assetId ?? null,
      imageAlt: choice.image?.alt ?? null,
      isCorrect: choice.isCorrect,
    })),
    numberMode: null,
    numberCorrectValue: null,
    numberTolerance: null,
    numberMinValue: null,
    numberMaxValue: null,
    numberUnit: null,
    numberDecimalPlaces: 0,
  };
}

// ---------------------------------------------------------------------------
// quizSnapshot（rooms/{roomId}.quizSnapshot）の防御的な読み取り
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
    timeLimitSeconds: readInt(value, 'timeLimitSeconds', DEFAULT_TIME_LIMIT_SECONDS),
    points: readInt(value, 'points', DEFAULT_POINTS),
    explanation: readString(value, 'explanation'),
  };

  if (readEnum(value, 'type', QUESTION_TYPES) === 'number') {
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

/**
 * `rooms/{roomId}.quizSnapshot` をドメイン型へ復元する。
 * 保存済みデータが壊れていても参加者画面を落とさないよう、既定値で埋めて返す。
 */
export function parseQuizSnapshot(value: unknown): QuizSnapshot {
  const fallbackSettings: QuizSnapshotSettings = {
    showLeaderboard: true,
    showTotalQuestions: true,
    // 既定は「受付開始と同時に出す」。
    showQuestionBeforeOpen: false,
    soundTheme: 'default',
    leaderboardSize: 10,
  };

  if (!isRecord(value)) {
    return { quizId: '', title: '無題のクイズ', settings: fallbackSettings, questions: [] };
  }

  const settingsValue = isRecord(value.settings) ? value.settings : {};

  return {
    quizId: readString(value, 'quizId') ?? '',
    title: readString(value, 'title') ?? '無題のクイズ',
    settings: {
      showLeaderboard: readBoolean(settingsValue, 'showLeaderboard', true),
      showTotalQuestions: readBoolean(settingsValue, 'showTotalQuestions', true),
      showQuestionBeforeOpen: readBoolean(settingsValue, 'showQuestionBeforeOpen', false),
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

/** Firestore へ書き込める素の JSON へ落とす（undefined を含めない）。 */
export function snapshotToPlain(snapshot: QuizSnapshot): QuizSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as QuizSnapshot;
}
