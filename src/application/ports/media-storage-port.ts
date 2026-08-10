/**
 * 画像保存・配信 URL 解決のポート。
 *
 * Firestore とクイズスナップショットには `storage://<bucket>/<path>` の参照だけを保存し、
 * 期限付き（署名付き）URL は配信直前に解決する。保存すると期限切れの URL が残るため。
 *
 * 実装:
 *   `src/infrastructure/firebase/storage/media-storage.ts`（Cloud Storage）
 *   `src/infrastructure/firebase/repositories/media-repository.ts`（mediaAssets）
 */

export type UploadProcessedImageInput = {
  ownerId: string;
  quizId: string;
  assetId: string;
  buffer: Uint8Array;
  contentType: string;
};

export type MediaStorage = {
  uploadProcessedImage(input: UploadProcessedImageInput): Promise<{ objectPath: string }>;
  deleteObject(objectPath: string): Promise<void>;
  resolveMediaUrl(ref: string | null): Promise<string | null>;
  resolveMediaUrls(refs: (string | null)[]): Promise<(string | null)[]>;
};

/** `mediaAssets/{assetId}` のポート。 */
export type MediaAssetRecord = {
  id: string;
  ownerId: string;
  bucket: string;
  objectPath: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  createdAt: string;
};

export type MediaRepository = {
  insertAsset(input: Omit<MediaAssetRecord, 'createdAt'>): Promise<MediaAssetRecord>;
  getAsset(assetId: string): Promise<MediaAssetRecord | null>;
  deleteAsset(assetId: string): Promise<void>;
  countUsages(assetId: string): Promise<number>;
  /** assetId -> storage 参照文字列。スナップショット・管理画面の URL 解決に使う。 */
  getAssetRefs(
    assetIds: string[],
  ): Promise<Map<string, { ref: string; width: number; height: number }>>;
};
