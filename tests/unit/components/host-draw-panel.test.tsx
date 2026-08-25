// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostDrawPanel } from '@/components/admin/host-draw-panel';
import { DEFAULT_DRAW_SETTINGS } from '@/domain/draw/draw-list';
import type { StageDraw } from '@/domain/draw/draw-stage';
import { availableActions, type RoomPhase } from '@/domain/room/state-machine';

/**
 * 司会画面の抽選操作。
 *
 * 会場では引き直しがきかない。取り消し・リセットが確認なしで走ると、
 * 発表済みの当選が消えたまま元に戻せなくなる。ここでその確認を固定する。
 * 文言も催しごとに変える（司会はボタンの言葉をそのまま会場へ言う）。
 */

const onRunAction = vi.fn<(action: string) => void>();
const onToggleHistory = vi.fn<(open: boolean) => void>();

function drawOf(overrides: Partial<StageDraw> = {}): StageDraw {
  const entries = [
    { id: 'e1', position: 1, label: '山田 太郎', image: null },
    { id: 'e2', position: 2, label: '鈴木 花子', image: null },
    { id: 'e3', position: 3, label: '佐藤 次郎', image: null },
  ];
  return {
    title: '社員名簿',
    kind: 'name',
    settings: DEFAULT_DRAW_SETTINGS,
    entries,
    drawn: [],
    latestEntryId: null,
    latestOrder: null,
    remainingCount: entries.length,
    numberRange: null,
    background: null,
    ...overrides,
  };
}

/** 2 件引き終えた状態。直近は「鈴木 花子」。 */
function drawnTwice(overrides: Partial<StageDraw> = {}): StageDraw {
  return drawOf({
    drawn: [
      { order: 1, entryId: 'e1' },
      { order: 2, entryId: 'e2' },
    ],
    latestEntryId: 'e2',
    latestOrder: 2,
    remainingCount: 1,
    ...overrides,
  });
}

function renderPanel(input: {
  mode: 'lottery' | 'bingo';
  phase: RoomPhase;
  draw: StageDraw;
  historyOpen?: boolean;
}) {
  return render(
    <HostDrawPanel
      mode={input.mode}
      phase={input.phase}
      draw={input.draw}
      availableActions={availableActions(input.phase, input.mode)}
      busyAction={null}
      busy={false}
      historyOpen={input.historyOpen ?? false}
      historyBusy={false}
      onRunAction={onRunAction}
      onToggleHistory={onToggleHistory}
    />,
  );
}

beforeEach(() => {
  onToggleHistory.mockReset();
  onRunAction.mockReset();
});

describe('司会画面の抽選操作', () => {
  it('抽選会では直近の当選と当選順位つきの履歴を出す', () => {
    renderPanel({ mode: 'lottery', phase: 'draw_revealed', draw: drawnTwice() });

    expect(screen.getByText('2人目の当選')).toBeInTheDocument();
    // 直近の大きな表示と履歴の両方に出る（司会はどちらを見ても読み上げられる）。
    expect(screen.getAllByText('鈴木 花子').length).toBeGreaterThan(0);
    expect(screen.getByText('1位')).toBeInTheDocument();
    expect(screen.getByText('2位')).toBeInTheDocument();
    // 残り件数と全体件数の両方が要る。あと何人引けるかで進行が変わる。
    expect(screen.getByText('残り 1人 / 全 3人')).toBeInTheDocument();
  });

  it('ビンゴでは「1つ引く」と「N個目」で出す', () => {
    renderPanel({
      mode: 'bingo',
      phase: 'draw_revealed',
      draw: drawnTwice({ kind: 'number' }),
    });

    expect(screen.getByRole('button', { name: '1つ引く' })).toBeInTheDocument();
    expect(screen.getAllByText('2個目').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '出た球をリセット' })).toBeInTheDocument();
  });

  it('引く操作は確認なしで送る', async () => {
    const user = userEvent.setup();
    renderPanel({ mode: 'lottery', phase: 'draw_ready', draw: drawnTwice() });

    await user.click(screen.getByRole('button', { name: '抽選する' }));

    expect(onRunAction).toHaveBeenCalledWith('draw_next');
  });

  it('リセットは確認してから実行する', async () => {
    const user = userEvent.setup();
    renderPanel({ mode: 'lottery', phase: 'draw_revealed', draw: drawnTwice() });

    await user.click(screen.getByRole('button', { name: '当選をリセット' }));

    // 押しただけでは実行しない。何が消えるかを見せてから。
    expect(onRunAction).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('元には戻せません。');
    expect(screen.getByRole('dialog')).toHaveTextContent('2人');

    await user.click(screen.getByRole('button', { name: 'リセットする' }));

    expect(onRunAction).toHaveBeenCalledWith('reset_draws');
  });

  it('取り消しも確認を挟み、消える1件を名前で示す', async () => {
    const user = userEvent.setup();
    renderPanel({ mode: 'lottery', phase: 'draw_revealed', draw: drawnTwice() });

    await user.click(screen.getByRole('button', { name: '直前の当選を取り消す' }));

    expect(onRunAction).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('鈴木 花子');

    await user.click(screen.getByRole('button', { name: '取り消す' }));

    expect(onRunAction).toHaveBeenCalledWith('undo_draw');
  });

  it('やめると何も実行しない', async () => {
    const user = userEvent.setup();
    renderPanel({ mode: 'lottery', phase: 'draw_revealed', draw: drawnTwice() });

    await user.click(screen.getByRole('button', { name: '当選をリセット' }));
    await user.click(screen.getByRole('button', { name: 'やめる' }));

    expect(onRunAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('1件も引いていないときは取り消し・リセットを出さない', () => {
    // サーバーが必ず断る操作なので、押せるボタンとして見せない。
    renderPanel({ mode: 'lottery', phase: 'draw_ready', draw: drawOf() });

    expect(screen.queryByRole('button', { name: '直前の当選を取り消す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '当選をリセット' })).not.toBeInTheDocument();
    // 空欄ではなく、何を押せばここが埋まるかを書く。
    expect(
      screen.getByText('まだ 1 件も引いていません。「抽選する」を押すとここに出ます。'),
    ).toBeInTheDocument();
  });

  it('残りが無くなったら「引く」ではなく終了へ導く', async () => {
    const user = userEvent.setup();
    renderPanel({
      mode: 'lottery',
      phase: 'draw_revealed',
      draw: drawnTwice({
        drawn: [
          { order: 1, entryId: 'e1' },
          { order: 2, entryId: 'e2' },
          { order: 3, entryId: 'e3' },
        ],
        latestEntryId: 'e3',
        latestOrder: 3,
        remainingCount: 0,
      }),
    });

    expect(screen.queryByRole('button', { name: '抽選する' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '抽選会を終了' }));

    // 終了も取り返しがつく操作ではないため、確認を挟む。
    expect(onRunAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '終了する' }));

    expect(onRunAction).toHaveBeenCalledWith('finish_room');
  });

  it('終了後は再開の導線だけを出す', () => {
    renderPanel({
      mode: 'lottery',
      phase: 'finished',
      draw: drawnTwice(),
    });

    expect(screen.getByRole('button', { name: '抽選会を再開' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '抽選する' })).not.toBeInTheDocument();
  });

  it('投影へ一覧を出す／下げるを司会画面から切り替えられる', async () => {
    const user = userEvent.setup();
    /*
      投影担当は別の端末にいることが多い。司会から切り替えられないと
      「一覧を出して」と口で頼むことになり、会場では伝わらない。
    */
    const { rerender } = renderPanel({
      mode: 'lottery',
      phase: 'draw_revealed',
      draw: drawnTwice(),
    });

    await user.click(screen.getByRole('button', { name: '投影に出す' }));
    expect(onToggleHistory).toHaveBeenCalledWith(true);

    rerender(
      <HostDrawPanel
        mode="lottery"
        phase="draw_revealed"
        draw={drawnTwice()}
        availableActions={availableActions('draw_revealed', 'lottery')}
        busyAction={null}
        busy={false}
        historyOpen
        historyBusy={false}
        onRunAction={onRunAction}
        onToggleHistory={onToggleHistory}
      />,
    );

    await user.click(screen.getByRole('button', { name: '投影から下げる' }));
    expect(onToggleHistory).toHaveBeenLastCalledWith(false);
  });
});
