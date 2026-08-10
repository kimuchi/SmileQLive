import type { ReactNode } from 'react';
import { Spinner } from '@/components/shared/Spinner';
import { cn } from '@/lib/client/cn';

/**
 * 待機中・締切後などの案内。
 *
 * 進行中の画面を消さずに、その場に落ち着いた案内だけを足すための箱。
 * 音・振動は使わない。
 */
export function NoticePanel({
  title,
  description,
  waiting = false,
  tone = 'default',
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 「お待ちください」を伝えるスピナーを出す。 */
  waiting?: boolean;
  tone?: 'default' | 'brand' | 'muted';
  children?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex flex-col items-center gap-2 rounded-2xl border p-5 text-center shadow-sm',
        tone === 'brand' && 'border-brand-200 bg-brand-50 text-brand-900',
        tone === 'muted' && 'border-slate-200 bg-slate-100 text-slate-800',
        tone === 'default' && 'border-slate-200 bg-white text-slate-900',
      )}
      aria-live="polite"
    >
      {waiting ? <Spinner size="md" label="お待ちください" /> : null}
      <h2 className="text-lg font-bold">{title}</h2>
      {description !== undefined ? (
        <p className="text-sm leading-relaxed opacity-90">{description}</p>
      ) : null}
      {children}
    </section>
  );
}
