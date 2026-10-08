// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollVotePanel } from '@/components/participant/PollVotePanel';
import type { PollStage } from '@/domain/poll/poll-stage';

/**
 * 参加者の投票画面。
 *
 * ここで固めたいのは 4 つ。
 *   1. **1 台につき 1 票**。送ったあとは選び直せない画面になる。
 *   2. 選べるのは用紙で決めた順位の数まで。押した順が順位になる。
 *   3. 送る前に「何を選んだか」を必ず見せる（送ると取り消せないため）。
 *   4. 受付中は票数も順位も出さない。
 */

const onVoted = vi.fn();

function pollOf(overrides: Partial<PollStage> = {}): PollStage {
  return {
    title: '出し物コンテスト',
    structure: 'flat',
    groups: [],
    options: [
      { id: 'a', position: 1, label: '営業部 ダンス', groupId: null, note: '出演12名' },
      { id: 'b', position: 2, label: '開発部 コント', groupId: null, note: null },
      { id: 'c', position: 3, label: '総務部 合唱', groupId: null, note: null },
    ],
    settings: {
      rankDepth: 1,
      points: [1],
      revealDepth: 3,
      resultFontSize: 160,
      backgroundAssetId: null,
    },
    voteCount: 12,
    participantCount: 30,
    background: null,
    ...overrides,
  };
}

function renderPanel(input: { poll?: PollStage; myVote?: string[] | null } = {}) {
  return render(
    <PollVotePanel
      roomId="room-1"
      phase="poll_open"
      poll={input.poll ?? pollOf()}
      myVote={input.myVote ?? null}
      result={null}
      onVoted={onVoted}
    />,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  onVoted.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ accepted: true, choices: ['a'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('1位だけを選ぶ投票', () => {
  it('選ぶまで送れない', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '選んでから投票できます' })).toBeDisabled();
  });

  it('押すたびに選び直しになる', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /営業部 ダンス/ }));
    expect(screen.getByRole('button', { name: /営業部 ダンス/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /開発部 コント/ }));
    // 1 位だけの会では 2 つ選べない。前の選択は外れる。
    expect(screen.getByRole('button', { name: /営業部 ダンス/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: /開発部 コント/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('選んだ内容を送る', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /営業部 ダンス/ }));
    await user.click(screen.getByRole('button', { name: 'この内容で投票する' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rooms/room-1/vote');
    expect(JSON.parse(String(init.body))).toEqual({ choices: ['a'] });
  });

  it('送ったあとは選び直せない', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /営業部 ダンス/ }));
    await user.click(screen.getByRole('button', { name: 'この内容で投票する' }));

    // 選択肢そのものが画面から消え、入れた票だけが残る。
    await screen.findByText('投票を受け付けました');
    expect(screen.queryByRole('button', { name: /開発部 コント/ })).toBeNull();
    expect(screen.getByText('あなたが入れた票')).toBeInTheDocument();
    expect(onVoted).toHaveBeenCalled();
  });
});

describe('3位まで選ぶ投票', () => {
  const ranked = pollOf({
    settings: {
      rankDepth: 3,
      points: [5, 3, 1],
      revealDepth: 3,
      resultFontSize: 160,
      backgroundAssetId: null,
    },
  });

  it('押した順が順位になる', async () => {
    const user = userEvent.setup();
    renderPanel({ poll: ranked });

    await user.click(screen.getByRole('button', { name: /総務部 合唱/ }));
    await user.click(screen.getByRole('button', { name: /営業部 ダンス/ }));

    await user.click(screen.getByRole('button', { name: '2件で投票する' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // 先に押した「総務部 合唱」が 1 位。
    expect(JSON.parse(String(init.body))).toEqual({ choices: ['c', 'a'] });
  });

  it('決めた数より多くは選べない', async () => {
    const user = userEvent.setup();
    const twoOptions = pollOf({
      options: [
        { id: 'a', position: 1, label: '営業部 ダンス', groupId: null, note: null },
        { id: 'b', position: 2, label: '開発部 コント', groupId: null, note: null },
        { id: 'c', position: 3, label: '総務部 合唱', groupId: null, note: null },
      ],
      settings: {
        rankDepth: 2,
        points: [2, 1],
        revealDepth: 3,
        resultFontSize: 160,
        backgroundAssetId: null,
      },
    });
    renderPanel({ poll: twoOptions });

    await user.click(screen.getByRole('button', { name: /営業部 ダンス/ }));
    await user.click(screen.getByRole('button', { name: /開発部 コント/ }));

    // 上限まで選んだら、残りは押せなくする（押しても何も起きないと壊れて見える）。
    expect(screen.getByRole('button', { name: /総務部 合唱/ })).toBeDisabled();
  });
});

describe('もう投票している端末', () => {
  it('選択肢を出さず、入れた票だけを見せる', () => {
    renderPanel({ myVote: ['b'] });

    expect(screen.getByText('投票を受け付けました')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /営業部 ダンス/ })).toBeNull();
    expect(screen.getByText('開発部 コント')).toBeInTheDocument();
  });
});

describe('途中経過を出さない', () => {
  it('受付中に票数を出さない', () => {
    // 途中経過が見えると、あとの人の投票が引っぱられる。
    const { container } = renderPanel({ poll: pollOf({ voteCount: 777 }) });
    expect(container.textContent).not.toContain('777');
  });
});
