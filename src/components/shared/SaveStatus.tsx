import { Spinner } from '@/components/shared/Spinner';
import { cn } from '@/lib/client/cn';

/**
 * 自動保存の状態表示（クイズ編集画面向け）。
 * 保存できていないまま画面を離れることがないよう、状態を常に見えるようにする。
 */

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const LABELS: Record<SaveState, string> = {
  idle: '未編集',
  saving: '保存しています',
  saved: '保存しました',
  error: '保存できませんでした',
};

const TONE_CLASS: Record<SaveState, string> = {
  idle: 'text-slate-500',
  saving: 'text-slate-700',
  saved: 'text-emerald-700',
  error: 'text-red-700',
};

export type SaveStatusProps = {
  status: SaveState;
  /** idle のときも表示する。既定では非表示。 */
  showWhenIdle?: boolean;
  /** 最終保存時刻の表示（例: '12:34'）。 */
  savedAtLabel?: string;
  className?: string;
};

export function SaveStatus({
  status,
  showWhenIdle = false,
  savedAtLabel,
  className,
}: SaveStatusProps) {
  if (status === 'idle' && !showWhenIdle) {
    return null;
  }

  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-2 text-sm font-bold',
        TONE_CLASS[status],
        className,
      )}
    >
      {status === 'saving' ? <Spinner size="sm" decorative /> : null}
      <span>
        {LABELS[status]}
        {status === 'saved' && savedAtLabel !== undefined ? `（${savedAtLabel}）` : ''}
      </span>
    </p>
  );
}
