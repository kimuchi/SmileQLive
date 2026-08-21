'use client';

import { useCallback, useId, useRef, useState, type ChangeEvent } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { FieldHint, FieldLabel } from '@/components/shared/FieldLabel';
import { Spinner } from '@/components/shared/Spinner';
import { TextInput } from '@/components/shared/TextInput';
import { ALT_TEXT_MAX_LENGTH } from '@/components/admin/question-draft';
import { uploadAdminImage, type MediaScope } from '@/components/admin/upload-media';
import type { MediaUsage } from '@/domain/media/image-policy';
import { toAdminErrorMessage } from '@/lib/client/error-text';
import { cn } from '@/lib/client/cn';
import type { AdminMediaRef } from '@/types/api';

/**
 * 画像の差し替え・削除と代替テキストの入力。
 *
 * - 受け付けるのは JPEG / PNG / WebP のみ。保存形式（WebP 変換）はサーバー側の責務。
 * - アップロード中は上位（公開ボタン）へ通知して操作を止める。
 * - 正解・解説画像は参加者へ正解発表前に渡らない。ここは管理画面なので表示してよい。
 */

const ACCEPT_ATTRIBUTE = 'image/jpeg,image/png,image/webp';

export type ImageFieldProps = {
  label: string;
  /** 画像の紐づけ先。クイズか抽選リスト。所有者の確認に使われる。 */
  scope: MediaScope;
  usage: MediaUsage;
  image: AdminMediaRef | null;
  alt: string;
  hint?: string;
  disabled?: boolean;
  /** 画像が差し替わった／外れたとき。 */
  onImageChange: (image: AdminMediaRef | null) => void;
  onAltChange: (alt: string) => void;
  onUploadingChange?: (uploading: boolean) => void;
  className?: string;
};

export function ImageField({
  label,
  scope,
  usage,
  image,
  alt,
  hint,
  disabled = false,
  onImageChange,
  onAltChange,
  onUploadingChange,
  className,
}: ImageFieldProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      // 同じファイルを選び直せるよう、値は毎回空にする。
      event.currentTarget.value = '';
      if (!file) {
        return;
      }

      setErrorMessage(null);
      setUploading(true);
      onUploadingChange?.(true);
      try {
        const asset = await uploadAdminImage({ file, scope, usage, alt });
        onImageChange({
          assetId: asset.id,
          url: asset.url,
          alt,
          width: asset.width,
          height: asset.height,
        });
      } catch (caught) {
        setErrorMessage(toAdminErrorMessage(caught));
      } finally {
        setUploading(false);
        onUploadingChange?.(false);
      }
    },
    [alt, onImageChange, onUploadingChange, scope, usage],
  );

  const handleRemove = useCallback(() => {
    setErrorMessage(null);
    onImageChange(null);
    onAltChange('');
  }, [onAltChange, onImageChange]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>

      <div className="flex flex-wrap items-start gap-3">
        {image ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            {/* next/image は署名付き外部 URL の設定が要るため、管理画面では素の img を使う。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.url}
              alt={alt.trim().length > 0 ? alt : '登録済みの画像'}
              width={image.width}
              height={image.height}
              className="block h-28 w-auto max-w-56 object-contain"
            />
          </div>
        ) : (
          <p className="flex h-28 w-40 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-500">
            画像なし
          </p>
        )}

        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            disabled={disabled || uploading}
            onChange={(event) => void handleFileChange(event)}
            className="sr-only"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              loading={uploading}
              onClick={() => {
                inputRef.current?.click();
              }}
            >
              {image ? '画像を差し替える' : '画像を選ぶ'}
            </Button>
            {image ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || uploading}
                onClick={handleRemove}
              >
                画像を外す
              </Button>
            ) : null}
            {uploading ? (
              <span className="inline-flex items-center gap-2 text-sm text-slate-600">
                <Spinner size="sm" decorative />
                アップロードしています
              </span>
            ) : null}
          </div>
          <FieldHint id={`${inputId}-hint`}>
            {hint ?? 'JPEG・PNG・WebP、8MB以下。保存時に自動で縮小されます。'}
          </FieldHint>
        </div>
      </div>

      {errorMessage !== null ? <Alert variant="error">{errorMessage}</Alert> : null}

      {image ? (
        <TextInput
          label="代替テキスト（読み上げ用）"
          maxLength={ALT_TEXT_MAX_LENGTH}
          value={alt}
          disabled={disabled}
          hint="画像の内容を短く説明します。画像だけの問題・選択肢では必須です。"
          onChange={(event) => {
            onAltChange(event.currentTarget.value);
          }}
        />
      ) : null}
    </div>
  );
}
