/**
 * Realtime Broadcast で届いた payload の検証。
 *
 * Broadcast は「状態が変わった」通知でしかないため、
 * 中身を信用して画面状態を組み立てない。ここでは形だけ検査し、
 * 実際の状態は必ず Snapshot API から取り直す。
 */

import type { RoomEventEnvelope } from '@/domain/room/events';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 形が合わなければ null。呼び出し側は黙って捨てる。 */
export function parseRoomEventEnvelope(payload: unknown): RoomEventEnvelope | null {
  if (!isRecord(payload)) {
    return null;
  }

  const { eventId, type, roomId, stateVersion, serverTime } = payload;

  if (
    typeof eventId !== 'string' ||
    typeof type !== 'string' ||
    typeof roomId !== 'string' ||
    typeof serverTime !== 'string' ||
    typeof stateVersion !== 'number' ||
    !Number.isFinite(stateVersion)
  ) {
    return null;
  }

  return {
    eventId,
    type,
    roomId,
    stateVersion,
    serverTime,
    payload: payload.payload,
  };
}
