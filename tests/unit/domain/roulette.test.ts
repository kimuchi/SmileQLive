import { describe, expect, it } from 'vitest';
import { parseRouletteText, describeRouletteImport } from '@/domain/roulette/roulette-import';
import {
  buildRouletteUrl,
  parseRouletteJson,
  toRouletteJson,
  ROULETTE_JSON_MAX_LENGTH,
} from '@/domain/roulette/roulette-url';
import { estimatedSpinSeconds, planSpin, rotationAt, MIN_TURNS } from '@/domain/roulette/spin';
import {
  blankRouletteConfig,
  isSpinnable,
  itemAtPointer,
  rouletteSegments,
  ROULETTE_DECEL_DEFAULT,
  ROULETTE_ITEM_MAX_COUNT,
  type RouletteConfig,
  type RouletteItem,
} from '@/domain/roulette/wheel';

/**
 * ひとりで回すルーレット（`/roulette`）の中身。
 *
 * ここで固めたいのは 4 つ。
 *   1. 配布サイトの URL をそのまま開けること（会場で「去年の URL」が出てくる）。
 *   2. 書き出した URL を読み直すと同じ盤面に戻ること。
 *   3. **止まる位置が扇の広さどおりの確率になること。** ここが崩れると、
 *      重みを付けた意味が無くなる。
 *   4. 貼り付け・CSV で黙って行を落とさないこと。
 */

/** テストの中では id を数えるだけにする（乱数だと比較できない）。 */
function makeIdFactory(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `item-${String(count)}`;
  };
}

function configOf(items: Array<[string, number]>): RouletteConfig {
  const makeId = makeIdFactory();
  return {
    items: items.map(([label, weight]) => ({ id: makeId(), label, weight })),
    showLabels: true,
    decel: ROULETTE_DECEL_DEFAULT,
  };
}

describe('URL から盤面を読む', () => {
  it('配布サイトと同じ形をそのまま読む', () => {
    const raw = JSON.stringify({
      name: ['仲宗根愛里', '村上絢子', '尹英勝'],
      ratio: [1, 1, 2],
      show_characters_value: true,
      decel_value: 0.008,
    });

    const result = parseRouletteJson(raw, makeIdFactory());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.items.map((item) => item.label)).toEqual([
      '仲宗根愛里',
      '村上絢子',
      '尹英勝',
    ]);
    expect(result.config.items.map((item) => item.weight)).toEqual([1, 1, 2]);
    expect(result.config.showLabels).toBe(true);
    expect(result.config.decel).toBe(0.008);
  });

  it('重みが足りない行は 1 として読む', () => {
    // 手で書き足した URL では name と ratio の数が合わないことがある。
    const raw = JSON.stringify({ name: ['あ', 'い', 'う'], ratio: [5] });
    const result = parseRouletteJson(raw, makeIdFactory());
    expect(result.ok && result.config.items.map((item) => item.weight)).toEqual([5, 1, 1]);
  });

  it('名前が空の行は扇にしない', () => {
    const raw = JSON.stringify({ name: ['あ', '  ', 'い'], ratio: [1, 1, 1] });
    const result = parseRouletteJson(raw, makeIdFactory());
    expect(result.ok && result.config.items.map((item) => item.label)).toEqual(['あ', 'い']);
  });

  it('壊れていても例外にせず「読めなかった」を返す', () => {
    // 会場で URL が壊れていたら、白い画面ではなく編集欄を出したい。
    for (const raw of ['{', '[]', '{"name":"あ"}', '{"name":[]}', 'null']) {
      expect(parseRouletteJson(raw, makeIdFactory())).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(parseRouletteJson('', makeIdFactory())).toEqual({ ok: false, reason: 'empty' });
    expect(parseRouletteJson(null, makeIdFactory())).toEqual({ ok: false, reason: 'empty' });
  });

  it('長すぎる URL は解かずに諦める', () => {
    const raw = `{"name":["${'あ'.repeat(ROULETTE_JSON_MAX_LENGTH)}"]}`;
    expect(parseRouletteJson(raw, makeIdFactory()).ok).toBe(false);
  });

  it('上限を超えた項目は取り込まず、何件落としたかを返す', () => {
    const raw = JSON.stringify({
      name: Array.from(
        { length: ROULETTE_ITEM_MAX_COUNT + 5 },
        (_, index) => `項目${String(index)}`,
      ),
    });
    const result = parseRouletteJson(raw, makeIdFactory());
    expect(result.ok && result.config.items).toHaveLength(ROULETTE_ITEM_MAX_COUNT);
    expect(result.ok && result.truncated).toBe(5);
  });
});

describe('盤面を URL にする', () => {
  it('読み直すと同じ盤面に戻る', () => {
    const config = configOf([
      ['山田', 1],
      ['田中', 3],
    ]);
    config.showLabels = false;
    config.decel = 0.02;

    const back = parseRouletteJson(toRouletteJson(config), makeIdFactory());
    expect(back.ok).toBe(true);
    if (!back.ok) {
      return;
    }
    expect(back.config.items.map((item) => [item.label, item.weight])).toEqual([
      ['山田', 1],
      ['田中', 3],
    ]);
    expect(back.config.showLabels).toBe(false);
    expect(back.config.decel).toBe(0.02);
  });

  it('名前が空の項目は URL に載せない', () => {
    const config = configOf([
      ['山田', 1],
      ['', 1],
    ]);
    expect(JSON.parse(toRouletteJson(config))).toMatchObject({ name: ['山田'], ratio: [1] });
  });

  it('渡された origin で組み立てる', () => {
    // 会場では社内の名前で開いていることがある。設定した正式ドメインを返すと、
    // その場で開けない URL を配ってしまう。
    const url = buildRouletteUrl('http://192.168.1.10:3000', configOf([['あ', 1]]));
    expect(url.startsWith('http://192.168.1.10:3000/roulette?json=')).toBe(true);
    expect(new URL(url).searchParams.get('json')).toBe(
      '{"name":["あ"],"ratio":[1],"show_characters_value":true,"decel_value":0.008}',
    );
  });
});

describe('扇の割り付け', () => {
  it('重みの比で 360 度を分ける', () => {
    const segments = rouletteSegments(
      configOf([
        ['あ', 1],
        ['い', 3],
      ]).items,
    );
    expect(segments.map((segment) => segment.sweep)).toEqual([90, 270]);
    expect(segments[0]?.centerAngle).toBe(45);
    expect(segments[1]?.endAngle).toBe(360);
  });

  it('扇が 2 つ無ければ回せない', () => {
    expect(isSpinnable(configOf([['あ', 1]]))).toBe(false);
    expect(
      isSpinnable(
        configOf([
          ['あ', 1],
          ['', 1],
        ]),
      ),
    ).toBe(false);
    expect(
      isSpinnable(
        configOf([
          ['あ', 1],
          ['い', 1],
        ]),
      ),
    ).toBe(true);
  });

  it('空の盤面から作り始められる', () => {
    const blank = blankRouletteConfig(makeIdFactory());
    expect(blank.items.length).toBeGreaterThan(1);
    expect(blank.items.every((item) => item.label === '')).toBe(true);
    expect(isSpinnable(blank)).toBe(false);
  });
});

describe('針の下にあるもの', () => {
  const items = configOf([
    ['あ', 1],
    ['い', 1],
    ['う', 1],
    ['え', 1],
  ]).items;

  it('回していないときは最初の扇', () => {
    expect(itemAtPointer(items, 0)?.label).toBe('あ');
  });

  it('円盤を回すと、盤面は針に対して逆へ動く', () => {
    // 90 度回すと、真上には 1 つ前（最後）の扇が来る。
    expect(itemAtPointer(items, 90)?.label).toBe('え');
    expect(itemAtPointer(items, 180)?.label).toBe('う');
    // 何周しても、余りの角度だけで決まる。
    expect(itemAtPointer(items, 360 * 5 + 180)?.label).toBe('う');
    expect(itemAtPointer(items, -90)?.label).toBe('い');
  });

  it('扇が無ければ null', () => {
    expect(itemAtPointer([], 0)).toBeNull();
  });
});

describe('回り方', () => {
  it('最低でも決めた周回数は回る', () => {
    const plan = planSpin({ startRotation: 0, decel: 0.008, random: () => 0 });
    expect(plan.distance).toBeGreaterThanOrEqual(MIN_TURNS * 360);
    expect(plan.distance).toBeLessThan((MIN_TURNS + 1) * 360);
  });

  it('止まったところで速度がちょうど 0 になる', () => {
    const plan = planSpin({ startRotation: 12, decel: 0.008, random: () => 0.42 });
    // 等減速。止まる時刻の直前と直後で角度が動かない。
    expect(rotationAt(plan, plan.durationMs)).toBeCloseTo(plan.endRotation, 6);
    expect(rotationAt(plan, plan.durationMs + 5000)).toBe(plan.endRotation);
    // 途中は必ず手前にある（行き過ぎて戻らない）。
    expect(rotationAt(plan, plan.durationMs / 2)).toBeLessThan(plan.endRotation);
    expect(rotationAt(plan, 0)).toBe(plan.startRotation);
  });

  it('減速を強くすると早く止まる', () => {
    const slow = planSpin({ startRotation: 0, decel: 0.004, random: () => 0.5 });
    const fast = planSpin({ startRotation: 0, decel: 0.032, random: () => 0.5 });
    expect(fast.durationMs).toBeLessThan(slow.durationMs);
    expect(estimatedSpinSeconds(0.032)).toBeLessThan(estimatedSpinSeconds(0.004));
  });

  /**
   * ここが**この機能の肝**。
   *
   * 「初速を適当に散らす」やり方だと、止まる角度の分布が初速の散らし方に
   * 引きずられ、扇の広さどおりの確率にならない。
   * 止まる角度を先に一様に引いているので、そうならないことを確かめる。
   */
  it('止まる位置が扇の広さどおりの確率になる', () => {
    const items: RouletteItem[] = [
      { id: 'a', label: 'あ', weight: 1 },
      { id: 'b', label: 'い', weight: 3 },
    ];

    // 一様乱数の代わりに 0〜1 を等間隔で流し込む。
    const trials = 10_000;
    const counts = new Map<string, number>();
    for (let index = 0; index < trials; index += 1) {
      const plan = planSpin({
        startRotation: 0,
        decel: 0.008,
        random: () => index / trials,
      });
      const winner = itemAtPointer(items, plan.endRotation);
      counts.set(winner?.label ?? '', (counts.get(winner?.label ?? '') ?? 0) + 1);
    }

    // 1 : 3 なので 25% : 75%。丸めの端数ぶんだけ許す。
    expect((counts.get('あ') ?? 0) / trials).toBeCloseTo(0.25, 2);
    expect((counts.get('い') ?? 0) / trials).toBeCloseTo(0.75, 2);
  });

  it('回している間の角度から結果を先読みできない', () => {
    // 途中の角度は、止まる角度と一致しない（回り切る前に結果は決まっていない）。
    const plan = planSpin({ startRotation: 0, decel: 0.008, random: () => 0.7 });
    const midway = rotationAt(plan, plan.durationMs * 0.5);
    expect(Math.abs(plan.endRotation - midway)).toBeGreaterThan(1);
  });
});

describe('貼り付け・CSV から入れる', () => {
  it('1列目を項目名、2列目を重みとして読む', () => {
    const result = parseRouletteText('山田,1\n田中,3\n佐藤');
    expect(result.items).toEqual([
      { label: '山田', weight: 1 },
      { label: '田中', weight: 3 },
      // 重みを書かなければ 1。
      { label: '佐藤', weight: 1 },
    ]);
  });

  it('表計算ソフトから貼ったタブ区切りも読む', () => {
    const result = parseRouletteText('山田\t2\n田中\t1');
    expect(result.delimiter).toBe('tab');
    expect(result.items).toHaveLength(2);
  });

  it('見出しがあれば飛ばし、列の順番が違っても読む', () => {
    const result = parseRouletteText('重み,項目\n3,田中\n1,山田');
    expect(result.headers).toEqual(['重み', '項目']);
    expect(result.items).toEqual([
      { label: '田中', weight: 3 },
      { label: '山田', weight: 1 },
    ]);
  });

  it('見出しに見えるデータ行を誤って捨てない', () => {
    // 「含む」で見ていた頃は「重み付け担当」のような行を見出しと誤判定していた。
    const result = parseRouletteText('重み付け担当,1\n山田,1');
    expect(result.headers).toBeNull();
    expect(result.items).toHaveLength(2);
  });

  it('読めない重みは 1 にして、何件そうしたかを知らせる', () => {
    const result = parseRouletteText('山田,多め\n田中,2');
    expect(result.items[0]).toEqual({ label: '山田', weight: 1 });
    expect(result.weightFallback).toBe(1);
    expect(describeRouletteImport(result)).toContain('重みとして読めなかった 1 件は 1 にしました');
  });

  it('飛ばした行を必ず知らせる', () => {
    const result = parseRouletteText('山田,1\n,3\n山田,1');
    expect(result.skippedEmpty).toBe(1);
    expect(result.duplicates).toBe(1);
    const lines = describeRouletteImport(result);
    expect(lines).toContain('項目名が空の行 1 件は飛ばしました');
    expect(lines).toContain('同じ名前が 1 件あります（そのまま取り込みます）');
  });

  it('上限を超えたぶんは取り込まない', () => {
    const text = Array.from(
      { length: ROULETTE_ITEM_MAX_COUNT + 3 },
      (_, index) => `項目${String(index)},1`,
    ).join('\n');
    const result = parseRouletteText(text);
    expect(result.items).toHaveLength(ROULETTE_ITEM_MAX_COUNT);
    expect(result.truncated).toBe(3);
  });
});
