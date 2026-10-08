// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouletteSettingsPanel } from '@/components/roulette/roulette-settings-panel';
import {
  ROULETTE_SPEED_DEFAULT,
  ROULETTE_STOP_SECONDS_DEFAULT,
  ROULETTE_WEIGHT_MAX,
  type RouletteConfig,
} from '@/domain/roulette/wheel';

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
    spinSpeed: ROULETTE_SPEED_DEFAULT,
    stopSeconds: ROULETTE_STOP_SECONDS_DEFAULT,
    backgroundUrl: null,
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
  /**
   * 速さと止まるまでの時間は**別々のつまみ**。
   * 片方を動かしてももう片方が変わらないことを固定する
   * （前は「減速」ひとつしか無く、速さを変えられなかった）。
   */
  it('速さを変えても止まるまでの時間は変わらない', () => {
    renderPanel();

    const speed = screen.getByLabelText('回る速さ');
    fireEvent.change(speed, { target: { value: '1440' } });

    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next?.spinSpeed).toBe(1440);
    expect(next?.stopSeconds).toBe(ROULETTE_STOP_SECONDS_DEFAULT);
  });

  it('止まるまでの時間を変えても速さは変わらない', () => {
    renderPanel();

    fireEvent.change(screen.getByLabelText('止まるまでの時間'), { target: { value: '9' } });

    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next?.stopSeconds).toBe(9);
    expect(next?.spinSpeed).toBe(ROULETTE_SPEED_DEFAULT);
  });

  it('いまの速さを 1 秒あたりの周回数で見せる', () => {
    renderPanel({ config: { ...configOf(), spinSpeed: 720 } });
    // 「720 度/秒」だけでは会場で速さの見当が付かない。
    expect(screen.getByText(/1 秒に/)).toHaveTextContent('2.0');
  });

  it('扇の文字を消せる', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByLabelText('扇の中に項目名を出す'));

    expect(onChange.mock.calls.at(-1)?.[0].showLabels).toBe(false);
  });
});

describe('背景画像', () => {
  it('画像の URL を入れると盤面へ入る', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('画像の URL'), 'https://example.com/bg.jpg');
    await user.click(screen.getByRole('button', { name: 'この URL を使う' }));

    expect(onChange.mock.calls.at(-1)?.[0].backgroundUrl).toBe('https://example.com/bg.jpg');
  });

  /**
   * 背景の URL は人から人へ渡る。`javascript:` を受け取ると、
   * URL を送るだけで相手の画面で好きなことができてしまう。
   */
  it('画像として敷けない URL は断る', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText('画像の URL'), 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'この URL を使う' }));

    expect(screen.getByText(/http:\/\/ または https:\/\/ で始まる/)).toBeInTheDocument();
    // 盤面へは入れない。
    expect(onChange).not.toHaveBeenCalled();
  });

  it('背景を外せる', async () => {
    const user = userEvent.setup();
    renderPanel({ config: { ...configOf(), backgroundUrl: 'https://example.com/bg.jpg' } });

    await user.click(screen.getByRole('button', { name: '背景を外す' }));

    expect(onChange.mock.calls.at(-1)?.[0].backgroundUrl).toBeNull();
  });

  it('手元のファイルはこの端末だけだと知らせる', () => {
    renderPanel({ config: { ...configOf(), backgroundUrl: 'blob:http://localhost/abc' } });
    expect(screen.getByText(/この端末だけ/)).toBeInTheDocument();
  });
});

describe('URL の書き出し', () => {
  it('いまの盤面を配布サイトと同じ形で書き出す', () => {
    renderPanel();

    const url = screen.getByLabelText('この盤面のURL') as HTMLTextAreaElement;
    const json = new URL(url.value).searchParams.get('json') ?? '';

    expect(JSON.parse(json)).toMatchObject({
      name: ['山田', '田中'],
      ratio: [1, 3],
      show_characters_value: true,
      speed_value: ROULETTE_SPEED_DEFAULT,
      stop_seconds: ROULETTE_STOP_SECONDS_DEFAULT,
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
