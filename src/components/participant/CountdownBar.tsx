import { cn } from '@/lib/client/cn';

/**
 * 残り時間の表示。
 *
 * - 締切判定そのものはサーバー / DB が行う。ここはサーバー時刻差で補正した表示のみ。
 * - 音・振動は鳴らさない（効果音は投影画面だけの責務）。
 * - 毎秒読み上げが割り込まないよう aria-live は使わない。
 */
export function CountdownBar({
  remainingSeconds,
  remainingMs,
  timeLimitSeconds,
}: {
  remainingSeconds: number;
  remainingMs: number;
  timeLimitSeconds: number;
}) {
  const totalMs = Math.max(1, timeLimitSeconds * 1000);
  const ratio = Math.min(1, Math.max(0, remainingMs / totalMs));
  const seconds = Math.max(0, remainingSeconds);
  const urgent = seconds <= 5;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-bold text-slate-600">回答時間</span>
        <span
          role="timer"
          aria-live="off"
          className={cn(
            'text-2xl font-bold tabular-nums',
            urgent ? 'text-red-600' : 'text-slate-900',
          )}
        >
          残り {seconds} 秒
        </span>
      </div>
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="回答時間の残り"
        aria-valuemin={0}
        aria-valuemax={timeLimitSeconds}
        aria-valuenow={seconds}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-200 ease-linear',
            urgent ? 'bg-red-500' : 'bg-brand-500',
          )}
          style={{ width: `${(ratio * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}
