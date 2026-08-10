/**
 * Realtime 接続状態の共通定義。
 *
 * 切断中でも画面を消さず、「再接続しています」とだけ伝える。
 * 進行中の会場で真っ白な画面を出さないための約束。
 */

import { CLIENT_NOTICES } from '@/lib/errors/app-error';

export const ROOM_CHANNEL_STATUSES = [
  'connecting',
  'connected',
  'disconnected',
  'error',
] as const;

export type RoomChannelStatus = (typeof ROOM_CHANNEL_STATUSES)[number];

export const ROOM_CHANNEL_STATUS_LABELS: Record<RoomChannelStatus, string> = {
  connecting: '接続しています',
  connected: CLIENT_NOTICES.REALTIME_RECONNECTED,
  disconnected: CLIENT_NOTICES.REALTIME_DISCONNECTED,
  error: CLIENT_NOTICES.REALTIME_DISCONNECTED,
};

/** 画面に注意表示を出すべき状態か（接続済みのときは出さない）。 */
export function isDegradedStatus(status: RoomChannelStatus): boolean {
  return status !== 'connected';
}

/**
 * 複数チャンネル（public / staff）の状態をひとつに畳み込む。
 * すべて接続済みのときだけ connected とする。
 */
export function mergeChannelStatuses(
  statuses: readonly RoomChannelStatus[],
): RoomChannelStatus {
  if (statuses.length === 0) {
    return 'connecting';
  }
  if (statuses.every((status) => status === 'connected')) {
    return 'connected';
  }
  if (statuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (statuses.some((status) => status === 'connecting')) {
    return 'connecting';
  }
  return 'disconnected';
}
