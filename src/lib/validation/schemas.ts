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
import { ROOM_ACTIONS } from '@/domain/room/state-machine';
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

export const reorderQuestionsSchema = z.object({
  questionIds: z.array(uuidSchema).min(1).max(100),
});

export const reorderChoicesSchema = z.object({
  choiceIds: z.array(uuidSchema).min(CHOICE_MIN_COUNT).max(CHOICE_MAX_COUNT),
});

// ---------------------------------------------------------------------------
// ルーム・司会
// ---------------------------------------------------------------------------

export const createRoomSchema = z.object({
  quizId: uuidSchema,
  maxParticipants: z.int().min(2).max(1000).optional(),
});

export const roomActionSchema = z.object({
  action: z.enum(ROOM_ACTIONS),
  questionId: uuidSchema.nullable().optional(),
  expectedVersion: z.int().min(0),
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
