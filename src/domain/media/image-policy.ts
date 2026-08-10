/**
 * 画像アップロードのポリシー。
 *
 * - 受け付けるのは JPEG / PNG / WebP のみ（magic bytes で判定）。
 * - SVG / GIF / 動画 / 実行形式は拒否する。
 * - 保存は WebP のみ。EXIF 等の付加情報は除去する。
 */

export const MEDIA_USAGES = ['question', 'choice', 'reveal'] as const;
export type MediaUsage = (typeof MEDIA_USAGES)[number];

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const ACCEPTED_INPUT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedInputMimeType = (typeof ACCEPTED_INPUT_MIME_TYPES)[number];

export const OUTPUT_MIME_TYPE = 'image/webp';
export const WEBP_QUALITY = 82;

/** usage ごとの長辺上限 (px)。 */
export const MAX_EDGE_BY_USAGE: Record<MediaUsage, number> = {
  question: 1600,
  choice: 1000,
  reveal: 1600,
};

export function isMediaUsage(value: string): value is MediaUsage {
  return (MEDIA_USAGES as readonly string[]).includes(value);
}

export function isAcceptedInputMime(value: string): value is AcceptedInputMimeType {
  return (ACCEPTED_INPUT_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * 保存パス。正解を推測できる語 (correct / answer など) を含めない。
 * `<ownerId>/<quizId>/<randomUuid>.webp`
 */
export function buildObjectPath(ownerId: string, quizId: string, assetId: string): string {
  return `${ownerId}/${quizId}/${assetId}.webp`;
}

/** 代替テキストの最大長。 */
export const IMAGE_ALT_MAX_LENGTH = 120;
