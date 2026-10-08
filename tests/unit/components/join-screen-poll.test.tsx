// @vitest-environment jsdom
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinScreen } from '@/components/participant/JoinScreen';
import type * as ApiClientModule from '@/lib/client/api-client';
import type { JoinResolveResponse } from '@/types/api';

/**
 * 二次元コードを読んだ直後の画面。
 *
 * 投票では**名前を聞かない**。会場で 200 人にニックネームを打たせると、
 * 打ち終わるまでの数十秒がまるごと待ち時間になるうえ、投票では名前を
 * どこにも出さない（順位表が無い）ので聞く意味がない。
 *
 * ここで固めたいのは 3 つ。
 *   1. 投票のルームではニックネーム欄を出さず、自分で参加登録して投票画面へ送ること。
 *   2. 送る本文に名前を入れないこと（サーバーが割り当てる）。
 *   3. クイズのルームでは、これまでどおり名前を聞くこと。
 */

const apiGet = vi.fn<(path: string) => Promise<unknown>>();
const apiPost = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const replace = vi.fn<(href: string) => void>();

vi.mock('@/lib/client/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return {
    ...actual,
    apiGet: (path: string) => apiGet(path),
    apiPost: (path: string, body?: unknown) => apiPost(path, body),
  };
});

// 本物の useRouter は同じオブジェクトを返し続ける。毎回作ると副作用が
// 描画のたびに走ってしまい、画面ではなく作り物の側が原因で落ちる。
const router = { replace, push: vi.fn(), refresh: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('@/hooks/use-anonymous-session', () => ({
  useEnsureAnonymousSession: () => async () => true,
}));

const TOKEN = 'join-token-0123456789abcd';

function resolved(overrides: Partial<JoinResolveResponse> = {}): JoinResolveResponse {
  return {
    roomId: 'room-1',
    quizTitle: '出し物コンテスト',
    mode: 'poll',
    joinOpen: true,
    participantCount: 3,
    maxParticipants: 200,
    alreadyJoinedNickname: null,
    captchaRequired: false,
    ...overrides,
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  replace.mockReset();
});

describe('投票のルーム', () => {
  it('名前を聞かずに参加して、投票画面へ送る', async () => {
    apiGet.mockResolvedValue(resolved());
    apiPost.mockResolvedValue({ roomId: 'room-1', participantId: 'p1', nickname: '参加者ABC234' });

    render(<JoinScreen joinToken={TOKEN} />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/play/room-1');
    });

    // ニックネームを一度も見せていない。
    expect(screen.queryByLabelText('ニックネーム')).toBeNull();

    // 本文は空。名前はサーバーが割り当てるので、画面から送らない。
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0]?.[0]).toBe(`/api/join/${TOKEN}/register`);
    expect(apiPost.mock.calls[0]?.[1]).toEqual({});
  });

  it('受付が終わっていれば勝手に登録しない', async () => {
    apiGet.mockResolvedValue(resolved({ joinOpen: false }));

    render(<JoinScreen joinToken={TOKEN} />);

    expect(await screen.findByText('この投票は参加受付を終了しています')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('満員なら勝手に登録しない', async () => {
    apiGet.mockResolvedValue(resolved({ participantCount: 200, maxParticipants: 200 }));

    render(<JoinScreen joinToken={TOKEN} />);

    expect(await screen.findByText('参加人数が上限に達しました')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  /**
   * 会場の電波は途切れる。一度落ちただけで「参加できませんでした」と
   * 突き放すと、その人はもう投票できない。押し直せる口を残す。
   */
  it('登録に失敗したら押し直せる', async () => {
    const user = userEvent.setup();
    const { ApiClientError } = await import('@/lib/client/api-client');

    apiGet.mockResolvedValue(resolved());
    apiPost.mockRejectedValueOnce(
      new ApiClientError({
        code: 'NETWORK_ERROR',
        message: '通信できませんでした',
        status: 0,
        requestId: 'r1',
      }),
    );

    render(<JoinScreen joinToken={TOKEN} />);

    const retry = await screen.findByRole('button', { name: '投票にすすむ' });
    // 名前は最後まで聞かない。
    expect(screen.queryByLabelText('ニックネーム')).toBeNull();

    apiPost.mockResolvedValueOnce({
      roomId: 'room-1',
      participantId: 'p1',
      nickname: '参加者ABC234',
    });
    await user.click(retry);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/play/room-1');
    });
  });

  /**
   * React の Strict モード（next.config.ts で有効）は、開発中に副作用を 2 回走らせる。
   * 読み込みだけなら二度でも困らないが、参加登録は送るたびにレート制限を食う。
   * 1 回しか送らないことをここで固定する。
   */
  it('副作用が二度走っても登録は 1 回だけ', async () => {
    apiGet.mockResolvedValue(resolved());
    apiPost.mockResolvedValue({ roomId: 'room-1', participantId: 'p1', nickname: '参加者ABC234' });

    render(
      <StrictMode>
        <JoinScreen joinToken={TOKEN} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/play/room-1');
    });
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('参加済みなら登録し直さずに投票画面へ戻す', async () => {
    apiGet.mockResolvedValue(resolved({ alreadyJoinedNickname: '参加者ABC234' }));

    render(<JoinScreen joinToken={TOKEN} />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/play/room-1');
    });
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('クイズのルーム', () => {
  it('これまでどおり名前を聞く', async () => {
    apiGet.mockResolvedValue(resolved({ mode: 'quiz', quizTitle: '社内クイズ' }));

    render(<JoinScreen joinToken={TOKEN} />);

    expect(await screen.findByLabelText(/ニックネーム/)).toBeInTheDocument();
    // 名前を入れる前に勝手に登録しない。
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('名前を入れて参加する', async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValue(resolved({ mode: 'quiz', quizTitle: '社内クイズ' }));
    apiPost.mockResolvedValue({ roomId: 'room-1', participantId: 'p1', nickname: 'たろう' });

    render(<JoinScreen joinToken={TOKEN} />);

    await user.type(await screen.findByLabelText(/ニックネーム/), 'たろう');
    await user.click(screen.getByRole('button', { name: '参加する' }));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith(`/api/join/${TOKEN}/register`, { nickname: 'たろう' });
    });
  });
});
