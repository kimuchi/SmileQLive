import { cn } from '@/lib/client/cn';
import { CLIENT_NOTICES } from '@/lib/errors/app-error';
import type { RoomChannelStatus } from '@/lib/client/realtime-status';

/**
 * Realtime 接続状態の表示。
 *
 * 大事なのは「切断されても画面を消さない」こと。
 * 進行中の問題文や自分の回答はそのまま残し、細い帯で状況だけ伝える。
 */

const MESSAGES: Record<RoomChannelStatus, string> = {
  connecting: '接続しています',
  connected: '接続しています（オンライン）',
  disconnected: CLIENT_NOTICES.REALTIME_DISCONNECTED,
  error: `${CLIENT_NOTICES.REALTIME_DISCONNECTED}（自動で繰り返します）`,
};

const TONE_CLASS: Record<RoomChannelStatus, string> = {
  connecting: 'bg-slate-100 text-slate-700 border-slate-200',
  connected: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  disconnected: 'bg-amber-50 text-amber-900 border-amber-200',
  error: 'bg-amber-50 text-amber-900 border-amber-200',
};

const DOT_CLASS: Record<RoomChannelStatus, string> = {
  connecting: 'bg-slate-400',
  connected: 'bg-emerald-500',
  disconnected: 'bg-amber-500',
  error: 'bg-amber-500',
};

export type ConnectionStatusProps = {
  status: RoomChannelStatus;
  /** 接続できているときも表示する（司会・投影の確認用）。 */
  showWhenConnected?: boolean;
  className?: string;
};

export function ConnectionStatus({
  status,
  showWhenConnected = false,
  className,
}: ConnectionStatusProps) {
  if (status === 'connected' && !showWhenConnected) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-bold',
        TONE_CLASS[status],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block size-2 rounded-full',
          DOT_CLASS[status],
          status !== 'connected' && 'animate-pulse',
        )}
      />
      <span>{MESSAGES[status]}</span>
    </div>
  );
}
