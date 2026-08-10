import type { ReactNode } from 'react';
import { Spinner } from '@/components/shared/Spinner';
import { cn } from '@/lib/client/cn';

/**
 * 画面全体を使った案内。
 * 「読み込み中」「参加URLが無効です」など、他に何も出せないときだけ使う。
 * 進行中の問題表示を消してこれに切り替えないこと。
 */

export type FullScreenMessageTone = 'default' | 'info' | 'error' | 'stage';

const TONE_CLASS: Record<FullScreenMessageTone, string> = {
  default: 'bg-slate-50 text-slate-900',
  info: 'bg-brand-50 text-brand-900',
  error: 'bg-red-50 text-red-900',
  stage: 'stage-root',
};

export type FullScreenMessageProps = {
  title: ReactNode;
  description?: ReactNode;
  tone?: FullScreenMessageTone;
  /** 読み込み中の表示。 */
  loading?: boolean;
  /** ボタンなどの操作。 */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function FullScreenMessage({
  title,
  description,
  tone = 'default',
  loading = false,
  actions,
  children,
  className,
}: FullScreenMessageProps) {
  return (
    <main
      className={cn(
        'flex min-h-dvh flex-col items-center justify-center gap-4 px-6 py-10 text-center',
        TONE_CLASS[tone],
        className,
      )}
    >
      {loading ? <Spinner size="lg" /> : null}
      <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
      {description !== undefined ? (
        <p className="max-w-md text-base leading-relaxed opacity-90">{description}</p>
      ) : null}
      {children}
      {actions !== undefined ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">{actions}</div>
      ) : null}
    </main>
  );
}
