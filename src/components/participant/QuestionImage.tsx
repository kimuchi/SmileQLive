import type { PublicImage } from '@/domain/quiz/public-question';
import { cn } from '@/lib/client/cn';

/**
 * 参加者画面の画像表示。
 *
 * - 表示できるのは toPublicQuestion() / RevealInfo が返した PublicImage だけ。
 * - next/image は外部ホスト（Supabase Storage）の許可設定を必要とし、
 *   実行時に URL が決まる本システムとは相性が悪いため通常の img を使う。
 * - 読み込みに失敗しても画面を壊さない（alt が残るだけ）。
 */
export function QuestionImage({
  image,
  className,
  priority = false,
}: {
  image: PublicImage;
  className?: string;
  /** 出題直後に見せる画像は先読みする。 */
  priority?: boolean;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 実行時に決まる外部URLのため next/image を使わない
    <img
      src={image.url}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={cn('h-auto max-h-72 w-full rounded-xl bg-slate-100 object-contain', className)}
    />
  );
}
