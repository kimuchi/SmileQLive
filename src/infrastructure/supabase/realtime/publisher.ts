import 'server-only';

/**
 * サーバーからの Realtime Broadcast 送信。
 *
 * 原則:
 * - **DB 更新が成功した後にだけ**送信する。
 * - 送信に失敗しても例外を投げず warn ログのみ。DB 状態はロールバックしない。
 *   受信側は Snapshot 再取得で必ず復元できる設計なので、通知欠落は致命的ではない。
 * - public チャンネルには「状態が変わった」ことだけを流し、正解情報を含めない。
 * - staff チャンネルにも参加トークン・投影トークンを含めない。
 */

import { createSupabaseAdminClient } from '@/infrastructure/supabase/admin';
import { logger } from '@/infrastructure/logging/logger';
import {
  createEventEnvelope,
  publicChannelName,
  ROOM_STATE_EVENT,
  staffChannelName,
  type RoomEventEnvelope,
} from '@/domain/room/events';

/** 送信結果を待つ上限。会場進行を止めないため短めにする。 */
const SEND_TIMEOUT_MS = 3000;

async function publish(
  channelName: string,
  envelope: RoomEventEnvelope,
  audience: 'public' | 'staff',
): Promise<void> {
  try {
    const client = createSupabaseAdminClient();
    const channel = client.channel(channelName, {
      config: { broadcast: { self: false, ack: false }, private: false },
    });

    try {
      const result = await channel.send({
        type: 'broadcast',
        event: ROOM_STATE_EVENT,
        payload: envelope,
      });

      if (result !== 'ok') {
        logger.warn('realtime.publish_not_ok', {
          audience,
          roomId: envelope.roomId,
          eventType: envelope.type,
          stateVersion: envelope.stateVersion,
          sendResult: String(result),
        });
      }
    } finally {
      await client.removeChannel(channel);
    }
  } catch (error) {
    // 送信失敗は握りつぶす。DB が唯一の正であり、クライアントは Snapshot で補正できる。
    logger.warn('realtime.publish_failed', {
      audience,
      roomId: envelope.roomId,
      eventType: envelope.type,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function withTimeout(promise: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), SEND_TIMEOUT_MS);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 参加者・投影を含む全員向けチャンネルへ送る。 */
export async function publishPublicEvent(
  roomId: string,
  envelope: RoomEventEnvelope,
): Promise<void> {
  await withTimeout(publish(publicChannelName(roomId), envelope, 'public'));
}

/** 司会・投影だけが購読するチャンネルへ送る。 */
export async function publishStaffEvent(
  roomId: string,
  envelope: RoomEventEnvelope,
): Promise<void> {
  await withTimeout(publish(staffChannelName(roomId), envelope, 'staff'));
}

/** 呼び出し側で eventId / serverTime を用意しなくてよいようにするヘルパー。 */
export function buildEnvelope<TType extends string, TPayload>(input: {
  type: TType;
  roomId: string;
  stateVersion: number;
  payload: TPayload;
  serverTime?: string;
}): RoomEventEnvelope<TType, TPayload> {
  return createEventEnvelope({
    eventId: crypto.randomUUID(),
    type: input.type,
    roomId: input.roomId,
    stateVersion: input.stateVersion,
    serverTime: input.serverTime ?? new Date().toISOString(),
    payload: input.payload,
  });
}

export const eventPublisher = {
  publishPublicEvent,
  publishStaffEvent,
};
