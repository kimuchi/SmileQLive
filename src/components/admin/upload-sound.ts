'use client';

import { MAX_SOUND_UPLOAD_BYTES } from '@/domain/media/sound-policy';
import type { SoundName } from '@/domain/sound/sound-catalog';
import { ApiClientError } from '@/lib/client/api-client';
import type { ApiError } from '@/lib/errors/api-response';
import type { SoundSettingsResponse } from '@/types/api';

/**
 * 効果音の差し替え送信。
 *
 * 共通 API クライアントは JSON 専用のため、multipart はここで組み立てる。
 * 規約（同一オリジン・no-store・Referer を抑制）は api-client と同じにする。
 *
 * 送信前の判定は利用者への即時フィードバックだけ。
 * 実際の形式判定（magic bytes）はサーバー側が行う。
 */

const ENDPOINT = '/api/admin/sounds';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseApiError(body: unknown): ApiError['error'] | null {
  if (!isRecord(body) || !isRecord(body.error)) {
    return null;
  }
  const { code, message, requestId, details } = body.error;
  if (typeof code !== 'string' || typeof message !== 'string') {
    return null;
  }
  return {
    code,
    message,
    requestId: typeof requestId === 'string' ? requestId : '',
    ...(details !== undefined ? { details } : {}),
  };
}

export async function uploadAdminSound(input: {
  name: SoundName;
  file: File;
}): Promise<SoundSettingsResponse> {
  if (input.file.size > MAX_SOUND_UPLOAD_BYTES) {
    throw new ApiClientError({
      code: 'SOUND_TOO_LARGE',
      message: '効果音は8MB以下にしてください',
      status: 422,
      requestId: '',
    });
  }

  const form = new FormData();
  form.append('name', input.name);
  form.append('file', input.file);

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'origin',
    });
  } catch (error) {
    throw new ApiClientError({
      code: 'NETWORK_ERROR',
      message: '通信できませんでした。電波状況を確認して、もう一度お試しください',
      status: 0,
      requestId: '',
      cause: error,
    });
  }

  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiError = parseApiError(payload);
    throw new ApiClientError({
      code: apiError?.code ?? 'UNEXPECTED_RESPONSE',
      message: apiError?.message ?? '効果音を差し替えられませんでした',
      status: response.status,
      requestId: apiError?.requestId ?? '',
      // 失敗した理由（保存先が無い・権限が無い等）を画面へ出すために持ち帰る。
      ...(apiError?.details !== undefined ? { details: apiError.details } : {}),
    });
  }

  return payload as SoundSettingsResponse;
}
