'use client';

import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { onSnapshot, type FirestoreError, type Unsubscribe } from 'firebase/firestore';
import type { RoomEventEnvelope } from '@/domain/room/events';
import { useOptionalFirebaseAuth, useOptionalFirestore } from '@/hooks/use-firebase-client';
import { computeBackoffDelayMs } from '@/lib/client/backoff';
import { publicStateDocRef, staffProgressDocRef } from '@/lib/client/firestore-paths';
import { publicStateToEnvelope, staffProgressToEnvelope } from '@/lib/client/room-event';
import { mergeChannelStatuses, type RoomChannelStatus } from '@/lib/client/realtime-status';

export type { RoomChannelStatus } from '@/lib/client/realtime-status';

/**
 * ルームのリアルタイム購読（Firestore `onSnapshot`）。
 *
 * 方針:
 * - 購読は「状態が変わった」通知だけ。**ここで画面状態を組み立てない。**
 *   実データは必ず Snapshot API から取り直す（use-room-snapshot）。
 * - 参加者が購読するのは `rooms/{roomId}/public/state` **だけ**。
 *   このドキュメントには正解・問題文・選択肢が含まれない（docs/FIRESTORE_MODEL.md §2）。
 *   `rooms/{roomId}` 本体と `quizzes/**` は正解を含むため購読しない
 *   （Security Rules でも参加者から到達不能）。
 * - 司会・投影のみ `rooms/{roomId}/staff/progress` を追加で購読する。
 *   **参加者は staff ドキュメントを購読しない**（Rules でも拒否されるが、そもそも購読しない）。
 * - 読み取り専用。**クライアントから Firestore へ書き込まない。**
 * - 初回スナップショットで 'connected'。エラーは 'error' にして
 *   指数バックオフ（1s→2s→4s→8s、上限 30s、ジッタ付き）で購読し直す。
 * - アンマウント時は必ず unsubscribe する。
 */

export type UseRoomChannelOptions = {
  roomId: string;
  audience: 'participant' | 'staff';
  onEvent: (envelope: RoomEventEnvelope) => void;
  onStatusChange?: (status: RoomChannelStatus) => void;
};

/** 購読先の種類。参加者は 'public' のみ。 */
type ChannelSource = 'public' | 'staff';

type ChannelEntry = {
  source: ChannelSource;
  unsubscribe: Unsubscribe | null;
  timerId: ReturnType<typeof setTimeout> | null;
  attempt: number;
  status: RoomChannelStatus;
  /** 購読し直すたびに増やし、古いコールバックを無視するための世代番号。 */
  generation: number;
  /** 同じ内容の再通知（キャッシュ由来など）を二重に流さないための直近イベントID。 */
  lastEventId: string | null;
};

export function useRoomChannel(options: UseRoomChannelOptions): { status: RoomChannelStatus } {
  const { roomId, audience, onEvent, onStatusChange } = options;
  const db = useOptionalFirestore();
  const auth = useOptionalFirebaseAuth();

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

    const publishStatus = (next: RoomChannelStatus) => {
      if (disposed || next === lastPublishedStatus) {
        return;
      }
      lastPublishedStatus = next;
      setStatus(next);
      onStatusChangeRef.current?.(next);
    };

    if (!db) {
      // Firebase の公開設定が無い環境。購読はできないが画面は止めない
      // （use-room-snapshot 側の保険ポーリングで進行を追い続ける）。
      publishStatus('error');
      return;
    }

    // 参加者は public のみ。司会・投影だけが staff を足す。
    const sources: ChannelSource[] = audience === 'staff' ? ['public', 'staff'] : ['public'];

    const entries: ChannelEntry[] = sources.map((source) => ({
      source,
      unsubscribe: null,
      timerId: null,
      attempt: 0,
      status: 'connecting',
      generation: 0,
      lastEventId: null,
    }));

    const publishMergedStatus = () => {
      publishStatus(mergeChannelStatuses(entries.map((entry) => entry.status)));
    };

    const detach = (entry: ChannelEntry) => {
      const unsubscribe = entry.unsubscribe;
      entry.unsubscribe = null;
      entry.generation += 1;
      entry.lastEventId = null;
      if (unsubscribe) {
        unsubscribe();
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
        publishMergedStatus();
        void connect(entry);
      }, delayMs);
    };

    const handleFailure = (entry: ChannelEntry) => {
      if (disposed) {
        return;
      }
      entry.status = 'error';
      publishMergedStatus();
      scheduleReconnect(entry);
    };

    const connect = async (entry: ChannelEntry): Promise<void> => {
      if (disposed) {
        return;
      }

      // 待っている間に購読し直された（detach された）呼び出しを捨てるための世代番号。
      // await をまたぐたびに確認し、二重購読を作らない。
      const generation = entry.generation;

      // Security Rules は request.auth を見る。サインインが確定する前に購読すると
      // 必ず permission-denied になるため、先に認証状態を待つ。
      if (auth) {
        try {
          await auth.authStateReady();
        } catch {
          // 認証状態が読めなくても購読は試みる（拒否されたら通常のエラー扱い）。
        }
      }

      if (disposed || generation !== entry.generation) {
        return;
      }

      if (auth && auth.currentUser === null) {
        // 未サインイン。バックオフで待ち、サインインが済んだら
        // onAuthStateChanged 側が即座に繋ぎ直す。
        handleFailure(entry);
        return;
      }

      const ref =
        entry.source === 'staff' ? staffProgressDocRef(db, roomId) : publicStateDocRef(db, roomId);

      try {
        entry.unsubscribe = onSnapshot(
          ref,
          { includeMetadataChanges: false },
          (snapshot) => {
            if (disposed || generation !== entry.generation) {
              return;
            }

            // 初回スナップショットが届いた時点で購読は成立している。
            entry.attempt = 0;
            if (entry.status !== 'connected') {
              entry.status = 'connected';
              publishMergedStatus();
            }

            if (!snapshot.exists()) {
              return;
            }

            const data: unknown = snapshot.data();
            const envelope =
              entry.source === 'staff'
                ? staffProgressToEnvelope(roomId, data)
                : publicStateToEnvelope(roomId, data);

            if (!envelope || envelope.eventId === entry.lastEventId) {
              return;
            }
            entry.lastEventId = envelope.eventId;
            onEventRef.current(envelope);
          },
          (_error: FirestoreError) => {
            if (disposed || generation !== entry.generation) {
              return;
            }
            // 失敗理由（permission-denied / unavailable）は画面へ出さない。
            // 「再接続しています」とだけ伝え、バックオフで購読し直す。
            handleFailure(entry);
          },
        );
      } catch {
        handleFailure(entry);
      }
    };

    /** 待たずに繋ぎ直す（回線復帰・サインイン完了の直後）。 */
    const reconnectPending = () => {
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
        publishMergedStatus();
        void connect(entry);
      }
    };

    window.addEventListener('online', reconnectPending);

    // サインインが後から完了した場合に、バックオフの待ち時間を待たずに繋ぎ直す。
    // 登録直後（1 回目のコールバック）は下の初回接続と重複するため無視する。
    let authCallbackSeen = false;
    const unsubscribeAuth = auth
      ? onAuthStateChanged(auth, (user) => {
          if (!authCallbackSeen) {
            authCallbackSeen = true;
            return;
          }
          if (user) {
            reconnectPending();
          }
        })
      : null;

    publishMergedStatus();
    for (const entry of entries) {
      void connect(entry);
    }

    return () => {
      disposed = true;
      window.removeEventListener('online', reconnectPending);
      unsubscribeAuth?.();
      for (const entry of entries) {
        if (entry.timerId !== null) {
          clearTimeout(entry.timerId);
          entry.timerId = null;
        }
        detach(entry);
      }
    };
  }, [db, auth, roomId, audience]);

  return { status };
}
