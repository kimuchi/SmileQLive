// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PollImportPanel } from '@/components/admin/poll-import-panel';
import type { BallotImportResult } from '@/domain/poll/ballot-import';

/**
 * 投票用紙の取り込み欄。
 *
 * ここで固めたいのは 3 つ。
 *   1. **取り込む前に必ず下見を出す**。何件入るか、何を飛ばすかを見せる。
 *   2. 押すまでサーバーへも編集中の一覧へも入れない。
 *   3. 入れ替えのときは「いまの内容が消える」ことを先に言う。
 */

const onImport = vi.fn<(result: BallotImportResult, mode: 'replace' | 'append') => void>();

beforeEach(() => {
  onImport.mockClear();
});

function renderPanel(input: { structure?: 'flat' | 'nested'; currentOptionCount?: number } = {}) {
  return render(
    <PollImportPanel
      structure={input.structure ?? 'flat'}
      currentOptionCount={input.currentOptionCount ?? 0}
      onImport={onImport}
    />,
  );
}

describe('下見', () => {
  it('貼るまで取り込めない', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'この内容で取り込む' })).toBeDisabled();
  });

  it('貼ると何件読み込むかを先に見せる', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('貼り付け'), '営業部 ダンス\n開発部 コント');

    expect(screen.getByText('2件を読み込みます')).toBeInTheDocument();
    // どの列をどう読んだかも見せる（取り違えたまま取り込ませない）。
    expect(screen.getByText(/1列目を選択肢として読みました/)).toBeInTheDocument();
    // まだ渡していない。
    expect(onImport).not.toHaveBeenCalled();
  });

  it('飛ばした行を必ず知らせる', async () => {
    const user = userEvent.setup();
    renderPanel({ structure: 'nested' });

    // 2 行目は区分が空。参加者が選べないので取り込まない。
    await user.type(screen.getByLabelText('貼り付け'), '本社,営業部 ダンス\n,宙に浮いた出し物');

    expect(screen.getByText('1件を読み込みます（区分 1件）')).toBeInTheDocument();
    expect(screen.getByText(/区分が空の行 1 件は飛ばしました/)).toBeInTheDocument();
  });

  it('入れ替えのときは、いまの内容が消えると先に言う', async () => {
    const user = userEvent.setup();
    renderPanel({ currentOptionCount: 7 });

    await user.type(screen.getByLabelText('貼り付け'), '営業部 ダンス');

    expect(screen.getByText('いま編集中の7件は消えます。')).toBeInTheDocument();
  });

  it('足すときは消えると言わない', async () => {
    const user = userEvent.setup();
    renderPanel({ currentOptionCount: 7 });

    await user.type(screen.getByLabelText('貼り付け'), '営業部 ダンス');
    await user.click(screen.getByRole('radio', { name: /いまの内容に足す/ }));

    expect(screen.queryByText(/消えます/)).toBeNull();
  });
});

describe('取り込む', () => {
  it('押したときだけ渡す', async () => {
    const user = userEvent.setup();
    renderPanel({ structure: 'nested' });

    await user.type(screen.getByLabelText('貼り付け'), '本社,営業部 ダンス,出演12名');
    await user.click(screen.getByRole('button', { name: 'この内容で取り込む' }));

    expect(onImport).toHaveBeenCalledTimes(1);
    const [result, mode] = onImport.mock.calls[0] as [BallotImportResult, string];
    expect(mode).toBe('replace');
    expect(result.groups).toEqual(['本社']);
    expect(result.options).toEqual([
      { label: '営業部 ダンス', note: '出演12名', groupLabel: '本社' },
    ]);
  });

  it('取り込み方を選んで渡す', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('貼り付け'), '営業部 ダンス');
    await user.click(screen.getByRole('radio', { name: /いまの内容に足す/ }));
    await user.click(screen.getByRole('button', { name: 'この内容で取り込む' }));

    expect(onImport.mock.calls[0]?.[1]).toBe('append');
  });

  it('1行目の扱いを変えると読み直す', async () => {
    const user = userEvent.setup();
    renderPanel();

    // 見出しに見えない 1 行目も、指定すれば飛ばす。
    await user.type(screen.getByLabelText('貼り付け'), '出し物一覧\n営業部 ダンス');
    expect(screen.getByText('2件を読み込みます')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /1行目は見出しとして飛ばす/ }));
    expect(screen.getByText('1件を読み込みます')).toBeInTheDocument();
  });
});
