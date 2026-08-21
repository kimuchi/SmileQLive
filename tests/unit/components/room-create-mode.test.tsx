// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomCreatePanel } from '@/components/admin/room-create-panel';
import type { DrawListsResponse, QuizListItem } from '@/types/api';

/**
 * ルーム作成のモード選び。
 *
 * 抽選会で数字の球を引いても、ビンゴで名簿を引いても催しとして成立しない。
 * 「選べてしまったが当日は動かない」は会場では取り返しがつかないため、
 * モードごとに選べる抽選リストと、参加者向けの入力欄の出し分けをここで固定する。
 */

const apiGet = vi.fn<(path: string) => Promise<unknown>>();
const apiPost = vi.fn<(path: string, body: unknown) => Promise<unknown>>();

vi.mock('@/lib/client/api-client', () => ({
  apiGet: (path: string) => apiGet(path),
  apiPost: (path: string, body: unknown) => apiPost(path, body),
  isApiClientError: () => false,
}));

const QUIZZES: QuizListItem[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: '社内クイズ',
    description: null,
    status: 'published',
    questionCount: 5,
    choiceQuestionCount: 5,
    numberQuestionCount: 0,
    showLeaderboard: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    owned: true,
  },
];

const DRAW_LISTS: DrawListsResponse['lists'] = [
  {
    id: 'list-name',
    title: '社員名簿',
    kind: 'name',
    entryCount: 120,
    numberMin: null,
    numberMax: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'list-number',
    title: 'ビンゴの球',
    kind: 'number',
    entryCount: 75,
    numberMin: 1,
    numberMax: 75,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'list-item',
    title: '景品',
    kind: 'item',
    entryCount: 10,
    numberMin: null,
    numberMax: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function mockLists(lists: DrawListsResponse['lists']): void {
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/admin/quizzes') {
      return Promise.resolve({ quizzes: QUIZZES });
    }
    if (path === '/api/admin/draw-lists') {
      return Promise.resolve({ lists });
    }
    return Promise.reject(new Error(`想定していない取得: ${path}`));
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  mockLists(DRAW_LISTS);
});

describe('ルーム作成のモード選び', () => {
  it('抽選会に切り替えると参加人数の上限を出さない', async () => {
    const user = userEvent.setup();
    render(<RoomCreatePanel initialQuizId={null} initialMode="quiz" />);

    expect(await screen.findByLabelText(/参加人数の上限/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /抽選会/ }));

    // 参加者のスマートフォンを使わないモードなので、人数の入力欄そのものを出さない。
    expect(await screen.findByLabelText(/使用する抽選リスト/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/参加人数の上限/)).not.toBeInTheDocument();
  });

  it('抽選会では数字のリストを理由つきで選べなくする', async () => {
    render(<RoomCreatePanel initialQuizId={null} initialMode="lottery" />);

    const select = await screen.findByLabelText(/使用する抽選リスト/);
    const numberOption = within(select).getByRole('option', { name: /ビンゴの球/ });

    expect(numberOption).toBeDisabled();
    expect(numberOption).toHaveTextContent('抽選会では使えません');
    expect(within(select).getByRole('option', { name: /社員名簿/ })).toBeEnabled();
    expect(within(select).getByRole('option', { name: /景品/ })).toBeEnabled();
  });

  it('ビンゴでは名簿を理由つきで選べなくする', async () => {
    render(<RoomCreatePanel initialQuizId={null} initialMode="bingo" />);

    const select = await screen.findByLabelText(/使用する抽選リスト/);
    const nameOption = within(select).getByRole('option', { name: /社員名簿/ });

    expect(nameOption).toBeDisabled();
    expect(nameOption).toHaveTextContent('ビンゴでは使えません');
    expect(within(select).getByRole('option', { name: /ビンゴの球/ })).toBeEnabled();
    expect(within(select).getByRole('option', { name: /景品/ })).toBeEnabled();
  });

  it('使える抽選リストが 1 つも無いときは作る導線を出す', async () => {
    // 名簿しか無い状態でビンゴを選ぶと、リストはあるのに 1 つも使えない。
    mockLists([DRAW_LISTS[0]!]);
    render(<RoomCreatePanel initialQuizId={null} initialMode="bingo" />);

    const link = await screen.findByRole('link', { name: '抽選リストを作る' });
    expect(link).toHaveAttribute('href', '/admin/draw-lists/new');
    expect(screen.queryByLabelText(/使用する抽選リスト/)).not.toBeInTheDocument();
  });

  it('抽選会のルーム作成では抽選リストだけを送り、参加URLを出さない', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      roomId: 'room-1',
      mode: 'lottery',
      joinUrl: null,
      joinToken: null,
      quizTitle: '社員名簿',
    });
    render(<RoomCreatePanel initialQuizId={null} initialMode="lottery" />);

    await user.selectOptions(await screen.findByLabelText(/使用する抽選リスト/), 'list-name');
    await user.click(screen.getByRole('button', { name: 'ルームを作成する' }));

    expect(apiPost).toHaveBeenCalledWith('/api/rooms', {
      mode: 'lottery',
      drawListId: 'list-name',
    });

    // 参加者が来ないモードでは、二次元コードの代わりに司会・投影への導線を出す。
    expect(await screen.findByRole('link', { name: '投影画面を開く' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '司会画面を開く' })).toBeInTheDocument();
    expect(screen.queryByText('参加URL')).not.toBeInTheDocument();
  });

  it('クイズのルーム作成では今までどおりクイズと人数を送る', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({
      roomId: 'room-2',
      mode: 'quiz',
      joinUrl: 'https://example.test/j/token',
      joinToken: 'token',
      quizTitle: '社内クイズ',
    });
    render(<RoomCreatePanel initialQuizId={QUIZZES[0]!.id} initialMode="quiz" />);

    await user.click(await screen.findByRole('button', { name: 'ルームを作成する' }));

    expect(apiPost).toHaveBeenCalledWith('/api/rooms', {
      mode: 'quiz',
      quizId: QUIZZES[0]!.id,
      maxParticipants: 500,
    });
  });
});
