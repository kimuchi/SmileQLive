import { z } from 'zod';
import {
  CHOICE_MAX_COUNT,
  CHOICE_MIN_COUNT,
  DECIMAL_PLACES_MAX,
  DECIMAL_PLACES_MIN,
  EXPLANATION_MAX_LENGTH,
  IMAGE_ALT_MAX_LENGTH,
  POINTS_MAX,
  POINTS_MIN,
  TIME_LIMIT_MAX_SECONDS,
  TIME_LIMIT_MIN_SECONDS,
  UNIT_MAX_LENGTH,
} from '@/domain/quiz/question';
import {
  EXTEND_SECONDS_MAX,
  EXTEND_SECONDS_MIN,
  ROOM_ACTIONS,
} from '@/domain/room/state-machine';
import { ROOM_MODES } from '@/domain/room/room-mode';
import {
  DRAW_ENTRY_MAX_COUNT,
  DRAW_FONT_SIZE_MAX,
  DRAW_FONT_SIZE_MIN,
  DRAW_LABEL_MAX_LENGTH,
  DRAW_LIST_KINDS,
  DRAW_NUMBER_MAX,
  DRAW_NUMBER_MIN,
  SPIN_DURATION_MAX_MS,
  SPIN_DURATION_MIN_MS,
  SPIN_INTERVAL_MAX_MS,
  SPIN_INTERVAL_MIN_MS,
} from '@/domain/draw/draw-list';
import { MEDIA_USAGES } from '@/domain/media/image-policy';

/**
 * すべての API 入力はここで定義した Zod スキーマで検証する。
 * クライアントから送られた role / owner_id / is_correct は信用しない。
 */

export const uuidSchema = z.uuid();

export const nicknameSchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim())
  .pipe(z.string().min(1, 'ニックネームを入力してください').max(20, '20文字以内で入力してください'));

export const joinTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{20,64}$/, 'この参加URLは無効です');

export const presentationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

export const imageAltSchema = z.string().max(IMAGE_ALT_MAX_LENGTH).nullable();

export const mediaUsageSchema = z.enum(MEDIA_USAGES);

// ---------------------------------------------------------------------------
// 管理: クイズ
// ---------------------------------------------------------------------------

export const createQuizSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
});

export const updateQuizSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
  showLeaderboard: z.boolean().optional(),
  showTotalQuestions: z.boolean().optional(),
  showQuestionBeforeOpen: z.boolean().optional(),
  alwaysShowJoinCode: z.boolean().optional(),
  soundTheme: z.string().max(50).optional(),
});

// ---------------------------------------------------------------------------
// 管理: 問題
// ---------------------------------------------------------------------------

const numberTextSchema = z.string().trim().min(1).max(42);

export const numberRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exact'), correctValue: numberTextSchema }),
  z.object({
    mode: z.literal('absolute_tolerance'),
    correctValue: numberTextSchema,
    tolerance: numberTextSchema,
  }),
  z.object({
    mode: z.literal('range'),
    minValue: numberTextSchema,
    maxValue: numberTextSchema,
  }),
]);

const questionCommonShape = {
  text: z.string().max(1000).nullable().optional(),
  imageAssetId: uuidSchema.nullable().optional(),
  imageAlt: z.string().max(IMAGE_ALT_MAX_LENGTH).nullable().optional(),
  revealImageAssetId: uuidSchema.nullable().optional(),
  revealImageAlt: z.string().max(IMAGE_ALT_MAX_LENGTH).nullable().optional(),
  explanation: z.string().max(EXPLANATION_MAX_LENGTH).nullable().optional(),
  timeLimitSeconds: z.int().min(TIME_LIMIT_MIN_SECONDS).max(TIME_LIMIT_MAX_SECONDS).optional(),
  points: z.int().min(POINTS_MIN).max(POINTS_MAX).optional(),
};

export const choiceInputSchema = z.object({
  id: uuidSchema.optional(),
  position: z.int().min(1).max(CHOICE_MAX_COUNT),
  text: z.string().max(300).nullable().optional(),
  imageAssetId: uuidSchema.nullable().optional(),
  imageAlt: z.string().max(IMAGE_ALT_MAX_LENGTH).nullable().optional(),
  isCorrect: z.boolean(),
});

export const createQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    ...questionCommonShape,
    choices: z.array(choiceInputSchema).min(CHOICE_MIN_COUNT).max(CHOICE_MAX_COUNT).optional(),
  }),
  z.object({
    type: z.literal('number'),
    ...questionCommonShape,
    numberRule: numberRuleSchema.optional(),
    unit: z.string().max(UNIT_MAX_LENGTH).nullable().optional(),
    decimalPlaces: z.int().min(DECIMAL_PLACES_MIN).max(DECIMAL_PLACES_MAX).optional(),
  }),
]);

export const updateQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    ...questionCommonShape,
    choices: z.array(choiceInputSchema).min(CHOICE_MIN_COUNT).max(CHOICE_MAX_COUNT),
  }),
  z.object({
    type: z.literal('number'),
    ...questionCommonShape,
    numberRule: numberRuleSchema,
    unit: z.string().max(UNIT_MAX_LENGTH).nullable().optional(),
    decimalPlaces: z.int().min(DECIMAL_PLACES_MIN).max(DECIMAL_PLACES_MAX),
  }),
]);

/**
 * 共有相手の指定。メールアドレスで受け取り、サーバー側で司会者へ解決する。
 * 一覧をそのまま置き換えるため、空配列は「共有をすべて解除」を意味する。
 */
export const quizShareInputSchema = z.object({
  emails: z.array(z.email().max(254)).max(50),
});

export const reorderQuestionsSchema = z.object({
  questionIds: z.array(uuidSchema).min(1).max(100),
});

export const reorderChoicesSchema = z.object({
  choiceIds: z.array(uuidSchema).min(CHOICE_MIN_COUNT).max(CHOICE_MAX_COUNT),
});

// ---------------------------------------------------------------------------
// 抽選リスト（抽選会・ビンゴ）
// ---------------------------------------------------------------------------

const drawSettingsSchema = z
  .object({
    spinIntervalMs: z.int().min(SPIN_INTERVAL_MIN_MS).max(SPIN_INTERVAL_MAX_MS),
    spinDurationMs: z.int().min(SPIN_DURATION_MIN_MS).max(SPIN_DURATION_MAX_MS),
    resultFontSize: z.int().min(DRAW_FONT_SIZE_MIN).max(DRAW_FONT_SIZE_MAX),
    historyFontSize: z.int().min(DRAW_FONT_SIZE_MIN).max(DRAW_FONT_SIZE_MAX),
    showBoard: z.boolean(),
    backgroundAssetId: uuidSchema.nullable(),
    // 動画そのものは受け取らない（このアプリは画像しかアップロードを許していない）。
    openingVideoUrl: z.url().max(2048).nullable(),
  })
  .partial();

export const createDrawListSchema = z.object({
  title: z.string().trim().min(1).max(100),
  kind: z.enum(DRAW_LIST_KINDS),
  numberMin: z.int().min(DRAW_NUMBER_MIN).max(DRAW_NUMBER_MAX).optional(),
  numberMax: z.int().min(DRAW_NUMBER_MIN).max(DRAW_NUMBER_MAX).optional(),
});

export const updateDrawListSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  numberMin: z.int().min(DRAW_NUMBER_MIN).max(DRAW_NUMBER_MAX).nullable().optional(),
  numberMax: z.int().min(DRAW_NUMBER_MIN).max(DRAW_NUMBER_MAX).nullable().optional(),
  settings: drawSettingsSchema.optional(),
});

export const replaceDrawEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(DRAW_LABEL_MAX_LENGTH),
        imageAssetId: uuidSchema.nullable().optional(),
        imageAlt: z.string().max(IMAGE_ALT_MAX_LENGTH).nullable().optional(),
      }),
    )
    .max(DRAW_ENTRY_MAX_COUNT),
});

export const importDrawEntriesSchema = z.object({
  /** 貼り付けた本文。表計算からのコピーはタブ区切りで来る。 */
  text: z.string().max(1_000_000),
  hasHeader: z.boolean().optional(),
  labelColumnIndex: z.int().min(0).max(64).optional(),
  /** 既存の行に足すか（既定は入れ替え）。 */
  append: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// ルーム・司会
// ---------------------------------------------------------------------------

/**
 * ルーム作成。
 *
 * `mode` を省略したときはクイズとして扱う（既存の呼び出しをそのまま通すため）。
 * クイズなら quizId、抽選会・ビンゴなら drawListId が要る。
 */
export const createRoomSchema = z
  .object({
    mode: z.enum(ROOM_MODES).optional(),
    quizId: uuidSchema.optional(),
    drawListId: uuidSchema.optional(),
    maxParticipants: z.int().min(2).max(1000).optional(),
  })
  .refine(
    (value) => ((value.mode ?? 'quiz') === 'quiz' ? value.quizId !== undefined : true),
    { message: 'クイズを選んでください', path: ['quizId'] },
  )
  .refine(
    (value) => ((value.mode ?? 'quiz') === 'quiz' ? true : value.drawListId !== undefined),
    { message: '抽選リストを選んでください', path: ['drawListId'] },
  );

export const roomActionSchema = z
  .object({
    action: z.enum(ROOM_ACTIONS),
    questionId: uuidSchema.nullable().optional(),
    /** extend_deadline で足す秒数。reopen_question では省略すると問題の制限時間を使う。 */
    extendSeconds: z.int().min(EXTEND_SECONDS_MIN).max(EXTEND_SECONDS_MAX).nullable().optional(),
    expectedVersion: z.int().min(0),
  })
  .refine((value) => value.action !== 'extend_deadline' || typeof value.extendSeconds === 'number', {
    message: '延長する秒数を指定してください',
    path: ['extendSeconds'],
  });

// ---------------------------------------------------------------------------
// 参加者
// ---------------------------------------------------------------------------

export const registerParticipantSchema = z.object({
  nickname: nicknameSchema,
  captchaToken: z.string().max(4096).optional(),
});

export const submitAnswerSchema = z
  .object({
    questionId: uuidSchema,
    choiceId: uuidSchema.optional(),
    numberValue: z.string().max(64).optional(),
  })
  .refine(
    (value) =>
      (value.choiceId !== undefined && value.numberValue === undefined) ||
      (value.choiceId === undefined && value.numberValue !== undefined),
    { message: 'choiceId または numberValue のどちらか一方を指定してください' },
  );

export type CreateQuizInput = z.infer<typeof createQuizSchema>;
export type UpdateQuizInput = z.infer<typeof updateQuizSchema>;
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;
export type ChoiceInput = z.infer<typeof choiceInputSchema>;
export type RoomActionInput = z.infer<typeof roomActionSchema>;
export type RegisterParticipantInput = z.infer<typeof registerParticipantSchema>;
export type SubmitAnswerRequest = z.infer<typeof submitAnswerSchema>;
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type CreateDrawListInput = z.infer<typeof createDrawListSchema>;
export type UpdateDrawListInput = z.infer<typeof updateDrawListSchema>;
export type ReplaceDrawEntriesInput = z.infer<typeof replaceDrawEntriesSchema>;
export type ImportDrawEntriesInput = z.infer<typeof importDrawEntriesSchema>;
