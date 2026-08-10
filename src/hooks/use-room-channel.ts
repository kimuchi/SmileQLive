'use client';

import { useEffect, useRef, useState } from 'react';
import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from '@supabase/supabase-js';
import { useSupabaseClient } from '@/components/shared/runtime-config-provider';
import {
  ROOM_STATE_EVENT,
  publicChannelName,
  staffChannelName,
  type RoomEventEnvelope,
} from '@/domain/room/events';
import { computeBackoffDelayMs } from '@/lib/client/backoff';
import { parseRoomEventEnvelope } from '@/lib/client/room-event';
import { mergeChannelStatuses, type RoomChannelStatus } from '@/lib/client/realtime-status';

export type { RoomChannelStatus } from '@/lib/client/realtime-status';

/**
 * ルームの Realtime チャンネル購読。
 *
 * 方針:
 * - Realtime は「状態が変わった」通知だけ。ここで状態を組み立てない。
 * - private channel として購読し、購読可否は realtime.messages の RLS が決める。
 * - 参加者は public チャンネルのみ。司会・投影は public と staff の両方。
 * - SUBSCRIBED を確認するまではイベントを流さない。
 * - 切断・エラー・タイムアウトは指数バックオフ（1s→2s→4s→8s、上限30s、ジッタ付き）で再接続する。
 * - アンマウント時は必ず removeChannel する。
 */

export type UseRoomChannelOptions = {
  roomId: string;
  audience: 'participant' | 'staff';
  onEvent: (envelope: RoomEventEnvelope) => void;
  onStatusChange?: (status: RoomChannelStatus) => void;
};

type ChannelEntry = {
  name: string;
  channel: RealtimeChannel | null;
  timerId: ReturnType<typeof setTimeout> | null;
  attempt: number;
  status: RoomChannelStatus;
  /** 再接続のたびに増やし、古いコールバックを無視するための世代番号。 */
  generation: number;
};

export function useRoomChannel(options: UseRoomChannelOptions): { status: RoomChannelStatus } {
  const { roomId, audience, onEvent, onStatusChange } = options;
  const client = useSupabaseClient();

  const [status, setStatus] = useState<RoomChannelStatus>('connecting');

  // 参照だけ差し替え、購読はやり直さない。
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (roomId.length === 0) {
      return;
    }

    let disposed = false;
    let lastPublishedStatus: RoomChannelStatus | null = null;

    const names =
      audience === 'staff'
        ? [publicChannelName(roomId), staffChannelName(roomId)]
        : [publicChannelName(roomId)];

    const entries: ChannelEntry[] = names.map((name) => ({
      name,
      channel: null,
      timerId: null,
      attempt: 0,
      status: 'connecting',
      generation: 0,
    }));

    const publishStatus = () => {
      if (disposed) {
        return;
      }
      const next = mergeChannelStatuses(entries.map((entry) => entry.status));
      if (next === lastPublishedStatus) {
        return;
      }
      lastPublishedStatus = next;
      setStatus(next);
      onStatusChangeRef.current?.(next);
    };

    const detach = (entry: ChannelEntry) => {
      const channel = entry.channel;
      entry.channel = null;
      entry.generation += 1;
      if (channel) {
        void client.removeChannel(channel);
      }
    };

    const scheduleReconnect = (entry: ChannelEntry) => {
      if (disposed || entry.timerId !== null) {
        return;
      }
      const delayMs = computeBackoffDelayMs(entry.attempt);
      entry.attempt += 1;
      entry.timerId = setTimeout(() => {
        entry.timerId = null;
        if (disposed) {
          return;
        }
        detach(entry);
        entry.status = 'connecting';
        publishStatus();
        void connect(entry);
      }, delayMs);
    };

    const connect = async (entry: ChannelEntry): Promise<void> => {
      if (disposed) {
        return;
      }

      // private channel は JWT が必要。購読前にセッションを確定させる。
      try {
        await client.auth.getSession();
      } catch {
        // セッション取得に失敗しても購読は試みる（RLS 側で拒否される）。
      }

      if (disposed) {
        return;
      }

      const generation = entry.generation;
      const channel = client.channel(entry.name, {
        config: { private: true, broadcast: { self: false } },
      });
      entry.channel = channel;

      let subscribed = false;

      channel.on('broadcast', { event: ROOM_STATE_EVENT }, (message) => {
        if (disposed || !subscribed || generation !== entry.generation) {
          return;
        }
        const envelope = parseRoomEventEnvelope(message.payload);
        if (!envelope || envelope.roomId !== roomId) {
          return;
        }
        onEventRef.current(envelope);
      });

      channel.subscribe((state) => {
        if (disposed || generation !== entry.generation) {
          return;
        }

        if (state === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
          subscribed = true;
          entry.attempt = 0;
          entry.status = 'connected';
          publishStatus();
          return;
        }

        subscribed = false;
        entry.status = state === REALTIME_SUBSCRIBE_STATES.CLOSED ? 'disconnected' : 'error';
        publishStatus();
        scheduleReconnect(entry);
      });
    };

    /** 回線が戻った直後は待たずに繋ぎ直す。 */
    const handleOnline = () => {
      if (disposed) {
        return;
      }
      for (const entry of entries) {
        if (entry.status === 'connected') {
          continue;
        }
        if (entry.timerId !== null) {
          clearTimeout(entry.timerId);
          entry.timerId = null;
        }
        entry.attempt = 0;
        detach(entry);
        entry.status = 'connecting';
        publishStatus();
        void connect(entry);
      }
    };

    window.addEventListener('online', handleOnline);

    publishStatus();
    for (const entry of entries) {
      void connect(entry);
    }

    return () => {
      disposed = true;
      window.removeEventListener('online', handleOnline);
      for (const entry of entries) {
        if (entry.timerId !== null) {
          clearTimeout(entry.timerId);
          entry.timerId = null;
        }
        detach(entry);
      }
    };
  }, [client, roomId, audience]);

  return { status };
}
