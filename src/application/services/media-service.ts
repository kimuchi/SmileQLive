import 'server-only';

/**
 * 画像アップロード・削除のユースケース。
 *
 * 処理順（どれか 1 つでも失敗したら保存しない）:
 *   1. 所有権検証
 *   2. magic bytes 判定（拡張子・Content-Type は信用しない）→ JPEG/PNG/WebP 以外は拒否
 *   3. 8MB 超は拒否
 *   4. sharp で rotate()（EXIF 方向を反映）→ メタデータ除去 → usage に応じた長辺へ縮小
 *   5. WebP quality 82 で再エンコード（アニメーションは受け付けない）
 *   6. Cloud Storage へ保存 → mediaAssets へ登録
 *
 * 保存するのは `storage://<bucket>/<objectPath>` 参照だけで、期限付き URL は保存しない。
 * 配信 URL は resolveQuestionMedia() が**1 回の呼び出しでまとめて**解決する。
 */

import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import {
  IMAGE_ALT_MAX_LENGTH,
  isAcceptedInputMime,
  MAX_EDGE_BY_USAGE,
  MAX_UPLOAD_BYTES,
  OUTPUT_MIME_TYPE,
  WEBP_QUALITY,
  type MediaUsage,
} from '@/domain/media/image-policy';
import type { MediaRef, Question } from '@/domain/quiz/question';
import { requireHostUser, requireQuizOwner } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import {
  countUsages,
  deleteAsset as deleteAssetRow,
  getAsset,
  insertAsset,
} from '@/infrastructure/firebase/repositories/media-repository';
import {
  buildStorageRef,
  deleteObject,
  mediaBucketName,
  resolveMediaUrl,
  resolveMediaUrls,
  uploadProcessedImage,
} from '@/infrastructure/firebase/storage/media-storage';
import type { MediaUploadResponse } from '@/types/api';

export type UploadImageInput = {
  file: File;
  quizId: string;
  usage: MediaUsage;
  alt?: string;
};

export async function uploadImage(input: UploadImageInput): Promise<MediaUploadResponse> {
  const { user } = await requireQuizOwner(input.quizId);

  if (input.alt !== undefined && input.alt.length > IMAGE_ALT_MAX_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      details: [{ path: 'alt', message: `代替テキストは${IMAGE_ALT_MAX_LENGTH}文字以内です` }],
    });
  }

  if (input.file.size > MAX_UPLOAD_BYTES) {
    throw new AppError('MEDIA_TOO_LARGE');
  }

  const bytes = Buffer.from(await input.file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AppError('MEDIA_UNSUPPORTED_TYPE');
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AppError('MEDIA_TOO_LARGE');
  }

  // Content-Type ヘッダーやファイル名ではなく実データで判定する。
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !isAcceptedInputMime(detected.mime)) {
    throw new AppError('MEDIA_UNSUPPORTED_TYPE');
  }

  const maxEdge = MAX_EDGE_BY_USAGE[input.usage];

  let processed: { data: Buffer; width: number; height: number; size: number };
  try {
    const pipeline = sharp(bytes, { failOn: 'error' });
    const metadata = await pipeline.metadata();

    // アニメーション WebP / APNG は受け付けない。
    if ((metadata.pages ?? 1) > 1) {
      throw new AppError('MEDIA_UNSUPPORTED_TYPE');
    }

    const result = await pipeline
      .rotate() // EXIF Orientation を画素へ反映し、以後の付加情報は破棄する
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    processed = {
      data: result.data,
      width: result.info.width,
      height: result.info.height,
      size: result.info.size,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.warn('media.process_failed', {
      quizId: input.quizId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw new AppError('MEDIA_PROCESSING_FAILED', { cause: error });
  }

  if (processed.width <= 0 || processed.height <= 0 || processed.size <= 0) {
    throw new AppError('MEDIA_PROCESSING_FAILED');
  }

  const assetId = crypto.randomUUID();
  // 実際に保存するバケット名をそのまま記録する（storage:// 参照と食い違わせない）。
  const bucket = mediaBucketName();

  const { objectPath } = await uploadProcessedImage({
    ownerId: user.id,
    quizId: input.quizId,
    assetId,
    buffer: processed.data,
    contentType: OUTPUT_MIME_TYPE,
  });

  try {
    const asset = await insertAsset({
      id: assetId,
      ownerId: user.id,
      bucket,
      objectPath,
      mimeType: OUTPUT_MIME_TYPE,
      byteSize: processed.size,
      width: processed.width,
      height: processed.height,
    });

    const url = await resolveMediaUrl(buildStorageRef(asset.bucket, asset.objectPath));

    return {
      asset: {
        id: asset.id,
        url: url ?? '',
        width: asset.width,
        height: asset.height,
        byteSize: asset.byteSize,
      },
    };
  } catch (error) {
    // メタデータ登録に失敗したら Storage 側の実体も片付ける。
    await deleteObject(buildStorageRef(bucket, objectPath));
    throw error;
  }
}

/** 使用中の画像は削除できない。 */
export async function deleteAsset(assetId: string): Promise<void> {
  const { user } = await requireHostUser();

  const asset = await getAsset(assetId);
  if (!asset) {
    throw new AppError('MEDIA_NOT_FOUND');
  }
  if (asset.ownerId !== user.id) {
    throw new AppError('FORBIDDEN');
  }

  const usages = await countUsages(assetId);
  if (usages > 0) {
    throw new AppError('MEDIA_IN_USE');
  }

  await deleteObject(buildStorageRef(asset.bucket, asset.objectPath));
  await deleteAssetRow(assetId);
}

// ---------------------------------------------------------------------------
// スナップショット内の画像参照を配信 URL へ解決する
// ---------------------------------------------------------------------------

/**
 * 解決対象の参照を問題ごとに並べる。
 * `includeReveal` が false でも**枠だけは残す**（後段の添字計算を単純に保つため）。
 */
function collectRefs(question: Question, includeReveal: boolean): (string | null)[] {
  const refs: (string | null)[] = [
    question.image?.url ?? null,
    includeReveal ? (question.revealImage?.url ?? null) : null,
  ];
  if (question.type === 'choice') {
    for (const choice of question.choices) {
      refs.push(choice.image?.url ?? null);
    }
  }
  return refs;
}

function applyUrl(ref: MediaRef | null, url: string | null): MediaRef | null {
  if (!ref) {
    return null;
  }
  return { ...ref, url: url ?? '' };
}

export type ResolveQuestionMediaOptions = {
  /**
   * 正解・解説画像も解決するか（既定は true）。
   *
   * **正解発表前の参加者向けには false を渡すこと。**
   * false のときは配信 URL を作らず revealImage を null にするので、
   * 参加者向けの処理経路には使える URL がそもそも存在しなくなる。
   */
  includeRevealImage?: boolean;
};

/**
 * スナップショット上の `storage://` 参照を配信 URL へ差し替えた問題を返す。
 * 参加者へ返す直前にこの関数を通し、その後で toPublicQuestion() を適用する。
 *
 * 署名付き URL の発行はネットワーク往復を伴うため、
 * 渡された問題すべての画像を **1 回の呼び出しでまとめて**解決する。
 */
export async function resolveQuestionMedia(
  questions: Question[],
  options: ResolveQuestionMediaOptions = {},
): Promise<Question[]> {
  if (questions.length === 0) {
    return [];
  }

  const includeReveal = options.includeRevealImage !== false;

  const perQuestion = questions.map((question) => collectRefs(question, includeReveal));
  const flat = perQuestion.flat();
  const resolved = await resolveMediaUrls(flat);

  let cursor = 0;
  return questions.map((question, index) => {
    const refs = perQuestion[index] ?? [];
    const slice = resolved.slice(cursor, cursor + refs.length);
    cursor += refs.length;

    const image = applyUrl(question.image, slice[0] ?? null);
    const revealImage = includeReveal ? applyUrl(question.revealImage, slice[1] ?? null) : null;

    if (question.type === 'number') {
      return { ...question, image, revealImage };
    }

    return {
      ...question,
      image,
      revealImage,
      choices: question.choices.map((choice, choiceIndex) => ({
        ...choice,
        image: applyUrl(choice.image, slice[2 + choiceIndex] ?? null),
      })),
    };
  });
}

/** 単一問題向けの薄いラッパー。 */
export async function resolveSingleQuestionMedia(
  question: Question,
  options: ResolveQuestionMediaOptions = {},
): Promise<Question> {
  const [resolved] = await resolveQuestionMedia([question], options);
  return resolved ?? question;
}
