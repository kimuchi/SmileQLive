// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouletteSettingsPanel } from '@/components/roulette/roulette-settings-panel';
import { ROULETTE_WEIGHT_MAX, type RouletteConfig } from '@/domain/roulette/wheel';

/**
 * ルーレットの設定欄。
 *
 * 通しの動きは tests/e2e/roulette.spec.ts が実際のブラウザで見ている。
 * ここでは、そこでは見づらい細かい約束を固める。
 *   1. 入っていい範囲を外れた重みは、その場で丸める。
 *   2. 回している間は触らせない。
 *   3. 設定を変えたら、書き出す URL もその場で変わる。
 */

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const onChange = vi.fn<(next: RouletteConfig) => void>();
const onClose = vi.fn();

function configOf(): RouletteConfig {
  return {
    items: [
      { id: 'a', label: '山田', weight: 1 },
      { id: 'b', label: '田中', weight: 3 },
    ],
    showLabels: true,
    decel: 0.008,
  };
}

/**
 * 本物と同じく、変更を受けて描き直す入れ物。
 *
 * onChange を作り物のままにすると欄の値が変わらず、
 * 「1 文字打つたびに同じ古い値へ書き戻す」というテストだけの動きになる
 * （実際、上限の丸めがそれで見えなくなった）。
 */
function Harness({ initial, disabled }: { initial: RouletteConfig; disabled: boolean }) {
  const [config, setConfig] = useState(initial);
  return (
    <RouletteSettingsPanel
      config={config}
      onChange={(next) => {
        onChange(next);
        setConfig(next);
      }}
      disabled={disabled}
      onClose={onClose}
    />
  );
}

function renderPanel(input: { config?: RouletteConfig; disabled?: boolean } = {}) {
  return render(
    <Harness initial={input.config ?? configOf()} disabled={input.disabled ?? false} />,
  );
}

beforeEach(() => {
  onChange.mockClear();
  onClose.mockClear();
});

describe('項目', () => {
  it('重みは入っていい範囲へ丸める', async () => {
    const user = userEvent.setup();
    renderPanel();

    // 上限を超える値。扇の割り付けが壊れるので、その場で頭打ちにする。
    await user.clear(screen.getByLabelText('1番目の重み'));
    await user.type(screen.getByLabelText('1番目の重み'), '99999');

    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last?.items[0]?.weight).toBe(ROULETTE_WEIGHT_MAX);
  });

  it('0 や空は 1 として扱う（扇が消えないようにする）', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.clear(screen.getByLabelText('1番目の重み'));

    expect(onChange.mock.calls.at(-1)?.[0].items[0]?.weight).toBe(1);
  });

  it('打っている途中の空白を落とさない', async () => {
    // 前後の空白をその場で落とすと、「山田 太郎」の空白が打った端から消えて
    // 先へ進めなくなる。整えるのは盤面へ出すときと URL へ書き出すとき。
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('1番目の項目名'), ' 太郎');

    expect(onChange.mock.calls.at(-1)?.[0].items[0]?.label).toBe('山田 太郎');
  });

  it('削除できる', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByLabelText('1番目を削除'));

    expect(onChange.mock.calls.at(-1)?.[0].items.map((item) => item.label)).toEqual(['田中']);
  });
});

describe('回している間', () => {
  it('項目を触らせない', () => {
    renderPanel({ disabled: true });

    expect(screen.getByLabelText('1番目の項目名')).toBeDisabled();
    expect(screen.getByLabelText('1番目の重み')).toBeDisabled();
    expect(screen.getByRole('button', { name: '項目を追加' })).toBeDisabled();
    expect(
      screen.getByText('回っている間は変えられません。止まるまでお待ちください。'),
    ).toBeInTheDocument();
  });
});

describe('回り方', () => {
  it('止まるまでの目安を出す', () => {
    renderPanel();
    // 会場で「長すぎる／短すぎる」をその場で直せるように、秒数を見せる。
    expect(screen.getByText(/秒で止まります/)).toBeInTheDocument();
  });

  it('減速を強くすると目安が短くなる', () => {
    const { unmount } = renderPanel();
    const slow = screen.getByText(/秒で止まります/).textContent ?? '';
    unmount();

    renderPanel({ config: { ...configOf(), decel: 0.08 } });
    const fast = screen.getByText(/秒で止まります/).textContent ?? '';

    const seconds = (text: string) => Number(/([\d.]+)\s*秒/.exec(text)?.[1] ?? '0');
    expect(seconds(fast)).toBeLessThan(seconds(slow));
  });

  it('扇の文字を消せる', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByLabelText('扇の中に項目名を出す'));

    expect(onChange.mock.calls.at(-1)?.[0].showLabels).toBe(false);
  });
});

describe('URL の書き出し', () => {
  it('いまの盤面を配布サイトと同じ形で書き出す', () => {
    renderPanel();

    const url = screen.getByLabelText('この盤面のURL') as HTMLTextAreaElement;
    const json = new URL(url.value).searchParams.get('json') ?? '';

    expect(JSON.parse(json)).toEqual({
      name: ['山田', '田中'],
      ratio: [1, 3],
      show_characters_value: true,
      decel_value: 0.008,
    });
  });

  it('名前が空の項目は URL に載せない', () => {
    renderPanel({
      config: {
        ...configOf(),
        items: [
          { id: 'a', label: '山田', weight: 1 },
          { id: 'b', label: '   ', weight: 1 },
        ],
      },
    });

    const url = screen.getByLabelText('この盤面のURL') as HTMLTextAreaElement;
    const json = new URL(url.value).searchParams.get('json') ?? '';
    expect(JSON.parse(json)).toMatchObject({ name: ['山田'], ratio: [1] });
  });
});
