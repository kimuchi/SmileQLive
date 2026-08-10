'use client';

import { useEffect, useMemo, useState } from 'react';
import { computeServerOffsetMs, type ServerClock } from '@/domain/room/timer';

/**
 * サーバー時刻との差分を保持する。
 *
 * 締切判定そのものはサーバー／DB が行う。ここで求めるのは「表示のための補正値」だけ。
 * 端末の時計が数分ずれていても、カウントダウンが破綻しないようにする。
 *
 * 実装上の注意:
 *   壁時計の読み取り (Date.now()) は純粋ではないため、レンダー中には行えない。
 *   そのため effect 内で計算して state へ反映する。
 *   effect が走るのは serverTimeIso が変わったとき＝Snapshot を取り直したときだけで、
 *   そのタイミングでは元々再レンダリングが発生しているため、
 *   react-hooks/set-state-in-effect が警戒する「レンダーの連鎖」は起きない。
 *   さらに 200ms 未満のずれは無視して余計な再レンダリングを避けている。
 */

/** この幅未満のずれは無視して再レンダリングを避ける。 */
const OFFSET_UPDATE_THRESHOLD_MS = 200;

export function useServerClock(serverTimeIso: string | null): ServerClock {
  const [offsetMs, setOffsetMs] = useState(0);

  useEffect(() => {
    if (!serverTimeIso) {
      return;
    }
    const next = computeServerOffsetMs(serverTimeIso, Date.now());
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 壁時計の読み取りはレンダー中に行えないため
    setOffsetMs((previous) =>
      Math.abs(next - previous) < OFFSET_UPDATE_THRESHOLD_MS ? previous : next,
    );
  }, [serverTimeIso]);

  return useMemo<ServerClock>(() => ({ offsetMs }), [offsetMs]);
}
