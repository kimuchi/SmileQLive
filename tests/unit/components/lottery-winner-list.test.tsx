// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LotteryStage } from '@/components/presentation/LotteryStage';
import { DEFAULT_DRAW_SETTINGS, type DrawLayout } from '@/domain/draw/draw-list';
import type { StageDraw } from '@/domain/draw/draw-stage';

/**
 * 抽選会の右側の当選者一覧。
 *
 * 会場から「さっき誰が当たったか」を追えるように、既定で出す。
 * 入りきらなくなったら**新しいものから**入るだけ出す。
 * 小さくして詰め込むと、会場の後方からどれも読めなくなる。
 */

function drawOf(count: number, layout: DrawLayout = 'board'): StageDraw {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    id: `p${index}`,
    position: index + 1,
    label: `当選者${index + 1}`,
    image: null,
  }));
  const drawn = entries.slice(0, count).map((entry, index) => ({
    order: index + 1,
    entryId: entry.id,
  }));
  return {
    title: '抽選会',
    kind: 'name',
    settings: { ...DEFAULT_DRAW_SETTINGS, layout },
    entries,
    drawn,
    latestEntryId: drawn[drawn.length - 1]?.entryId ?? null,
    latestOrder: drawn.length === 0 ? null : drawn.length,
    remainingCount: entries.length - drawn.length,
    numberRange: null,
    background: null,
  };
}

function renderStage(draw: StageDraw) {
  return render(<LotteryStage draw={draw} display={null} spinning={false} revealed={false} />);
}

describe('抽選会の当選者一覧', () => {
  it('既定（大きい表示と一覧）で右側に出る', () => {
    renderStage(drawOf(3));

    expect(screen.getByRole('heading', { name: '当選者' })).toBeInTheDocument();
    expect(screen.getByText('当選者3')).toBeInTheDocument();
    expect(screen.getByText('当選者1')).toBeInTheDocument();
  });

  it('まだ引いていなければ、そう書く', () => {
    renderStage(drawOf(0));
    expect(screen.getByText('まだ抽選していません')).toBeInTheDocument();
  });

  it('あふれたら新しいものだけを出し、隠れた件数を知らせる', () => {
    renderStage(drawOf(40));

    // いちばん新しい当選は必ず出る。
    expect(screen.getByText('当選者40')).toBeInTheDocument();
    // いちばん古い当選は押し出されている。
    expect(screen.queryByText('当選者1')).not.toBeInTheDocument();
    // 黙って落とさない。何人ぶん隠れているかを出す。
    expect(screen.getByText(/ほか \d+人/)).toBeInTheDocument();
  });

  it('入りきるうちは全部出し、「ほか」は出さない', () => {
    renderStage(drawOf(3));
    expect(screen.queryByText(/ほか/)).not.toBeInTheDocument();
  });

  it('「いま出たものを大きく」では一覧を出さない', () => {
    renderStage(drawOf(3, 'result'));
    expect(screen.queryByRole('heading', { name: '当選者' })).not.toBeInTheDocument();
  });
});
