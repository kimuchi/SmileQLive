import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  URGENT_SECONDS,
  computeServerOffsetMs,
  correctedNow,
  elapsedRatio,
  remainingMs,
  remainingSeconds,
} from '@/domain/room/timer';
import type { ServerClock } from '@/domain/room/timer';

/**
 * カウントダウン表示（仕様書 §37.1）。
 *
 * 締切判定そのものはサーバー（Cloud Run の Date.now()）が行う。
 * ここで検証するのは「表示用にローカル時計を補正する計算」だけであり、
 * クライアント時計を正とみなさないことを前提にしている。
 */

const LOCAL_NOW = Date.parse('2026-08-10T10:00:00.000Z');
const NO_OFFSET: ServerClock = { offsetMs: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe('computeServerOffsetMs', () => {
  it('サーバーが進んでいれば正の差分', () => {
    expect(computeServerOffsetMs('2026-08-10T10:00:05.000Z', LOCAL_NOW)).toBe(5000);
  });

  it('サーバーが遅れていれば負の差分', () => {
    expect(computeServerOffsetMs('2026-08-10T09:59:57.500Z', LOCAL_NOW)).toBe(-2500);
  });

  it('同時刻なら 0', () => {
    expect(computeServerOffsetMs('2026-08-10T10:00:00.000Z', LOCAL_NOW)).toBe(0);
  });

  it('解釈できない時刻文字列なら 0 にフォールバックする', () => {
    expect(computeServerOffsetMs('not-a-date', LOCAL_NOW)).toBe(0);
    expect(computeServerOffsetMs('', LOCAL_NOW)).toBe(0);
  });

  it('localNowMs 省略時は現在時刻を使う', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(LOCAL_NOW));

    expect(computeServerOffsetMs('2026-08-10T10:00:03.000Z')).toBe(3000);
  });

  it('タイムゾーン表記が違っても同じ瞬間なら 0', () => {
    expect(computeServerOffsetMs('2026-08-10T19:00:00.000+09:00', LOCAL_NOW)).toBe(0);
  });
});

describe('correctedNow', () => {
  it('ローカル時刻へオフセットを足してサーバー時刻を推定する', () => {
    expect(correctedNow({ offsetMs: 1500 }, LOCAL_NOW)).toBe(LOCAL_NOW + 1500);
    expect(correctedNow({ offsetMs: -1500 }, LOCAL_NOW)).toBe(LOCAL_NOW - 1500);
  });
});

describe('remainingMs / remainingSeconds', () => {
  it('締切までの残りミリ秒を返す', () => {
    expect(remainingMs('2026-08-10T10:00:04.500Z', NO_OFFSET, LOCAL_NOW)).toBe(4500);
  });

  it('残り秒は切り上げる（4.5 秒なら 5 と表示する）', () => {
    expect(remainingSeconds('2026-08-10T10:00:04.500Z', NO_OFFSET, LOCAL_NOW)).toBe(5);
    expect(remainingSeconds('2026-08-10T10:00:04.000Z', NO_OFFSET, LOCAL_NOW)).toBe(4);
    expect(remainingSeconds('2026-08-10T10:00:00.001Z', NO_OFFSET, LOCAL_NOW)).toBe(1);
  });

  it('サーバー時計とのずれを補正する', () => {
    // サーバーが 1 秒進んでいる → 体感の残り時間は 1 秒短い。
    expect(remainingSeconds('2026-08-10T10:00:04.500Z', { offsetMs: 1000 }, LOCAL_NOW)).toBe(4);
    // サーバーが 1 秒遅れている → 残り時間は 1 秒長い。
    expect(remainingSeconds('2026-08-10T10:00:04.500Z', { offsetMs: -1000 }, LOCAL_NOW)).toBe(6);
  });

  it('締切を過ぎたら 0（負にしない）', () => {
    expect(remainingMs('2026-08-10T09:59:50.000Z', NO_OFFSET, LOCAL_NOW)).toBe(0);
    expect(remainingSeconds('2026-08-10T09:59:50.000Z', NO_OFFSET, LOCAL_NOW)).toBe(0);
  });

  it('締切がちょうど現在時刻なら 0', () => {
    expect(remainingSeconds('2026-08-10T10:00:00.000Z', NO_OFFSET, LOCAL_NOW)).toBe(0);
  });

  it('締切が未設定・不正なら 0', () => {
    expect(remainingSeconds(null, NO_OFFSET, LOCAL_NOW)).toBe(0);
    expect(remainingSeconds('not-a-date', NO_OFFSET, LOCAL_NOW)).toBe(0);
  });
});

describe('URGENT_SECONDS', () => {
  it('表示だけの基準として残り 5 秒を持つ', () => {
    // 効果音は残り秒数で出し分けない（受付中はずっと鳴らす）。
    // ここは投影のカウントダウン表示を赤くする閾値としてだけ使う。
    expect(URGENT_SECONDS).toBe(5);
  });
});

describe('elapsedRatio', () => {
  it('開始直後は 0、締切時は 1', () => {
    expect(elapsedRatio('2026-08-10T10:00:20.000Z', 20, NO_OFFSET, LOCAL_NOW)).toBe(0);
    expect(elapsedRatio('2026-08-10T10:00:00.000Z', 20, NO_OFFSET, LOCAL_NOW)).toBe(1);
  });

  it('中間では経過割合を返す', () => {
    expect(elapsedRatio('2026-08-10T10:00:05.000Z', 20, NO_OFFSET, LOCAL_NOW)).toBe(0.75);
  });

  it('0〜1 の範囲に収める', () => {
    expect(elapsedRatio('2026-08-10T09:59:00.000Z', 20, NO_OFFSET, LOCAL_NOW)).toBe(1);
    expect(elapsedRatio('2026-08-10T10:01:00.000Z', 20, NO_OFFSET, LOCAL_NOW)).toBe(0);
  });

  it('締切未設定・制限時間 0 なら 0', () => {
    expect(elapsedRatio(null, 20, NO_OFFSET, LOCAL_NOW)).toBe(0);
    expect(elapsedRatio('2026-08-10T10:00:10.000Z', 0, NO_OFFSET, LOCAL_NOW)).toBe(0);
  });
});
