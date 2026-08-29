'use client';

import {
  ACCEPTED_INPUT_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type MediaUsage,
} from '@/domain/media/image-policy';
import { ApiClientError } from '@/lib/client/api-client';
import type { ApiError } from '@/lib/errors/api-response';
import type { MediaUploadResponse } from '@/types/api';

/**
 * 画像アップロード。
 *
 * 共通 API クライアントは JSON 専用のため、multipart はここで組み立てる。
 * 規約（同一オリジン・no-store・Referer を抑制）は api-client と同じにする。
 *
 * 送信前の判定はあくまで利用者への即時フィードバック用。
 * 実際の形式判定（magic bytes）と変換はサーバー側が行う。
 */

const UPLOAD_ENDPOINT = '/api/admin/media';

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

export type UploadedAsset = MediaUploadResponse['asset'];

/**
 * 画像の紐づけ先。クイズか抽選リストのどちらか一方。
 *
 * サーバーはこの ID で所有者を確かめるため、どちらなのかを取り違えると
 * 「クイズが見つかりません」で弾かれる。型で選ばせて取り違えを防ぐ。
 */
export type MediaScope =
  | { kind: 'quiz'; quizId: string }
  | { kind: 'drawList'; listId: string }
  | { kind: 'pollBallot'; ballotId: string };

export async function uploadAdminImage(input: {
  file: File;
  scope: MediaScope;
  usage: MediaUsage;
  alt?: string;
}): Promise<UploadedAsset> {
  if (input.file.size > MAX_UPLOAD_BYTES) {
    throw new ApiClientError({
      code: 'MEDIA_TOO_LARGE',
      message: '画像は8MB以下にしてください',
      status: 422,
      requestId: '',
    });
  }

  if (
    input.file.type.length > 0 &&
    !(ACCEPTED_INPUT_MIME_TYPES as readonly string[]).includes(input.file.type)
  ) {
    throw new ApiClientError({
      code: 'MEDIA_UNSUPPORTED_TYPE',
      message: 'JPEG・PNG・WebP の画像を指定してください',
      status: 422,
      requestId: '',
    });
  }

  const form = new FormData();
  form.append('file', input.file);
  if (input.scope.kind === 'quiz') {
    form.append('quizId', input.scope.quizId);
  } else if (input.scope.kind === 'pollBallot') {
    form.append('ballotId', input.scope.ballotId);
  } else {
    form.append('drawListId', input.scope.listId);
  }
  form.append('usage', input.usage);
  if (input.alt !== undefined && input.alt.trim().length > 0) {
    form.append('alt', input.alt);
  }

  let response: Response;
  try {
    response = await fetch(UPLOAD_ENDPOINT, {
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
      message: apiError?.message ?? '画像をアップロードできませんでした',
      status: response.status,
      requestId: apiError?.requestId ?? '',
      // 失敗した理由（保存先が無い・権限が無い等）を画面へ出すために持ち帰る。
      ...(apiError?.details !== undefined ? { details: apiError.details } : {}),
    });
  }

  if (!isRecord(payload) || !isRecord(payload.asset)) {
    throw new ApiClientError({
      code: 'UNEXPECTED_RESPONSE',
      message: '画像をアップロードできませんでした',
      status: response.status,
      requestId: '',
    });
  }

  return payload.asset as UploadedAsset;
}
