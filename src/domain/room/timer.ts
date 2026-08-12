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
 * 残り 5,4,3,2,1,0 秒で 1 回だけ tick 音を鳴らすための判定。
 *
 * 0 秒も鳴らす。会場では「時間切れ」の瞬間が音で分かるほうが分かりやすく、
 * 締切の遷移（answer-lock）は通信を挟むぶん少し遅れて鳴るため。
 */
export const TICK_SECONDS = [5, 4, 3, 2, 1, 0] as const;

export function shouldPlayTick(previousSeconds: number | null, currentSeconds: number): boolean {
  if (previousSeconds === currentSeconds) {
    return false;
  }
  if (previousSeconds !== null && currentSeconds > previousSeconds) {
    // タブ復帰などで巻き戻った場合は鳴らさない。
    return false;
  }
  return (TICK_SECONDS as readonly number[]).includes(currentSeconds);
}

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
