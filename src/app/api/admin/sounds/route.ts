/**
 * GET  /api/admin/sounds  いま鳴る効果音の一覧
 * POST /api/admin/sounds  1 音を差し替える（multipart/form-data）
 *
 * フィールド:
 *   name ... 差し替える音の種類（question-start / tick / ...）
 *   file ... 音声本体（判定は magic bytes でサービス層が行う）
 *
 * 音は変換しないが、`file-type` が Node の API を使うためランタイムを明示する。
 */

import { listSoundSettings, uploadSound } from '@/application/services/sound-service';
import { MAX_SOUND_UPLOAD_BYTES } from '@/domain/media/sound-policy';
import { isSoundName } from '@/domain/sound/sound-catalog';
import { AppError } from '@/lib/errors/app-error';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, withRoute } from '@/lib/http/route-helpers';
import { checkRateLimit, clientKeyFromRequest } from '@/lib/http/rate-limit';
import type { SoundSettingsResponse } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** multipart の境界文字列やフィールド分の余白。本文全体の上限として使う。 */
const MULTIPART_OVERHEAD_BYTES = 512 * 1024;

const UPLOAD_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export const GET = withRoute<SoundSettingsResponse>('admin.sounds.list', async () => {
  return jsonOk<SoundSettingsResponse>(await listSoundSettings());
});

export const POST = withRoute<SoundSettingsResponse>('admin.sounds.upload', async ({ request }) => {
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
    declaredLength > MAX_SOUND_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
  ) {
    throw new AppError('SOUND_TOO_LARGE');
  }

  checkRateLimit(clientKeyFromRequest(request, 'admin.sounds.upload'), UPLOAD_RATE_LIMIT);

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: '', message: '音声ファイルを読み取れませんでした' }],
      cause: error,
    });
  }

  const name = form.get('name');
  if (typeof name !== 'string' || !isSoundName(name)) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'name', message: '差し替える音の種類が不正です' }],
    });
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'file', message: '音声ファイルを選択してください' }],
    });
  }

  return jsonOk<SoundSettingsResponse>(await uploadSound({ name, file }));
});
