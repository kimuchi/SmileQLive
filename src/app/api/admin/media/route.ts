/**
 * POST /api/admin/media  画像アップロード（multipart/form-data）
 *
 * フィールド:
 *   file        ... 画像本体（JPEG / PNG / WebP。判定は magic bytes でサービス層が行う）
 *   quizId      ... 紐づけるクイズ（所有者だけがアップロードできる）
 *   drawListId  ... 紐づける抽選リスト（quizId とどちらか一方）
 *   ballotId    ... 紐づける投票用紙（投影の背景。上の 2 つとどれか 1 つ）
 *   usage       ... question / choice / reveal / drawItem / stageBackground（長辺の上限が変わる）
 *   alt         ... 代替テキスト（任意）
 *
 * sharp を使うため Node ランタイムを明示する。
 */

import { uploadImage, type UploadScope } from '@/application/services/media-service';
import { IMAGE_ALT_MAX_LENGTH, MAX_UPLOAD_BYTES } from '@/domain/media/image-policy';
import { AppError } from '@/lib/errors/app-error';
import { jsonCreated } from '@/lib/errors/api-response';
import { assertSameOrigin, withRoute } from '@/lib/http/route-helpers';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import { mediaUsageSchema, uuidSchema } from '@/lib/validation/schemas';
import type { MediaUploadResponse } from '@/types/api';
import { parseValue } from '@/app/api/admin/_lib/admin-route';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** multipart の境界文字列やフィールド分の余白。本文全体の上限として使う。 */
const MULTIPART_OVERHEAD_BYTES = 512 * 1024;

/** 画像変換は CPU を使うため、1 インスタンスあたりの連打を緩く抑える。 */
const UPLOAD_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/**
 * 紐づけ先はクイズ・抽選リスト・投票用紙のどれか 1 つ。
 * 2 つ来たときに片方を黙って無視すると、意図と違う場所へ保存されてしまう。
 */
const uploadFieldsSchema = z
  .object({
    quizId: uuidSchema.optional(),
    drawListId: uuidSchema.optional(),
    ballotId: uuidSchema.optional(),
    usage: mediaUsageSchema,
    alt: z.string().max(IMAGE_ALT_MAX_LENGTH).optional(),
  })
  .refine(
    (value) =>
      [value.quizId, value.drawListId, value.ballotId].filter(
        (id) => id !== undefined,
      ).length === 1,
    {
      message: 'quizId・drawListId・ballotId のどれか 1 つを指定してください',
      path: ['quizId'],
    },
  );

/** 検証済みのフィールドから紐づけ先を組み立てる。 */
function uploadScopeOf(fields: z.infer<typeof uploadFieldsSchema>): UploadScope {
  if (fields.quizId !== undefined) {
    return { kind: 'quiz', quizId: fields.quizId };
  }
  if (fields.ballotId !== undefined) {
    return { kind: 'pollBallot', ballotId: fields.ballotId };
  }
  // refine で 3 つのうち 1 つだけが入っていることを保証済み。
  return { kind: 'drawList', listId: fields.drawListId as string };
}

function readTextField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export const POST = withRoute<MediaUploadResponse>('admin.media.upload', async ({ request }) => {
  assertSameOrigin(request);

  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: '', message: 'multipart/form-data で送信してください' }],
    });
  }

  // 本文をメモリへ読み込む前に、宣言サイズだけで明らかな超過を弾く。
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
  ) {
    throw new AppError('MEDIA_TOO_LARGE');
  }

  checkRateLimit(clientKeyFromRequest(request, 'admin.media.upload'), UPLOAD_RATE_LIMIT);

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: '', message: '画像を読み取れませんでした' }],
      cause: error,
    });
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'file', message: '画像ファイルを選択してください' }],
    });
  }

  const alt = readTextField(form, 'alt');
  const quizId = readTextField(form, 'quizId');
  const drawListId = readTextField(form, 'drawListId');
  const ballotId = readTextField(form, 'ballotId');
  const fields = parseValue(uploadFieldsSchema, {
    ...(quizId !== undefined && quizId.length > 0 ? { quizId } : {}),
    ...(drawListId !== undefined && drawListId.length > 0 ? { drawListId } : {}),
    ...(ballotId !== undefined && ballotId.length > 0 ? { ballotId } : {}),
    usage: readTextField(form, 'usage'),
    ...(alt !== undefined && alt.length > 0 ? { alt } : {}),
  });

  // 所有権の確認・形式判定・縮小・WebP 変換はすべてサービス層で行う。
  const result = await uploadImage({
    file,
    scope: uploadScopeOf(fields),
    usage: fields.usage,
    ...(fields.alt !== undefined ? { alt: fields.alt } : {}),
  });

  return jsonCreated<MediaUploadResponse>(result);
});
