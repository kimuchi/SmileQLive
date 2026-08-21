import 'server-only';

/**
 * クイズ・問題・選択肢の永続化（Firestore 版）。
 *
 * 重要な実装方針:
 * - 選択肢は問題ドキュメントへ**配列として埋め込む**（最大 5 件）。
 *   1 問の更新が 1 回の書き込みで原子的に済む。
 * - 数値の正解値・許容誤差・範囲は**文字列のまま**保存する。Firestore の number へ入れない。
 * - 公開検証は `validateQuizForPublish()`（サーバー側）が唯一の検証。必ず publish 時に実行する。
 * - 識別子は UUID を生成する（API ルートが UUID 形式を要求するため）。
 * - 呼び出し前に所有権検証が済んでいること（Admin SDK は Security Rules を迂回する）。
 * - 画像は `storage://` 参照のまま保持し、配信直前に署名付き URL へ解決する。
 *
 * questionId だけを受け取る操作（updateQuestion / deleteQuestion / addChoice など）について:
 *   問題は `quizzes/{quizId}/questions/{questionId}` に置くため、親クイズが分からないと参照できない。
 *   コレクショングループ検索は専用インデックスが要る（firebase/firestore.indexes.json は
 *   COLLECTION スコープのみ）ので、ここでは「クイズ一覧 → getAll で一括参照」して解決する。
 *   呼び出し側が quizId / ownerId を知っている場合は hints で渡すと 1 回の読み取りで済む。
 */

import { getDb } from '@/infrastructure/firebase/admin';
import {
  questionRef,
  questionsCollection,
  quizRef,
  quizzesCollection,
} from '@/infrastructure/firebase/paths';
import {
  nowTimestamp,
  toAdminChoice,
  toAdminQuestion,
  toDomainQuestion,
  toIsoOr,
  EMPTY_MEDIA_LOOKUP,
  type MediaAssetLookup,
} from '@/infrastructure/firebase/converters';
import { buildMediaLookup } from '@/infrastructure/firebase/repositories/media-repository';
import {
  validateQuizForPublish,
  type PublishValidationResult,
} from '@/domain/quiz/publish-validation';
import {
  CHOICE_MAX_COUNT,
  CHOICE_MIN_COUNT,
  choiceLabelFor,
  DEFAULT_POINTS,
  DEFAULT_TIME_LIMIT_SECONDS,
} from '@/domain/quiz/question';
import { AppError } from '@/lib/errors/app-error';
import type { QuizReadOptions, QuizRepository } from '@/application/ports/quiz-repository-port';
import type {
  ChoiceInput,
  CreateQuestionInput,
  CreateQuizInput,
  UpdateQuestionInput,
  UpdateQuizInput,
} from '@/lib/validation/schemas';
import type { AdminChoice, AdminQuestion, AdminQuizDetail, QuizListItem } from '@/types/api';
import type { ChoiceEmbedded, QuestionDoc, QuizDoc } from '@/types/firestore';

/** 問題文も問題画像も無い状態を避けるための既定文言。 */
const DEFAULT_QUESTION_TEXT = '新しい問題';

/** 一覧に出さない状態。 */
const LISTED_STATUSES = ['draft', 'published'] as const;

/** getAll へ一度に渡す参照の上限。 */
const GET_ALL_CHUNK = 300;

/** 問題の所在を絞り込むためのヒント（分かっていれば読み取りを減らせる）。 */
export type QuestionLookupHints = { quizId?: string | null; ownerId?: string | null };

type QuestionLocation = { quizId: string; question: QuestionDoc };

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** 問題・選択肢が参照している画像 ID をすべて集める。 */
function collectAssetIds(questions: readonly QuestionDoc[]): (string | null)[] {
  return [
    ...questions.flatMap((question) => [
      question.questionImageAssetId,
      question.revealImageAssetId,
    ]),
    ...questions.flatMap((question) => question.choices.map((choice) => choice.imageAssetId)),
  ];
}

async function fetchQuiz(quizId: string): Promise<QuizDoc | null> {
  const snapshot = await quizRef(quizId).get();
  return snapshot.data() ?? null;
}

async function requireQuiz(quizId: string): Promise<QuizDoc> {
  const quiz = await fetchQuiz(quizId);
  if (!quiz) {
    throw new AppError('QUIZ_NOT_FOUND');
  }
  return quiz;
}

async function fetchQuestions(quizId: string): Promise<QuestionDoc[]> {
  const snapshot = await questionsCollection(quizId).orderBy('position', 'asc').get();
  return snapshot.docs.map((doc) => doc.data());
}

/** クイズ ID の一覧。ownerId が分かっていれば所有者のものだけへ絞る。 */
async function listQuizIds(ownerId?: string | null): Promise<string[]> {
  const query = ownerId ? quizzesCollection().where('ownerId', '==', ownerId) : quizzesCollection();
  // 本文は不要なので射影で取得量を抑える。
  const snapshot = await query.select().get();
  return snapshot.docs.map((doc) => doc.id);
}

/**
 * questionId から親クイズごと問題を引く。
 * hints.quizId があれば 1 回の読み取りで済む。
 */
export async function findQuestion(
  questionId: string,
  hints: QuestionLookupHints = {},
): Promise<QuestionLocation | null> {
  if (hints.quizId) {
    const snapshot = await questionRef(hints.quizId, questionId).get();
    const data = snapshot.data();
    if (data) {
      return { quizId: hints.quizId, question: data };
    }
    return null;
  }

  const quizIds = await listQuizIds(hints.ownerId);
  for (const ids of chunk(quizIds, GET_ALL_CHUNK)) {
    // Firestore.getAll() は型引数を取らないため戻り値は DocumentData。
    // 書き込みは Admin SDK 経由のみなので、形は QuestionDoc であることが保証される。
    const snapshots = await getDb().getAll(...ids.map((id) => questionRef(id, questionId)));
    for (const snapshot of snapshots) {
      const data = snapshot.data();
      if (data) {
        const question = data as QuestionDoc;
        return { quizId: question.quizId, question };
      }
    }
  }
  return null;
}

async function requireQuestion(
  questionId: string,
  hints: QuestionLookupHints = {},
): Promise<QuestionLocation> {
  const found = await findQuestion(questionId, hints);
  if (!found) {
    throw new AppError('QUESTION_NOT_FOUND');
  }
  return found;
}

/**
 * choiceId から、その選択肢を含む問題を引く。
 * 選択肢は問題ドキュメントへ埋め込むため単独では検索できず、
 * 所有者（分かれば）のクイズを走査して突き合わせる。管理画面のまれな操作なので許容する。
 */
export async function findQuestionByChoiceId(
  choiceId: string,
  hints: QuestionLookupHints = {},
): Promise<QuestionLocation | null> {
  const quizIds = hints.quizId ? [hints.quizId] : await listQuizIds(hints.ownerId);

  for (const quizId of quizIds) {
    const questions = await fetchQuestions(quizId);
    const match = questions.find((question) =>
      question.choices.some((choice) => choice.id === choiceId),
    );
    if (match) {
      return { quizId, question: match };
    }
  }
  return null;
}

/** 問題数の再集計。問題の追加・削除・型変更のあとに必ず呼ぶ。 */
async function refreshQuizCounts(
  quizId: string,
  questions?: readonly QuestionDoc[],
): Promise<void> {
  const docs = questions ?? (await fetchQuestions(quizId));
  const choiceCount = docs.filter((question) => question.questionType === 'choice').length;

  await quizRef(quizId).update({
    questionCount: docs.length,
    choiceQuestionCount: choiceCount,
    numberQuestionCount: docs.length - choiceCount,
    updatedAt: nowTimestamp(),
  });
}

async function touchQuiz(quizId: string): Promise<void> {
  await quizRef(quizId).update({ updatedAt: nowTimestamp() });
}

// ---------------------------------------------------------------------------
// 取得系
// ---------------------------------------------------------------------------

function toQuizListItem(quiz: QuizDoc, viewerId: string): QuizListItem {
  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    status: quiz.status,
    questionCount: quiz.questionCount,
    choiceQuestionCount: quiz.choiceQuestionCount,
    numberQuestionCount: quiz.numberQuestionCount,
    showLeaderboard: quiz.showLeaderboard,
    createdAt: toIsoOr(quiz.createdAt),
    updatedAt: toIsoOr(quiz.updatedAt),
    owned: quiz.ownerId === viewerId,
  };
}

/**
 * 自分のクイズと、自分へ共有されたクイズを合わせて返す。
 *
 * Firestore は OR 条件を 1 クエリで書けないため 2 回引いて結合する。
 * 共有されたものは `owned: false` で返し、画面側で編集導線を出さない。
 */
export async function listQuizzes(viewerId: string): Promise<QuizListItem[]> {
  const [owned, shared] = await Promise.all([
    quizzesCollection()
      .where('ownerId', '==', viewerId)
      .where('status', 'in', [...LISTED_STATUSES])
      .get(),
    quizzesCollection()
      .where('sharedWith', 'array-contains', viewerId)
      .where('status', 'in', [...LISTED_STATUSES])
      .get(),
  ]);

  const byId = new Map<string, QuizDoc>();
  for (const doc of [...owned.docs, ...shared.docs]) {
    byId.set(doc.id, doc.data());
  }

  return [...byId.values()]
    .sort((a, b) => toIsoOr(b.updatedAt).localeCompare(toIsoOr(a.updatedAt)))
    .map((quiz) => toQuizListItem(quiz, viewerId));
}

/** 共有相手を置き換える（所有者自身は含めない）。 */
export async function setQuizShares(quizId: string, uids: readonly string[]): Promise<void> {
  const quiz = await requireQuiz(quizId);
  const unique = [...new Set(uids)].filter((uid) => uid !== quiz.ownerId);
  await quizRef(quizId).update({ sharedWith: unique, updatedAt: nowTimestamp() });
}

/** 共有相手の uid 一覧。 */
export async function getQuizShares(quizId: string): Promise<string[]> {
  const quiz = await requireQuiz(quizId);
  return quiz.sharedWith ?? [];
}

async function buildQuizDetail(
  quiz: QuizDoc,
  questions: QuestionDoc[],
  options: QuizReadOptions,
): Promise<AdminQuizDetail> {
  const lookup = await buildMediaLookup(collectAssetIds(questions), options);

  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    status: quiz.status,
    showLeaderboard: quiz.showLeaderboard,
    // 古いクイズには無い項目。既定へ寄せる（未設定＝全問数は出す／先出しはしない）。
    showTotalQuestions: quiz.showTotalQuestions !== false,
    showQuestionBeforeOpen: quiz.showQuestionBeforeOpen === true,
    alwaysShowJoinCode: quiz.alwaysShowJoinCode === true,
    soundTheme: quiz.soundTheme,
    updatedAt: toIsoOr(quiz.updatedAt),
    questions: questions
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((question) => toAdminQuestion(question, lookup)),
  };
}

export async function getQuizDetail(
  quizId: string,
  options: QuizReadOptions = {},
): Promise<AdminQuizDetail | null> {
  const quiz = await fetchQuiz(quizId);
  if (!quiz) {
    return null;
  }
  const questions = await fetchQuestions(quizId);
  return buildQuizDetail(quiz, questions, options);
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

async function requireAdminQuestion(location: QuestionLocation): Promise<AdminQuestion> {
  const lookup = await buildMediaLookup(collectAssetIds([location.question]));
  return toAdminQuestion(location.question, lookup);
}

// ---------------------------------------------------------------------------
// クイズ更新系
// ---------------------------------------------------------------------------

export async function createQuiz(
  ownerId: string,
  input: CreateQuizInput,
): Promise<AdminQuizDetail> {
  const now = nowTimestamp();
  const quiz: QuizDoc = {
    id: newId(),
    ownerId,
    title: input.title,
    description: input.description ?? null,
    status: 'draft',
    showLeaderboard: true,
    showTotalQuestions: true,
    // 既定は「受付開始と同時に問題を出す」。
    showQuestionBeforeOpen: false,
    // 既定は「開始前の待機画面にだけ大きく出す」。
    alwaysShowJoinCode: false,
    soundTheme: 'default',
    // 既定は共有なし。array-contains のクエリ対象になるため空配列で作る。
    sharedWith: [],
    questionCount: 0,
    choiceQuestionCount: 0,
    numberQuestionCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await quizRef(quiz.id).create(quiz);
  return buildQuizDetail(quiz, [], {});
}

export async function updateQuiz(quizId: string, input: UpdateQuizInput): Promise<AdminQuizDetail> {
  const patch: Partial<QuizDoc> = {};
  if (input.title !== undefined) {
    patch.title = input.title;
  }
  if (input.description !== undefined) {
    patch.description = input.description;
  }
  if (input.showLeaderboard !== undefined) {
    patch.showLeaderboard = input.showLeaderboard;
  }
  if (input.showTotalQuestions !== undefined) {
    patch.showTotalQuestions = input.showTotalQuestions;
  }
  if (input.showQuestionBeforeOpen !== undefined) {
    patch.showQuestionBeforeOpen = input.showQuestionBeforeOpen;
  }
  if (input.alwaysShowJoinCode !== undefined) {
    patch.alwaysShowJoinCode = input.alwaysShowJoinCode;
  }
  if (input.soundTheme !== undefined) {
    patch.soundTheme = input.soundTheme;
  }

  if (Object.keys(patch).length > 0) {
    await quizRef(quizId).update({ ...patch, updatedAt: nowTimestamp() });
  }

  return requireQuizDetail(quizId);
}

export async function archiveQuiz(quizId: string): Promise<void> {
  await quizRef(quizId).update({ status: 'archived', updatedAt: nowTimestamp() });
}

/**
 * 公開前検証。
 * PostgreSQL 版にあった DB 側関数は無くなるため、**この検証だけが公開条件の砦**になる。
 */
export async function validateQuizForPublishById(quizId: string): Promise<PublishValidationResult> {
  const quiz = await requireQuiz(quizId);
  const questions = await fetchQuestions(quizId);

  // URL 解決は不要（画像の有無と代替テキストだけを見る）。署名 URL の無駄な発行を避ける。
  const lookup = await buildMediaLookup(collectAssetIds(questions), { resolveUrls: false });

  return validateQuizForPublish({
    title: quiz.title,
    questions: questions.map((question) => toDomainQuestion(question, lookup)),
  });
}

/** 公開する。検証に通らない場合は QUIZ_PUBLISH_VALIDATION_FAILED（details に issues）。 */
export async function publishQuiz(quizId: string): Promise<void> {
  const result = await validateQuizForPublishById(quizId);
  if (!result.ok) {
    throw new AppError('QUIZ_PUBLISH_VALIDATION_FAILED', { details: result.issues });
  }
  await quizRef(quizId).update({ status: 'published', updatedAt: nowTimestamp() });
}

export async function duplicateQuiz(quizId: string, ownerId: string): Promise<AdminQuizDetail> {
  const source = await requireQuiz(quizId);
  const questions = await fetchQuestions(quizId);

  const now = nowTimestamp();
  const copy: QuizDoc = {
    id: newId(),
    ownerId,
    title: `${source.title}（コピー）`.slice(0, 100),
    description: source.description,
    status: 'draft',
    showLeaderboard: source.showLeaderboard,
    showTotalQuestions: source.showTotalQuestions !== false,
    showQuestionBeforeOpen: source.showQuestionBeforeOpen === true,
    alwaysShowJoinCode: source.alwaysShowJoinCode === true,
    soundTheme: source.soundTheme,
    // 共有設定は引き継がない。複製の所有者が改めて決める。
    sharedWith: [],
    questionCount: questions.length,
    choiceQuestionCount: questions.filter((question) => question.questionType === 'choice').length,
    numberQuestionCount: questions.filter((question) => question.questionType === 'number').length,
    createdAt: now,
    updatedAt: now,
  };

  // 問題・選択肢の ID は振り直す（元クイズと参照を共有しない）。
  const copiedQuestions: QuestionDoc[] = questions.map((question) => ({
    ...question,
    id: newId(),
    quizId: copy.id,
    ownerId,
    choices: question.choices.map((choice) => ({ ...choice, id: newId() })),
    createdAt: now,
    updatedAt: now,
  }));

  const batch = getDb().batch();
  batch.create(quizRef(copy.id), copy);
  for (const question of copiedQuestions) {
    batch.create(questionRef(copy.id, question.id), question);
  }
  await batch.commit();

  return buildQuizDetail(copy, copiedQuestions, {});
}

// ---------------------------------------------------------------------------
// 問題更新系
// ---------------------------------------------------------------------------

function choiceTextOrDefault(choice: ChoiceInput): string | null {
  if (choice.text && choice.text.trim().length > 0) {
    return choice.text;
  }
  return choice.imageAssetId ? null : `選択肢${choiceLabelFor(choice.position)}`;
}

function toEmbeddedChoices(choices: readonly ChoiceInput[]): ChoiceEmbedded[] {
  return choices
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((choice) => ({
      id: choice.id ?? newId(),
      position: choice.position,
      text: choiceTextOrDefault(choice),
      imageAssetId: choice.imageAssetId ?? null,
      imageAlt: choice.imageAlt ?? null,
      isCorrect: choice.isCorrect,
    }));
}

function defaultChoices(): ChoiceEmbedded[] {
  return Array.from({ length: CHOICE_MIN_COUNT }, (_, index) => ({
    id: newId(),
    position: index + 1,
    text: `選択肢${choiceLabelFor(index + 1)}`,
    imageAssetId: null,
    imageAlt: null,
    isCorrect: index === 0,
  }));
}

/**
 * 入力（作成・更新）から問題ドキュメントの本体を組み立てる。
 * 数値項目は文字列のまま扱い、未使用のモードの値は null で潰す。
 */
function buildQuestionFields(
  input: CreateQuestionInput | UpdateQuestionInput,
  previous: QuestionDoc | null,
): Omit<QuestionDoc, 'id' | 'quizId' | 'ownerId' | 'position' | 'createdAt' | 'updatedAt'> {
  const text = input.text !== undefined ? input.text : (previous?.questionText ?? null);
  const imageAssetId =
    input.imageAssetId !== undefined
      ? input.imageAssetId
      : (previous?.questionImageAssetId ?? null);

  // 問題文・問題画像のどちらも無い状態にしない（公開検証で弾かれるため既定文言で埋める）。
  const safeText =
    (text === null || text.trim().length === 0) && !imageAssetId ? DEFAULT_QUESTION_TEXT : text;

  const base = {
    questionText: safeText,
    questionImageAssetId: imageAssetId,
    questionImageAlt:
      input.imageAlt !== undefined ? input.imageAlt : (previous?.questionImageAlt ?? null),
    revealImageAssetId:
      input.revealImageAssetId !== undefined
        ? input.revealImageAssetId
        : (previous?.revealImageAssetId ?? null),
    revealImageAlt:
      input.revealImageAlt !== undefined
        ? input.revealImageAlt
        : (previous?.revealImageAlt ?? null),
    explanation:
      input.explanation !== undefined ? input.explanation : (previous?.explanation ?? null),
    timeLimitSeconds:
      input.timeLimitSeconds ?? previous?.timeLimitSeconds ?? DEFAULT_TIME_LIMIT_SECONDS,
    points: input.points ?? previous?.points ?? DEFAULT_POINTS,
  };

  if (input.type === 'choice') {
    const choices =
      input.choices !== undefined
        ? toEmbeddedChoices(input.choices)
        : previous?.questionType === 'choice' && previous.choices.length >= CHOICE_MIN_COUNT
          ? previous.choices
          : defaultChoices();

    return {
      ...base,
      questionType: 'choice',
      choices,
      numberMode: null,
      numberCorrectValue: null,
      numberTolerance: null,
      numberMinValue: null,
      numberMaxValue: null,
      numberUnit: null,
      numberDecimalPlaces: 0,
    };
  }

  const rule = input.numberRule ?? { mode: 'exact' as const, correctValue: '0' };

  return {
    ...base,
    questionType: 'number',
    // 数値式へ変えたら選択肢は捨てる。
    choices: [],
    numberMode: rule.mode,
    numberCorrectValue: rule.mode === 'range' ? null : rule.correctValue,
    numberTolerance: rule.mode === 'absolute_tolerance' ? rule.tolerance : null,
    numberMinValue: rule.mode === 'range' ? rule.minValue : null,
    numberMaxValue: rule.mode === 'range' ? rule.maxValue : null,
    numberUnit: input.unit !== undefined ? input.unit : (previous?.numberUnit ?? null),
    numberDecimalPlaces: input.decimalPlaces ?? previous?.numberDecimalPlaces ?? 0,
  };
}

async function nextQuestionPosition(quizId: string): Promise<number> {
  const snapshot = await questionsCollection(quizId).orderBy('position', 'desc').limit(1).get();
  const top = snapshot.docs[0]?.data();
  return (top?.position ?? 0) + 1;
}

export async function createQuestion(
  quizId: string,
  input: CreateQuestionInput,
): Promise<AdminQuestion> {
  const quiz = await requireQuiz(quizId);
  const position = await nextQuestionPosition(quizId);
  const now = nowTimestamp();

  const question: QuestionDoc = {
    id: newId(),
    quizId,
    ownerId: quiz.ownerId,
    position,
    ...buildQuestionFields(input, null),
    createdAt: now,
    updatedAt: now,
  };

  await questionRef(quizId, question.id).create(question);
  await refreshQuizCounts(quizId);

  return requireAdminQuestion({ quizId, question });
}

export async function updateQuestion(
  questionId: string,
  input: UpdateQuestionInput,
  hints: QuestionLookupHints = {},
): Promise<AdminQuestion> {
  const { quizId, question } = await requireQuestion(questionId, hints);

  const updated: QuestionDoc = {
    ...question,
    ...buildQuestionFields(input, question),
    updatedAt: nowTimestamp(),
  };

  await questionRef(quizId, questionId).set(updated);

  if (updated.questionType !== question.questionType) {
    await refreshQuizCounts(quizId);
  } else {
    await touchQuiz(quizId);
  }

  return requireAdminQuestion({ quizId, question: updated });
}

export async function deleteQuestion(
  questionId: string,
  hints: QuestionLookupHints = {},
): Promise<void> {
  const found = await findQuestion(questionId, hints);
  if (!found) {
    return;
  }

  await questionRef(found.quizId, questionId).delete();

  // 残った問題の position を 1..N へ詰め直す。
  const remaining = (await fetchQuestions(found.quizId)).sort((a, b) => a.position - b.position);
  const batch = getDb().batch();
  const now = nowTimestamp();
  remaining.forEach((question, index) => {
    if (question.position !== index + 1) {
      batch.update(questionRef(found.quizId, question.id), {
        position: index + 1,
        updatedAt: now,
      });
    }
  });
  await batch.commit();

  await refreshQuizCounts(
    found.quizId,
    remaining.map((question, index) => ({ ...question, position: index + 1 })),
  );
}

export async function reorderQuestions(quizId: string, questionIds: string[]): Promise<void> {
  const questions = await fetchQuestions(quizId);
  const byId = new Map(questions.map((question) => [question.id, question]));

  const ordered: QuestionDoc[] = [];
  for (const id of questionIds) {
    const question = byId.get(id);
    if (question) {
      ordered.push(question);
      byId.delete(id);
    }
  }
  // 指定に含まれなかった問題は既存順で末尾へ回す。
  for (const question of [...byId.values()].sort((a, b) => a.position - b.position)) {
    ordered.push(question);
  }

  const batch = getDb().batch();
  const now = nowTimestamp();
  ordered.forEach((question, index) => {
    if (question.position !== index + 1) {
      batch.update(questionRef(quizId, question.id), { position: index + 1, updatedAt: now });
    }
  });
  batch.update(quizRef(quizId), { updatedAt: now });
  await batch.commit();
}

// ---------------------------------------------------------------------------
// 選択肢更新系（問題ドキュメント内の配列を差し替える）
// ---------------------------------------------------------------------------

function renumber(choices: readonly ChoiceEmbedded[]): ChoiceEmbedded[] {
  return choices
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((choice, index) => ({ ...choice, position: index + 1 }));
}

async function saveChoices(
  quizId: string,
  question: QuestionDoc,
  choices: ChoiceEmbedded[],
): Promise<void> {
  await questionRef(quizId, question.id).update({ choices, updatedAt: nowTimestamp() });
  await touchQuiz(quizId);
}

export async function addChoice(
  questionId: string,
  hints: QuestionLookupHints = {},
): Promise<AdminChoice> {
  const { quizId, question } = await requireQuestion(questionId, hints);

  if (question.questionType !== 'choice') {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'questionId', message: '数値問題には選択肢を追加できません' }],
    });
  }
  if (question.choices.length >= CHOICE_MAX_COUNT) {
    throw new AppError('CHOICE_LIMIT_REACHED');
  }

  const position = question.choices.length + 1;
  const choice: ChoiceEmbedded = {
    id: newId(),
    position,
    text: `選択肢${choiceLabelFor(position)}`,
    imageAssetId: null,
    imageAlt: null,
    isCorrect: false,
  };

  await saveChoices(quizId, question, [...question.choices, choice]);

  return toAdminChoice(choice, EMPTY_MEDIA_LOOKUP);
}

export async function deleteChoice(
  choiceId: string,
  hints: QuestionLookupHints = {},
): Promise<void> {
  const found = await findQuestionByChoiceId(choiceId, hints);
  if (!found) {
    return;
  }

  const { quizId, question } = found;
  if (question.choices.length <= CHOICE_MIN_COUNT) {
    throw new AppError('CHOICE_MINIMUM_REACHED');
  }

  const remaining = renumber(question.choices.filter((choice) => choice.id !== choiceId));
  await saveChoices(quizId, question, remaining);
}

export async function reorderChoices(
  questionId: string,
  choiceIds: string[],
  hints: QuestionLookupHints = {},
): Promise<void> {
  const { quizId, question } = await requireQuestion(questionId, hints);

  const byId = new Map(question.choices.map((choice) => [choice.id, choice]));
  const ordered: ChoiceEmbedded[] = [];
  for (const id of choiceIds) {
    const choice = byId.get(id);
    if (choice) {
      ordered.push(choice);
      byId.delete(id);
    }
  }
  for (const choice of [...byId.values()].sort((a, b) => a.position - b.position)) {
    ordered.push(choice);
  }

  await saveChoices(
    quizId,
    question,
    ordered.map((choice, index) => ({ ...choice, position: index + 1 })),
  );
}

/** 単一問題を API DTO で取り出す（選択肢操作の応答用）。 */
export async function getAdminQuestion(
  questionId: string,
  hints: QuestionLookupHints = {},
): Promise<AdminQuestion> {
  const location = await requireQuestion(questionId, hints);
  return requireAdminQuestion(location);
}

/** 画像 URL を解決しない読み取り（スナップショット生成・公開検証用）。 */
export async function getQuizQuestions(quizId: string): Promise<QuestionDoc[]> {
  return fetchQuestions(quizId);
}

/** テスト・サービス層から使う空の画像表。 */
export const NO_MEDIA: MediaAssetLookup = EMPTY_MEDIA_LOOKUP;

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
