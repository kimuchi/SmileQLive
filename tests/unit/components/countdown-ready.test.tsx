// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCountdown } from '@/hooks/use-countdown';

/**
 * 残り時間の `ready`。
 *
 * 締切時刻が届いた直後の 1 回だけ、状態にはまだ前の値（＝残り 0）が入っている。
 * その 1 回を「時間切れ」と受け取ると、締切の自動処理が本来より早く 1 度走り、
 * 二重実行防止に阻まれて**本当の締切時刻に何も起きなくなる**。
 * 実際にその不具合が起きたため、ここで固定する。
 */
describe('残り時間の ready', () => {
  it('締切時刻が無いうちは ready にならない', () => {
    const { result } = renderHook(() => useCountdown(null, { offsetMs: 0 }));
    expect(result.current.ready).toBe(false);
  });

  it('締切時刻が届いた直後のレンダーを「時間切れ」と誤解しない', () => {
    // **レンダーのたびの値**を見る。結果だけを見ると、届いた直後の 1 回を見逃す。
    const seen: { ready: boolean; remainingMs: number }[] = [];
    const { rerender } = renderHook(
      ({ deadline }: { deadline: string | null }) => {
        const countdown = useCountdown(deadline, { offsetMs: 0 });
        seen.push({ ready: countdown.ready, remainingMs: countdown.remainingMs });
        return countdown;
      },
      { initialProps: { deadline: null as string | null } },
    );

    // 締切時刻が届いた瞬間。まだ計算前でも「残り 0 の時間切れ」に見えてはいけない。
    const deadline = new Date(Date.now() + 30_000).toISOString();
    rerender({ deadline });

    const wronglyExpired = seen.filter((entry) => entry.ready && entry.remainingMs <= 0);
    expect(wronglyExpired).toEqual([]);
  });

  it('計算が済んだら ready になり、残り時間を返す', () => {
    const deadline = new Date(Date.now() + 30_000).toISOString();
    const { result } = renderHook(() => useCountdown(deadline, { offsetMs: 0 }));

    expect(result.current.ready).toBe(true);
    expect(result.current.remainingMs).toBeGreaterThan(25_000);
    expect(result.current.remainingSeconds).toBeGreaterThan(25);
  });

  it('締切を過ぎていれば ready かつ残り 0', () => {
    const deadline = new Date(Date.now() - 5_000).toISOString();
    const { result } = renderHook(() => useCountdown(deadline, { offsetMs: 0 }));

    expect(result.current.ready).toBe(true);
    expect(result.current.remainingMs).toBe(0);
  });
});
