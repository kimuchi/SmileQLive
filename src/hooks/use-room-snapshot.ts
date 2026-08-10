'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomEventEnvelope } from '@/domain/room/events';
import type { ServerClock } from '@/domain/room/timer';
import { apiGet } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import { isProgressEventType } from '@/lib/client/room-event';
import type { RoomChannelStatus } from '@/lib/client/realtime-status';
import { useRoomChannel } from '@/hooks/use-room-channel';
import { useServerClock } from '@/hooks/use-server-clock';

/**
 * Snapshot + リアルタイム購読を組み合わせた画面状態の取得。
 *
 * 原則:
 * - DB（Snapshot API）が唯一の正。**Firestore を購読していても、実データは必ず
 *   Snapshot API から取る。** 購読は「取り直せ」という合図にすぎない。
 * - 購読で受け取った payload から状態を組み立てない
 *   （公開ドキュメントには正解・問題文・選択肢が入っていない）。
 * - stateVersion の飛びを検知したら必ず Snapshot を取り直す。
 * - 再接続時・タブ復帰時も取り直す。
 * - 300 台規模で同時に叩くため、連続実行は抑制し、進行中なら 1 回だけキューへ積む。
 */

export type RoomSnapshotBase = {
  stateVersion: number;
  serverTime: string;
};

export type UseRoomSnapshotOptions = {
  roomId: string;
  /** 例: '/api/rooms/xxxx/snapshot' */
  endpoint: string;
  audience: 'participant' | 'staff';
  /** false の間は取得も購読も行わない（参加登録前など）。既定は true。 */
  enabled?: boolean;
};

export type UseRoomSnapshotResult<T> = {
  snapshot: T | null;
  error: string | null;
  status: RoomChannelStatus;
  clock: ServerClock;
  refresh: () => Promise<void>;
};

/** 購読が切れている間だけ動かす保険のポーリング間隔。 */
const FALLBACK_POLL_INTERVAL_MS = 15_000;

/**
 * 進捗イベント（回答数の増加など）で取り直す最短間隔。
 *
 * 進捗は stateVersion が変わらないまま何度も届く。
 * 200 人が一斉に回答してもサーバーを叩きすぎないよう、ここで間引く。
 */
const PROGRESS_REFRESH_MIN_INTERVAL_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * API は { snapshot: ... } で返す契約だが、素の Snapshot が返っても壊れないようにする。
 */
function extractSnapshot<T extends RoomSnapshotBase>(payload: unknown): T | null {
  if (!isRecord(payload)) {
    return null;
  }
  const candidate = isRecord(payload.snapshot) ? payload.snapshot : payload;
  if (typeof candidate.stateVersion !== 'number' || typeof candidate.serverTime !== 'string') {
    return null;
  }
  return candidate as T;
}

export function useRoomSnapshot<T extends RoomSnapshotBase>(
  options: UseRoomSnapshotOptions,
): UseRoomSnapshotResult<T> {
  const { roomId, endpoint, audience, enabled = true } = options;

  const [snapshot, setSnapshot] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const queuedRef = useRef(false);
  /** 反映済みの stateVersion。飛びの判定と、古い応答の破棄に使う。 */
  // ルームが切り替わると版番号もリセットする必要があるため、
  // どのルームの版番号かをキーと一緒に保持する（リセットは非同期処理の中で行う）。
  const stateVersionRef = useRef<{ key: string; value: number | null }>({
    key: `${roomId}|${endpoint}`,
    value: null,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ルームや取得先が変わったら、前のルームの状態を即座に捨てる。
  // effect で行うと「前のルームの Snapshot が 1 フレーム見える」ため、
  // React 公式の「props 変更時に state を調整する」パターンでレンダー中に捨てる。
  const sourceKey = `${roomId}|${endpoint}`;
  const [lastSourceKey, setLastSourceKey] = useState(sourceKey);
  if (lastSourceKey !== sourceKey) {
    setLastSourceKey(sourceKey);
    setSnapshot(null);
    setError(null);
  }

  const fetchOnce = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiGet<unknown>(endpoint);
      if (!mountedRef.current) {
        return;
      }
      const next = extractSnapshot<T>(payload);
      if (!next) {
        setError(toUserErrorMessage(null));
        return;
      }
      // ルームが切り替わっていたら版番号を捨ててから比較する。
      if (stateVersionRef.current.key !== sourceKey) {
        stateVersionRef.current = { key: sourceKey, value: null };
      }
      const current = stateVersionRef.current.value;
      // 遅れて届いた古い Snapshot で巻き戻さない。
      if (current !== null && next.stateVersion < current) {
        setError(null);
        return;
      }
      stateVersionRef.current = { key: sourceKey, value: next.stateVersion };
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (!mountedRef.current) {
        return;
      }
      setError(toUserErrorMessage(caught));
    }
  }, [endpoint, sourceKey]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }
    const running = inFlightRef.current;
    if (running) {
      // 進行中なら「もう 1 回だけ」積む。連打しても取得は増えない。
      queuedRef.current = true;
      await running;
      return;
    }

    const run = (async () => {
      await fetchOnce();
      while (queuedRef.current && mountedRef.current) {
        queuedRef.current = false;
        await fetchOnce();
      }
    })();

    inFlightRef.current = run;
    try {
      await run;
    } finally {
      inFlightRef.current = null;
      queuedRef.current = false;
    }
  }, [enabled, fetchOnce]);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // 初回取得（ルーム・取得先が変わったときも）。
  useEffect(() => {
    // 前のルームの stateVersion が残っていると、新しいルームの Snapshot を
    // 「古い応答」と誤判定して捨ててしまうため必ず戻す。
    stateVersionRef.current = { key: sourceKey, value: null };
    if (!enabled || roomId.length === 0) {
      return;
    }
    void refreshRef.current();
  }, [enabled, roomId, endpoint, sourceKey]);

  // 進捗イベントの間引き用。
  const progressRefreshedAtRef = useRef(0);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (progressTimerRef.current !== null) {
        clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
    };
  }, []);

  const handleEvent = useCallback(
    (envelope: RoomEventEnvelope) => {
      if (envelope.roomId !== roomId) {
        return;
      }

      // 回答数・内訳の進捗は stateVersion が変わらないまま届くため、
      // 版番号では新旧を判別できない。間引いたうえで Snapshot を取り直す
      // （司会・投影だけが購読するイベントで、参加者へは届かない）。
      if (isProgressEventType(envelope.type)) {
        const elapsed = Date.now() - progressRefreshedAtRef.current;
        if (elapsed >= PROGRESS_REFRESH_MIN_INTERVAL_MS) {
          progressRefreshedAtRef.current = Date.now();
          void refreshRef.current();
          return;
        }
        if (progressTimerRef.current !== null) {
          return;
        }
        progressTimerRef.current = setTimeout(() => {
          progressTimerRef.current = null;
          progressRefreshedAtRef.current = Date.now();
          void refreshRef.current();
        }, PROGRESS_REFRESH_MIN_INTERVAL_MS - elapsed);
        return;
      }

      const tracked = stateVersionRef.current;
      // 反映済みの版番号は「同じルーム・同じ取得先」のときだけ意味を持つ。
      const known = tracked.key === sourceKey ? tracked.value : null;
      // すでに同じか新しい状態を持っているなら取り直さない。
      if (known !== null && envelope.stateVersion <= known) {
        return;
      }
      // known + 1 でなければイベントが欠落している。いずれにせよ Snapshot が正。
      void refreshRef.current();
    },
    [roomId, sourceKey],
  );

  const previousStatusRef = useRef<RoomChannelStatus>('connecting');
  const handleStatusChange = useCallback((next: RoomChannelStatus) => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = next;
    // 再接続できた瞬間は、切断中に取りこぼした変化を必ず拾い直す。
    if (next === 'connected' && previous !== 'connected') {
      void refreshRef.current();
    }
  }, []);

  const { status } = useRoomChannel({
    roomId: enabled ? roomId : '',
    audience,
    onEvent: handleEvent,
    onStatusChange: handleStatusChange,
  });

  // タブ復帰時の取り直し。
  useEffect(() => {
    if (!enabled || roomId.length === 0) {
      return;
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshRef.current();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, roomId]);

  // Realtime が繋がっていない間だけの保険。繋がっていればポーリングしない。
  useEffect(() => {
    if (!enabled || roomId.length === 0 || status === 'connected') {
      return;
    }
    const timerId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshRef.current();
      }
    }, FALLBACK_POLL_INTERVAL_MS);
    return () => {
      clearInterval(timerId);
    };
  }, [enabled, roomId, status]);

  const clock = useServerClock(snapshot?.serverTime ?? null);

  return { snapshot, error, status, clock, refresh };
}
