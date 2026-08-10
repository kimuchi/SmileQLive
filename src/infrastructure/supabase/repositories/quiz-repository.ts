import 'server-only';

/**
 * クイズ・問題・選択肢の永続化。
 *
 * 重要な実装方針:
 * - `numeric` カラムは PostgREST が JSON 数値で返すと桁落ちするため、
 *   select 時に `::text` へキャストし、**文字列のまま**保持する。number へ変換しない。
 * - 並び替えは (quiz_id, position) / (question_id, position) の
 *   DEFERRABLE INITIALLY DEFERRED な UNIQUE 制約を利用し、
 *   1 回の upsert（＝1 トランザクション）で入れ替える。
 * - 呼び出し前に所有権検証が済んでいること（管理クライアントは RLS を迂回する）。
 * - 画像 URL は `storage://` 参照から配信直前に解決する。
 */

import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { throwIfDbError } from '@/infrastructure/supabase/repositories/db-errors';
import { getAssetRefs } from '@/infrastructure/supabase/repositories/media-repository';
import {
  isRecord,
  readBoolean,
  readEnum,
  readInt,
  readNumericText,
  readString,
  requireString,
} from '@/infrastructure/supabase/repositories/row-utils';
import { resolveMediaUrls } from '@/infrastructure/supabase/storage/media-storage';
import { AppError } from '@/lib/errors/app-error';
import {
  CHOICE_MAX_COUNT,
  CHOICE_MIN_COUNT,
  choiceLabelFor,
  DEFAULT_POINTS,
  DEFAULT_TIME_LIMIT_SECONDS,
  NUMBER_JUDGEMENT_MODES,
  QUESTION_TYPES,
} from '@/domain/quiz/question';
import type { QuizReadOptions, QuizRepository } from '@/application/ports/quiz-repository-port';
import type {
  ChoiceInput,
  CreateQuestionInput,
  CreateQuizInput,
  UpdateQuestionInput,
  UpdateQuizInput,
} from '@/lib/validation/schemas';
import type {
  AdminChoice,
  AdminMediaRef,
  AdminQuestion,
  AdminQuizDetail,
  QuizListItem,
} from '@/types/api';
import type { ChoiceRow, NumberJudgementModeDb, QuestionRow, QuizRow } from '@/types/database';

/** numeric カラムを text へキャストして取得する（桁落ち防止）。 */
const QUESTION_SELECT = [
  'id',
  'quiz_id',
  'position',
  'question_type',
  'question_text',
  'question_image_asset_id',
  'question_image_alt',
  'reveal_image_asset_id',
  'reveal_image_alt',
  'explanation',
  'time_limit_seconds',
  'points',
  'number_mode',
  'number_unit',
  'number_decimal_places',
  'created_at',
  'updated_at',
  'number_correct_value::text',
  'number_tolerance::text',
  'number_min_value::text',
  'number_max_value::text',
].join(',');

const DEFAULT_QUESTION_TEXT = '新しい問題';

// ---------------------------------------------------------------------------
// 行マッピング
// ---------------------------------------------------------------------------

function mapQuestionRow(record: Record<string, unknown>): QuestionRow {
  return {
    id: requireString(record, 'id'),
    quiz_id: requireString(record, 'quiz_id'),
    position: readInt(record, 'position', 1),
    question_type: readEnum(record, 'question_type', QUESTION_TYPES) ?? 'choice',
    question_text: readString(record, 'question_text'),
    question_image_asset_id: readString(record, 'question_image_asset_id'),
    question_image_alt: readString(record, 'question_image_alt'),
    reveal_image_asset_id: readString(record, 'reveal_image_asset_id'),
    reveal_image_alt: readString(record, 'reveal_image_alt'),
    explanation: readString(record, 'explanation'),
    time_limit_seconds: readInt(record, 'time_limit_seconds', DEFAULT_TIME_LIMIT_SECONDS),
    points: readInt(record, 'points', DEFAULT_POINTS),
    number_mode: readEnum<NumberJudgementModeDb>(record, 'number_mode', NUMBER_JUDGEMENT_MODES),
    number_correct_value: readNumericText(record, 'number_correct_value'),
    number_tolerance: readNumericText(record, 'number_tolerance'),
    number_min_value: readNumericText(record, 'number_min_value'),
    number_max_value: readNumericText(record, 'number_max_value'),
    number_unit: readString(record, 'number_unit'),
    number_decimal_places: readInt(record, 'number_decimal_places', 0),
    created_at: readString(record, 'created_at') ?? new Date(0).toISOString(),
    updated_at: readString(record, 'updated_at') ?? new Date(0).toISOString(),
  };
}

function mapQuestionRows(data: unknown): QuestionRow[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter(isRecord).map(mapQuestionRow);
}

function mapChoiceRecord(record: Record<string, unknown>): ChoiceRow {
  return {
    id: requireString(record, 'id'),
    question_id: requireString(record, 'question_id'),
    position: readInt(record, 'position', 1),
    choice_text: readString(record, 'choice_text'),
    image_asset_id: readString(record, 'image_asset_id'),
    image_alt: readString(record, 'image_alt'),
    is_correct: readBoolean(record, 'is_correct', false),
    created_at: readString(record, 'created_at') ?? new Date(0).toISOString(),
    updated_at: readString(record, 'updated_at') ?? new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 画像参照の解決
// ---------------------------------------------------------------------------

type AssetLookup = Map<string, { url: string | null; width: number; height: number }>;

async function buildAssetLookup(
  assetIds: (string | null)[],
  options: QuizReadOptions,
): Promise<AssetLookup> {
  const ids = assetIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  const refs = await getAssetRefs(ids);
  const lookup: AssetLookup = new Map();

  const entries = [...refs.entries()];
  if (entries.length === 0) {
    return lookup;
  }

  if (options.resolveUrls === false) {
    for (const [assetId, ref] of entries) {
      lookup.set(assetId, { url: ref.ref, width: ref.width, height: ref.height });
    }
    return lookup;
  }

  const urls = await resolveMediaUrls(entries.map(([, ref]) => ref.ref));
  entries.forEach(([assetId, ref], index) => {
    lookup.set(assetId, { url: urls[index] ?? null, width: ref.width, height: ref.height });
  });
  return lookup;
}

function toMediaRef(
  assetId: string | null,
  alt: string | null,
  lookup: AssetLookup,
): AdminMediaRef | null {
  if (!assetId) {
    return null;
  }
  const entry = lookup.get(assetId);
  if (!entry || entry.url === null) {
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

function toAdminChoice(row: ChoiceRow, lookup: AssetLookup): AdminChoice {
  return {
    id: row.id,
    position: row.position,
    text: row.choice_text,
    image: toMediaRef(row.image_asset_id, row.image_alt, lookup),
    isCorrect: row.is_correct,
  };
}

function toAdminQuestion(
  row: QuestionRow,
  choices: ChoiceRow[],
  lookup: AssetLookup,
): AdminQuestion {
  return {
    id: row.id,
    position: row.position,
    type: row.question_type,
    text: row.question_text,
    image: toMediaRef(row.question_image_asset_id, row.question_image_alt, lookup),
    revealImage: toMediaRef(row.reveal_image_asset_id, row.reveal_image_alt, lookup),
    explanation: row.explanation,
    timeLimitSeconds: row.time_limit_seconds,
    points: row.points,
    choices: choices
      .filter((choice) => choice.question_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((choice) => toAdminChoice(choice, lookup)),
    numberMode: row.number_mode,
    numberCorrectValue: row.number_correct_value,
    numberTolerance: row.number_tolerance,
    numberMinValue: row.number_min_value,
    numberMaxValue: row.number_max_value,
    unit: row.number_unit,
    decimalPlaces: row.number_decimal_places,
  };
}

// ---------------------------------------------------------------------------
// 取得系
// ---------------------------------------------------------------------------

async function fetchQuestionRows(quizId: string): Promise<QuestionRow[]> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('questions')
    .select(QUESTION_SELECT)
    .eq('quiz_id', quizId)
    .order('position', { ascending: true });

  throwIfDbError(error);
  return mapQuestionRows(data);
}

async function fetchQuestionRow(questionId: string): Promise<QuestionRow | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('questions')
    .select(QUESTION_SELECT)
    .eq('id', questionId)
    .maybeSingle();

  throwIfDbError(error);
  return isRecord(data) ? mapQuestionRow(data) : null;
}

async function fetchChoiceRows(questionIds: string[]): Promise<ChoiceRow[]> {
  if (questionIds.length === 0) {
    return [];
  }
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('choices')
    .select('*')
    .in('question_id', questionIds)
    .order('position', { ascending: true });

  throwIfDbError(error);
  return (data ?? []).map((row) => mapChoiceRecord(row));
}

export async function listQuizzes(ownerId: string): Promise<QuizListItem[]> {
  const admin = createSupabaseAdminClient();
  const { data: quizzes, error } = await admin
    .from('quizzes')
    .select('*')
    .eq('owner_id', ownerId)
    .neq('status', 'archived')
    .order('updated_at', { ascending: false });

  throwIfDbError(error);
  const rows = quizzes ?? [];
  if (rows.length === 0) {
    return [];
  }

  const { data: questions, error: questionError } = await admin
    .from('questions')
    .select('quiz_id,question_type')
    .in(
      'quiz_id',
      rows.map((quiz) => quiz.id),
    );
  throwIfDbError(questionError);

  const counts = new Map<string, { total: number; choice: number; number: number }>();
  for (const question of questions ?? []) {
    const entry = counts.get(question.quiz_id) ?? { total: 0, choice: 0, number: 0 };
    entry.total += 1;
    if (question.question_type === 'choice') {
      entry.choice += 1;
    } else {
      entry.number += 1;
    }
    counts.set(question.quiz_id, entry);
  }

  return rows.map((quiz) => {
    const entry = counts.get(quiz.id) ?? { total: 0, choice: 0, number: 0 };
    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      status: quiz.status,
      questionCount: entry.total,
      choiceQuestionCount: entry.choice,
      numberQuestionCount: entry.number,
      showLeaderboard: quiz.show_leaderboard,
      createdAt: quiz.created_at,
      updatedAt: quiz.updated_at,
    };
  });
}

export async function getQuizDetail(
  quizId: string,
  options: QuizReadOptions = {},
): Promise<AdminQuizDetail | null> {
  const admin = createSupabaseAdminClient();
  const { data: quiz, error } = await admin
    .from('quizzes')
    .select('*')
    .eq('id', quizId)
    .maybeSingle();

  throwIfDbError(error);
  if (!quiz) {
    return null;
  }

  return buildQuizDetail(quiz, options);
}

async function buildQuizDetail(quiz: QuizRow, options: QuizReadOptions): Promise<AdminQuizDetail> {
  const questions = await fetchQuestionRows(quiz.id);
  const choices = await fetchChoiceRows(questions.map((question) => question.id));

  const lookup = await buildAssetLookup(
    [
      ...questions.flatMap((question) => [
        question.question_image_asset_id,
        question.reveal_image_asset_id,
      ]),
      ...choices.map((choice) => choice.image_asset_id),
    ],
    options,
  );

  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    status: quiz.status,
    showLeaderboard: quiz.show_leaderboard,
    soundTheme: quiz.sound_theme,
    updatedAt: quiz.updated_at,
    questions: questions
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((question) => toAdminQuestion(question, choices, lookup)),
  };
}

async function requireQuizDetail(
  quizId: string,
  options: QuizReadOptions = {},
): Promise<AdminQuizDetail> {
  const detail = await getQuizDetail(quizId, options);
  if (!detail) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  return detail;
}

// ---------------------------------------------------------------------------
// クイズ更新系
// ---------------------------------------------------------------------------

export async function createQuiz(
  ownerId: string,
  input: CreateQuizInput,
): Promise<AdminQuizDetail> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('quizzes')
    .insert({
      owner_id: ownerId,
      title: input.title,
      description: input.description ?? null,
      status: 'draft',
    })
    .select('*')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('INTERNAL_ERROR');
  }
  return buildQuizDetail(data, {});
}

export async function updateQuiz(quizId: string, input: UpdateQuizInput): Promise<AdminQuizDetail> {
  const admin = createSupabaseAdminClient();
  const patch: Partial<QuizRow> = {};
  if (input.title !== undefined) {
    patch.title = input.title;
  }
  if (input.description !== undefined) {
    patch.description = input.description;
  }
  if (input.showLeaderboard !== undefined) {
    patch.show_leaderboard = input.showLeaderboard;
  }
  if (input.soundTheme !== undefined) {
    patch.sound_theme = input.soundTheme;
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from('quizzes').update(patch).eq('id', quizId);
    throwIfDbError(error);
  }

  return requireQuizDetail(quizId);
}

export async function archiveQuiz(quizId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('quizzes').update({ status: 'archived' }).eq('id', quizId);
  throwIfDbError(error);
}

export async function publishQuiz(quizId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('quizzes').update({ status: 'published' }).eq('id', quizId);
  throwIfDbError(error);
}

export async function duplicateQuiz(quizId: string, ownerId: string): Promise<AdminQuizDetail> {
  const admin = createSupabaseAdminClient();

  const { data: source, error } = await admin
    .from('quizzes')
    .select('*')
    .eq('id', quizId)
    .maybeSingle();
  throwIfDbError(error);
  if (!source) {
    throw new AppError('QUIZ_NOT_FOUND');
  }

  const questions = await fetchQuestionRows(quizId);
  const choices = await fetchChoiceRows(questions.map((question) => question.id));

  const title = `${source.title}（コピー）`.slice(0, 100);
  const { data: created, error: createError } = await admin
    .from('quizzes')
    .insert({
      owner_id: ownerId,
      title,
      description: source.description,
      status: 'draft',
      show_leaderboard: source.show_leaderboard,
      sound_theme: source.sound_theme,
    })
    .select('*')
    .single();
  throwIfDbError(createError);
  if (!created) {
    throw new AppError('INTERNAL_ERROR');
  }

  if (questions.length > 0) {
    const idMap = new Map<string, string>();
    const questionInserts = questions.map((question) => {
      const newId = crypto.randomUUID();
      idMap.set(question.id, newId);
      return {
        id: newId,
        quiz_id: created.id,
        position: question.position,
        question_type: question.question_type,
        question_text: question.question_text,
        question_image_asset_id: question.question_image_asset_id,
        question_image_alt: question.question_image_alt,
        reveal_image_asset_id: question.reveal_image_asset_id,
        reveal_image_alt: question.reveal_image_alt,
        explanation: question.explanation,
        time_limit_seconds: question.time_limit_seconds,
        points: question.points,
        number_mode: question.number_mode,
        number_correct_value: question.number_correct_value,
        number_tolerance: question.number_tolerance,
        number_min_value: question.number_min_value,
        number_max_value: question.number_max_value,
        number_unit: question.number_unit,
        number_decimal_places: question.number_decimal_places,
      };
    });

    const { error: questionError } = await admin.from('questions').insert(questionInserts);
    throwIfDbError(questionError);

    if (choices.length > 0) {
      const choiceInserts = choices.flatMap((choice) => {
        const newQuestionId = idMap.get(choice.question_id);
        if (!newQuestionId) {
          return [];
        }
        return [
          {
            question_id: newQuestionId,
            position: choice.position,
            choice_text: choice.choice_text,
            image_asset_id: choice.image_asset_id,
            image_alt: choice.image_alt,
            is_correct: choice.is_correct,
          },
        ];
      });
      const { error: choiceError } = await admin.from('choices').insert(choiceInserts);
      throwIfDbError(choiceError);
    }
  }

  return buildQuizDetail(created, {});
}

// ---------------------------------------------------------------------------
// 問題更新系
// ---------------------------------------------------------------------------

type QuestionPatch = Omit<QuestionRow, 'id' | 'quiz_id' | 'created_at' | 'updated_at' | 'position'>;

function buildQuestionPatch(
  input: CreateQuestionInput | UpdateQuestionInput,
  previous: QuestionRow | null,
): QuestionPatch {
  const text = input.text !== undefined ? input.text : (previous?.question_text ?? null);
  const imageAssetId =
    input.imageAssetId !== undefined
      ? input.imageAssetId
      : (previous?.question_image_asset_id ?? null);

  // 問題文・問題画像のどちらも無い状態を DB 制約が拒否するため、既定文言で埋める。
  const safeText =
    (text === null || text.trim().length === 0) && !imageAssetId ? DEFAULT_QUESTION_TEXT : text;

  const base = {
    question_text: safeText,
    question_image_asset_id: imageAssetId,
    question_image_alt:
      input.imageAlt !== undefined ? input.imageAlt : (previous?.question_image_alt ?? null),
    reveal_image_asset_id:
      input.revealImageAssetId !== undefined
        ? input.revealImageAssetId
        : (previous?.reveal_image_asset_id ?? null),
    reveal_image_alt:
      input.revealImageAlt !== undefined
        ? input.revealImageAlt
        : (previous?.reveal_image_alt ?? null),
    explanation:
      input.explanation !== undefined ? input.explanation : (previous?.explanation ?? null),
    time_limit_seconds:
      input.timeLimitSeconds ?? previous?.time_limit_seconds ?? DEFAULT_TIME_LIMIT_SECONDS,
    points: input.points ?? previous?.points ?? DEFAULT_POINTS,
  };

  if (input.type === 'choice') {
    return {
      ...base,
      question_type: 'choice',
      number_mode: null,
      number_correct_value: null,
      number_tolerance: null,
      number_min_value: null,
      number_max_value: null,
      number_unit: null,
      number_decimal_places: 0,
    };
  }

  const rule = input.numberRule ?? { mode: 'exact' as const, correctValue: '0' };
  const numberColumns = {
    number_mode: rule.mode,
    number_correct_value: rule.mode === 'range' ? null : rule.correctValue,
    number_tolerance: rule.mode === 'absolute_tolerance' ? rule.tolerance : null,
    number_min_value: rule.mode === 'range' ? rule.minValue : null,
    number_max_value: rule.mode === 'range' ? rule.maxValue : null,
  };

  return {
    ...base,
    question_type: 'number',
    ...numberColumns,
    number_unit: input.unit !== undefined ? input.unit : (previous?.number_unit ?? null),
    number_decimal_places: input.decimalPlaces ?? previous?.number_decimal_places ?? 0,
  };
}

async function nextQuestionPosition(quizId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('questions')
    .select('position')
    .eq('quiz_id', quizId)
    .order('position', { ascending: false })
    .limit(1);
  throwIfDbError(error);
  const top = data?.[0];
  return (top?.position ?? 0) + 1;
}

async function insertDefaultChoices(questionId: string, input: CreateQuestionInput): Promise<void> {
  const provided = input.type === 'choice' ? input.choices : undefined;
  const rows =
    provided && provided.length >= CHOICE_MIN_COUNT
      ? provided.map((choice) => ({
          question_id: questionId,
          position: choice.position,
          choice_text:
            choice.text && choice.text.trim().length > 0
              ? choice.text
              : choice.imageAssetId
                ? null
                : `選択肢${choiceLabelFor(choice.position)}`,
          image_asset_id: choice.imageAssetId ?? null,
          image_alt: choice.imageAlt ?? null,
          is_correct: choice.isCorrect,
        }))
      : Array.from({ length: CHOICE_MIN_COUNT }, (_, index) => ({
          question_id: questionId,
          position: index + 1,
          choice_text: `選択肢${choiceLabelFor(index + 1)}`,
          image_asset_id: null,
          image_alt: null,
          is_correct: index === 0,
        }));

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('choices').insert(rows);
  throwIfDbError(error);
}

export async function createQuestion(
  quizId: string,
  input: CreateQuestionInput,
): Promise<AdminQuestion> {
  const admin = createSupabaseAdminClient();
  const position = await nextQuestionPosition(quizId);
  const patch = buildQuestionPatch(input, null);

  const { data, error } = await admin
    .from('questions')
    .insert({ ...patch, quiz_id: quizId, position })
    .select('id')
    .single();
  throwIfDbError(error);
  if (!data) {
    throw new AppError('INTERNAL_ERROR');
  }

  if (input.type === 'choice') {
    await insertDefaultChoices(data.id, input);
  }

  return requireAdminQuestion(data.id);
}

export async function updateQuestion(
  questionId: string,
  input: UpdateQuestionInput,
): Promise<AdminQuestion> {
  const admin = createSupabaseAdminClient();
  const previous = await fetchQuestionRow(questionId);
  if (!previous) {
    throw new AppError('QUESTION_NOT_FOUND');
  }

  const patch = buildQuestionPatch(input, previous);
  const { error } = await admin.from('questions').update(patch).eq('id', questionId);
  throwIfDbError(error);

  if (input.type === 'choice') {
    await replaceChoices(questionId, input.choices);
  } else if (previous.question_type === 'choice') {
    // 選択式から数値式へ変えたときは選択肢を消す。
    const { error: deleteError } = await admin
      .from('choices')
      .delete()
      .eq('question_id', questionId);
    throwIfDbError(deleteError);
  }

  return requireAdminQuestion(questionId);
}

async function replaceChoices(questionId: string, choices: ChoiceInput[]): Promise<void> {
  const admin = createSupabaseAdminClient();

  const { error: deleteError } = await admin.from('choices').delete().eq('question_id', questionId);
  throwIfDbError(deleteError);

  const rows = choices.map((choice) => ({
    id: choice.id ?? crypto.randomUUID(),
    question_id: questionId,
    position: choice.position,
    choice_text:
      choice.text && choice.text.trim().length > 0
        ? choice.text
        : choice.imageAssetId
          ? null
          : `選択肢${choiceLabelFor(choice.position)}`,
    image_asset_id: choice.imageAssetId ?? null,
    image_alt: choice.imageAlt ?? null,
    is_correct: choice.isCorrect,
  }));

  const { error } = await admin.from('choices').insert(rows);
  throwIfDbError(error);
}

export async function deleteQuestion(questionId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const question = await fetchQuestionRow(questionId);
  if (!question) {
    return;
  }

  const { error } = await admin.from('questions').delete().eq('id', questionId);
  throwIfDbError(error);

  await compactQuestionPositions(question.quiz_id);
}

/** 削除後に position を 1..N の連番へ詰め直す。 */
async function compactQuestionPositions(quizId: string): Promise<void> {
  const rows = await fetchQuestionRows(quizId);
  const ordered = rows.slice().sort((a, b) => a.position - b.position);
  const needsUpdate = ordered.some((row, index) => row.position !== index + 1);
  if (!needsUpdate) {
    return;
  }
  await upsertQuestionPositions(ordered.map((row, index) => ({ row, position: index + 1 })));
}

/**
 * position の一括更新。
 * (quiz_id, position) の UNIQUE 制約は DEFERRABLE INITIALLY DEFERRED なので、
 * 1 回の upsert（＝単一トランザクション）なら入れ替え途中の重複が許容される。
 */
async function upsertQuestionPositions(
  entries: Array<{ row: QuestionRow; position: number }>,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const admin = createSupabaseAdminClient();
  const payload = entries.map(({ row, position }) => ({
    id: row.id,
    quiz_id: row.quiz_id,
    position,
    question_type: row.question_type,
    question_text: row.question_text,
    question_image_asset_id: row.question_image_asset_id,
    question_image_alt: row.question_image_alt,
    reveal_image_asset_id: row.reveal_image_asset_id,
    reveal_image_alt: row.reveal_image_alt,
    explanation: row.explanation,
    time_limit_seconds: row.time_limit_seconds,
    points: row.points,
    number_mode: row.number_mode,
    number_correct_value: row.number_correct_value,
    number_tolerance: row.number_tolerance,
    number_min_value: row.number_min_value,
    number_max_value: row.number_max_value,
    number_unit: row.number_unit,
    number_decimal_places: row.number_decimal_places,
  }));

  const { error } = await admin.from('questions').upsert(payload, { onConflict: 'id' });
  throwIfDbError(error);
}

export async function reorderQuestions(quizId: string, questionIds: string[]): Promise<void> {
  const rows = await fetchQuestionRows(quizId);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const ordered: QuestionRow[] = [];
  for (const id of questionIds) {
    const row = byId.get(id);
    if (row) {
      ordered.push(row);
      byId.delete(id);
    }
  }
  // 指定に含まれなかった問題は既存順で末尾へ回す。
  for (const row of [...byId.values()].sort((a, b) => a.position - b.position)) {
    ordered.push(row);
  }

  await upsertQuestionPositions(ordered.map((row, index) => ({ row, position: index + 1 })));
}

async function requireAdminQuestion(questionId: string): Promise<AdminQuestion> {
  const row = await fetchQuestionRow(questionId);
  if (!row) {
    throw new AppError('QUESTION_NOT_FOUND');
  }
  const choices = await fetchChoiceRows([questionId]);
  const lookup = await buildAssetLookup(
    [
      row.question_image_asset_id,
      row.reveal_image_asset_id,
      ...choices.map((choice) => choice.image_asset_id),
    ],
    {},
  );
  return toAdminQuestion(row, choices, lookup);
}

// ---------------------------------------------------------------------------
// 選択肢更新系
// ---------------------------------------------------------------------------

export async function addChoice(questionId: string): Promise<AdminChoice> {
  const admin = createSupabaseAdminClient();
  const existing = await fetchChoiceRows([questionId]);
  if (existing.length >= CHOICE_MAX_COUNT) {
    throw new AppError('CHOICE_LIMIT_REACHED');
  }

  const position = existing.length + 1;
  const { data, error } = await admin
    .from('choices')
    .insert({
      question_id: questionId,
      position,
      choice_text: `選択肢${choiceLabelFor(position)}`,
      is_correct: false,
    })
    .select('*')
    .single();

  throwIfDbError(error);
  if (!data) {
    throw new AppError('INTERNAL_ERROR');
  }
  return toAdminChoice(mapChoiceRecord(data), new Map());
}

export async function deleteChoice(choiceId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { data: choice, error } = await admin
    .from('choices')
    .select('question_id')
    .eq('id', choiceId)
    .maybeSingle();
  throwIfDbError(error);
  if (!choice) {
    return;
  }

  const existing = await fetchChoiceRows([choice.question_id]);
  if (existing.length <= CHOICE_MIN_COUNT) {
    throw new AppError('CHOICE_MINIMUM_REACHED');
  }

  const { error: deleteError } = await admin.from('choices').delete().eq('id', choiceId);
  throwIfDbError(deleteError);

  const remaining = existing
    .filter((row) => row.id !== choiceId)
    .sort((a, b) => a.position - b.position);
  await upsertChoicePositions(remaining.map((row, index) => ({ row, position: index + 1 })));
}

async function upsertChoicePositions(
  entries: Array<{ row: ChoiceRow; position: number }>,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const admin = createSupabaseAdminClient();
  const payload = entries.map(({ row, position }) => ({
    id: row.id,
    question_id: row.question_id,
    position,
    choice_text: row.choice_text,
    image_asset_id: row.image_asset_id,
    image_alt: row.image_alt,
    is_correct: row.is_correct,
  }));
  const { error } = await admin.from('choices').upsert(payload, { onConflict: 'id' });
  throwIfDbError(error);
}

export async function reorderChoices(questionId: string, choiceIds: string[]): Promise<void> {
  const rows = await fetchChoiceRows([questionId]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const ordered: ChoiceRow[] = [];
  for (const id of choiceIds) {
    const row = byId.get(id);
    if (row) {
      ordered.push(row);
      byId.delete(id);
    }
  }
  for (const row of [...byId.values()].sort((a, b) => a.position - b.position)) {
    ordered.push(row);
  }

  await upsertChoicePositions(ordered.map((row, index) => ({ row, position: index + 1 })));
}

export const quizRepository: QuizRepository = {
  listQuizzes,
  getQuizDetail,
  createQuiz,
  updateQuiz,
  archiveQuiz,
  duplicateQuiz,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  reorderQuestions,
  addChoice,
  deleteChoice,
  reorderChoices,
  publishQuiz,
};
