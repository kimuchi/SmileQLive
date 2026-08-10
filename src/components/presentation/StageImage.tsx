'use client';

import { stageHeightRatio } from '@/components/presentation/stage-theme';
import type { PublicImage } from '@/domain/quiz/public-question';
import { cn } from '@/lib/client/cn';

/**
 * ステージ上の画像。
 *
 * - 縦横比を変えない（object-fit: contain）。人物や図表が歪むと会場で読めなくなる。
 * - 高さは画面の一定割合までに制限し、問題文と選択肢を必ず同時に見せる。
 * - 実行時に決まる Supabase Storage の署名 URL を扱うため next/image は使わない。
 * - 読み込みに失敗しても画面を壊さない（代替テキストが残るだけ）。
 */
export function StageImage({
  image,
  /** 画面高に対する最大割合。既定 0.4（40%）。 */
  maxHeightRatio = 0.4,
  className,
}: {
  image: PublicImage;
  maxHeightRatio?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 実行時に決まる外部URLのため next/image を使わない
    <img
      src={image.url}
      alt={image.alt}
      width={image.width}
      height={image.height}
      // 投影画面に出る画像は「今まさに見せるもの」なので必ず即時読み込みにする。
      loading="eager"
      decoding="async"
      className={cn('mx-auto w-auto max-w-full rounded-2xl object-contain', className)}
      style={{ maxHeight: stageHeightRatio(maxHeightRatio) }}
    />
  );
}
