import { cn } from '@/lib/client/cn';

/**
 * 読み込み中インジケーター。
 * ボタン内など装飾として使う場合は decorative を付け、支援技術から隠す。
 */

export type SpinnerSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: 'size-4 border-2',
  md: 'size-6 border-2',
  lg: 'size-10 border-4',
};

export type SpinnerProps = {
  size?: SpinnerSize;
  /** 読み上げ用のラベル。decorative のときは無視される。 */
  label?: string;
  decorative?: boolean;
  className?: string;
};

export function Spinner({
  size = 'md',
  label = '読み込み中',
  decorative = false,
  className,
}: SpinnerProps) {
  const circle = (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block animate-spin rounded-full border-current border-t-transparent',
        SIZE_CLASS[size],
        className,
      )}
    />
  );

  if (decorative) {
    return circle;
  }

  return (
    <span role="status" className="inline-flex items-center gap-2">
      {circle}
      <span className="sr-only">{label}</span>
    </span>
  );
}
