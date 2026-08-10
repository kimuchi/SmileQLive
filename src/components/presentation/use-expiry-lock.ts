'use client';

import { useEffect, useRef } from 'react';
import { apiPost } from '@/lib/client/api-client';
import type { RoomActionResponse } from '@/types/api';

/**
 * 残り 0 秒になったら締切 API を呼ぶ。
 *
 * 大事なところ:
 * - 締切の判定はサーバー（DB 時刻）が行う。ここが送るのは「時間が来たようだ」という合図だけで、
 *   時刻そのものは一切送らない。
 * - 同じ状態番号に対して呼ぶのは 1 回だけ。API 自体も冪等なので、
 *   司会が先に締め切っていても二重遷移にはならない。
 * - 失敗しても画面は壊さない。締切が遅れても、回答 API が DB 時刻で期限切れ回答を拒否する。
 */
export function useExpiryLock({
  roomId,
  phase,
  stateVersion,
  expired,
  onLocked,
}: {
  roomId: string;
  phase: string;
  stateVersion: number | null;
  /** 表示上の残り時間が 0 になったか。 */
  expired: boolean;
  /** 締切が成立したときに Snapshot を取り直すための通知。 */
  onLocked: () => void;
}): void {
  /** 既に呼んだ「ルーム:状態番号」。同じ状態では二度と呼ばない。 */
  const requestedRef = useRef<string | null>(null);
  const onLockedRef = useRef(onLocked);

  useEffect(() => {
    onLockedRef.current = onLocked;
  }, [onLocked]);

  useEffect(() => {
    if (phase !== 'question_open' || !expired || stateVersion === null) {
      return;
    }
    const key = `${roomId}:${stateVersion}`;
    if (requestedRef.current === key) {
      return;
    }
    requestedRef.current = key;

    void (async () => {
      try {
        const result = await apiPost<RoomActionResponse>(`/api/rooms/${roomId}/lock-if-expired`);
        if (result.phase !== 'question_open') {
          onLockedRef.current();
        }
      } catch {
        // 権限が無い・通信が切れているなど。司会側の操作でも締め切れるため、ここでは何もしない。
      }
    })();
  }, [expired, phase, roomId, stateVersion]);
}
