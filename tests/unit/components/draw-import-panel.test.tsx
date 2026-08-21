// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DrawImportPanel } from '@/components/admin/draw-import-panel';
import { DRAW_ENTRY_MAX_COUNT } from '@/domain/draw/draw-list';

/**
 * 貼り付けの下見。
 *
 * GAS 版のスプレッドシートは「参加者」「当選」の 2 列で、当日はその範囲を
 * まるごとコピーして貼る。取り込んだあとに「何件入ったか」を知らせるのでは、
 * 当選者が抜けていることに気づくのが遅い。
 * **送る前に**同じ解釈を見せることを、ここで固定する。
 */

const LIST_ID = '11111111-1111-4111-8111-111111111111';

function renderPanel(currentCount = 0) {
  return render(
    <DrawImportPanel listId={LIST_ID} currentCount={currentCount} onImported={() => {}} />,
  );
}

function paste(text: string): void {
  fireEvent.change(screen.getByLabelText('貼り付ける内容'), { target: { value: text } });
}

/** 下見の項目を、見出し（dt）の隣の値（dd）から読む。 */
function previewValue(term: string): string {
  return screen.getByText(term).nextElementSibling?.textContent ?? '';
}

describe('抽選リストの貼り付け取り込み', () => {
  it('スプレッドシートの2列をそのまま貼ると、件数と使う列を取り込む前に出す', () => {
    renderPanel();
    paste('参加者\t当選\n山田 太郎\t1\n鈴木 花子\t\n佐藤 次郎\t\n');

    expect(previewValue('取り込む行数')).toBe('3件');
    // 「当選」列ではなく「参加者」列を読んでいることが、貼った時点で見えている。
    expect(previewValue('名前にする列')).toBe('1列目（参加者）');
    expect(previewValue('区切り')).toBe('タブ区切り（表計算ソフトからの貼り付け）');
    expect(screen.getByText('山田 太郎')).toBeInTheDocument();
  });

  it('1行目を中身として読むと、見出しの行も1件として数える', () => {
    renderPanel();
    paste('参加者\t当選\n山田 太郎\t1\n鈴木 花子\t\n佐藤 次郎\t\n');
    expect(previewValue('取り込む行数')).toBe('3件');

    fireEvent.click(screen.getByRole('radio', { name: /1行目も中身として読む/ }));

    expect(previewValue('取り込む行数')).toBe('4件');
    expect(screen.getByText('参加者')).toBeInTheDocument();
  });

  it('列を選び直すと、その列の文字を名前として読む', () => {
    renderPanel();
    paste('氏名\t部署\n山田 太郎\t営業部\n');
    expect(previewValue('名前にする列')).toBe('1列目（氏名）');

    fireEvent.change(screen.getByLabelText('名前として読む列'), { target: { value: '1' } });

    expect(previewValue('名前にする列')).toBe('2列目（部署）');
    expect(screen.getByText('営業部')).toBeInTheDocument();
  });

  it('空の行を飛ばすことを、取り込む前に知らせる', () => {
    renderPanel();
    paste('山田 太郎\n\n鈴木 花子\n');

    expect(previewValue('取り込む行数')).toBe('2件');
    expect(screen.getByText('空の行 1 件は飛ばします')).toBeInTheDocument();
  });

  it('今の行に足すと上限を超えるときは、黙って切らずに取り込ませない', () => {
    renderPanel(DRAW_ENTRY_MAX_COUNT);
    paste('山田 太郎\n');

    fireEvent.click(screen.getByRole('radio', { name: /今の行に足す/ }));

    expect(screen.getByText(/1件が入りません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /この内容で取り込む/ })).toBeDisabled();
  });
});
