/**
 * Realtime 通知のポート。
 *
 * 原則:
 * - 送信は**必ず DB 更新が成功した後**に行う。
 * - 送信失敗は例外にしない（DB 状態をロールバックしない）。受信側は Snapshot で補正する。
 * - イベントへ参加トークン・投影トークン・発表前の正解情報を含めない。
 */

import type { RoomEventEnvelope } from '@/domain/room/events';

export type EventPublisher = {
  publishPublicEvent(roomId: string, envelope: RoomEventEnvelope): Promise<void>;
  publishStaffEvent(roomId: string, envelope: RoomEventEnvelope): Promise<void>;
};
