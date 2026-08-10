/**
 * POST /api/admin/media  画像アップロード（multipart/form-data）
 *
 * フィールド:
 *   file    ... 画像本体（JPEG / PNG / WebP。判定は magic bytes でサービス層が行う）
 *   quizId  ... 紐づけるクイズ（所有者だけがアップロードできる）
 *   usage   ... question / choice / reveal（長辺の上限が変わる）
 *   alt     ... 代替テキスト（任意）
 *
 * sharp を使うため Node ランタイムを明示する。
 */

import { uploadImage } from '@/application/services/media-service';
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

const uploadFieldsSchema = z.object({
  quizId: uuidSchema,
  usage: mediaUsageSchema,
  alt: z.string().max(IMAGE_ALT_MAX_LENGTH).optional(),
});

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
  const fields = parseValue(uploadFieldsSchema, {
    quizId: readTextField(form, 'quizId'),
    usage: readTextField(form, 'usage'),
    ...(alt !== undefined && alt.length > 0 ? { alt } : {}),
  });

  // 所有権の確認・形式判定・縮小・WebP 変換はすべてサービス層で行う。
  const result = await uploadImage({
    file,
    quizId: fields.quizId,
    usage: fields.usage,
    ...(fields.alt !== undefined ? { alt: fields.alt } : {}),
  });

  return jsonCreated<MediaUploadResponse>(result);
});
