/**
 * カウントダウン表示。
 *
 * - 締切時刻 (answer_deadline_at) はサーバーが DB 時刻で設定する。
 * - クライアントは serverTime との差分でローカル時計を補正し、表示だけをローカルで更新する。
 * - 毎秒の DB 書込み・Realtime 送信は行わない。
 */

export type ServerClock = {
  /** localNow + offsetMs ≒ サーバー時刻 */
  offsetMs: number;
};

export function computeServerOffsetMs(serverTimeIso: string, localNowMs: number = Date.now()) {
  const serverMs = Date.parse(serverTimeIso);
  if (Number.isNaN(serverMs)) {
    return 0;
  }
  return serverMs - localNowMs;
}

export function correctedNow(clock: ServerClock, localNowMs: number = Date.now()): number {
  return localNowMs + clock.offsetMs;
}

export function remainingMs(
  deadlineAtIso: string | null,
  clock: ServerClock,
  localNowMs: number = Date.now(),
): number {
  if (!deadlineAtIso) {
    return 0;
  }
  const deadlineMs = Date.parse(deadlineAtIso);
  if (Number.isNaN(deadlineMs)) {
    return 0;
  }
  return Math.max(0, deadlineMs - correctedNow(clock, localNowMs));
}

export function remainingSeconds(
  deadlineAtIso: string | null,
  clock: ServerClock,
  localNowMs: number = Date.now(),
): number {
  return Math.ceil(remainingMs(deadlineAtIso, clock, localNowMs) / 1000);
}

/**
 * 「残りわずか」と見せ始める秒数。
 *
 * 表示だけの基準。効果音は受付が開いている間ずっと鳴らし続けるので、
 * 残り秒数から音を出し分けることはしない（鳴らす・鳴らさないが切り替わると、
 * 会場では「音が途切れた」としか聞こえない）。
 */
export const URGENT_SECONDS = 5;

/** 進捗バー用の割合 (0-1)。 */
export function elapsedRatio(
  deadlineAtIso: string | null,
  timeLimitSeconds: number,
  clock: ServerClock,
  localNowMs: number = Date.now(),
): number {
  if (!deadlineAtIso || timeLimitSeconds <= 0) {
    return 0;
  }
  const totalMs = timeLimitSeconds * 1000;
  const left = remainingMs(deadlineAtIso, clock, localNowMs);
  return Math.min(1, Math.max(0, (totalMs - left) / totalMs));
}
