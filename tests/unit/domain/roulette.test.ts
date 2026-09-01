import { describe, expect, it } from 'vitest';
import { parseRouletteText, describeRouletteImport } from '@/domain/roulette/roulette-import';
import {
  buildRouletteUrl,
  parseRouletteJson,
  toRouletteJson,
  ROULETTE_JSON_MAX_LENGTH,
} from '@/domain/roulette/roulette-url';
import {
  decelValueFor,
  MIN_TURNS_ON_STOP,
  planStop,
  spinningRotationAt,
  stopSecondsFromDecel,
  stoppingRotationAt,
} from '@/domain/roulette/spin';
import {
  blankRouletteConfig,
  isSpinnable,
  itemAtPointer,
  normalizeBackgroundUrl,
  rouletteSegments,
  ROULETTE_ITEM_MAX_COUNT,
  ROULETTE_SPEED_DEFAULT,
  ROULETTE_STOP_SECONDS_DEFAULT,
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
    spinSpeed: ROULETTE_SPEED_DEFAULT,
    stopSeconds: ROULETTE_STOP_SECONDS_DEFAULT,
    backgroundUrl: null,
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
    // あちらの URL には速さも止まる秒数も無い。減速から止まる秒数へ読み替える。
    expect(result.config.spinSpeed).toBe(ROULETTE_SPEED_DEFAULT);
    expect(result.config.stopSeconds).toBe(
      Math.round(stopSecondsFromDecel(0.008, ROULETTE_SPEED_DEFAULT) * 10) / 10,
    );
  });

  it('こちらで書き出した速さと止まる秒数はそのまま読む', () => {
    const raw = JSON.stringify({
      name: ['あ', 'い'],
      ratio: [1, 1],
      speed_value: 1080,
      stop_seconds: 8.5,
      // 換算値も入っているが、はっきり書いてあるほうを使う。
      decel_value: 0.5,
    });
    const result = parseRouletteJson(raw, makeIdFactory());
    expect(result.ok && result.config.spinSpeed).toBe(1080);
    expect(result.ok && result.config.stopSeconds).toBe(8.5);
  });

  it('背景画像の URL を読む', () => {
    const raw = JSON.stringify({
      name: ['あ', 'い'],
      background_url: 'https://example.com/bg.jpg',
    });
    expect(parseRouletteJson(raw, makeIdFactory())).toMatchObject({
      ok: true,
      config: { backgroundUrl: 'https://example.com/bg.jpg' },
    });
  });

  /**
   * 背景の URL は**人から人へ渡る**。
   * `javascript:` を受け取ると、URL を送るだけで相手の画面で好きなことができる。
   */
  it('画像として敷けない URL は受け取らない', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      '/etc/passwd',
    ]) {
      const raw = JSON.stringify({ name: ['あ', 'い'], background_url: url });
      expect(parseRouletteJson(raw, makeIdFactory())).toMatchObject({
        ok: true,
        config: { backgroundUrl: null },
      });
      expect(normalizeBackgroundUrl(url)).toBeNull();
    }
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
    config.spinSpeed = 1080;
    config.stopSeconds = 8.5;
    config.backgroundUrl = 'https://example.com/bg.jpg';

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
    expect(back.config.spinSpeed).toBe(1080);
    expect(back.config.stopSeconds).toBe(8.5);
    expect(back.config.backgroundUrl).toBe('https://example.com/bg.jpg');
  });

  it('配布サイトへ貼っても回るよう decel_value も書き出す', () => {
    const config = configOf([
      ['あ', 1],
      ['い', 1],
    ]);
    config.spinSpeed = 720;
    config.stopSeconds = 5;

    const payload = JSON.parse(toRouletteJson(config)) as { decel_value: number };
    // 720 度/秒 を 5 秒で止める＝毎秒 144 度／フレームあたり 0.04 度。
    expect(payload.decel_value).toBeCloseTo(decelValueFor(720, 5), 6);
    expect(payload.decel_value).toBeCloseTo(0.04, 4);
  });

  /**
   * 手元のファイルから作った背景は、その端末の中でしか開けない。
   * URL へ載せると「送ったのに背景が出ない」という分かりにくい壊れ方になる。
   */
  it('手元のファイルの背景は URL に載せない', () => {
    const config = configOf([
      ['あ', 1],
      ['い', 1],
    ]);
    config.backgroundUrl = 'blob:http://localhost/8f2c-1234';

    expect(JSON.parse(toRouletteJson(config))).not.toHaveProperty('background_url');
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
      '{"name":["あ"],"ratio":[1],"show_characters_value":true,"decel_value":0.04,"speed_value":720,"stop_seconds":5}',
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
  it('等速で回り続ける（ストップを押すまで止まらない）', () => {
    const at = (elapsedMs: number) =>
      spinningRotationAt({ startRotation: 30, speed: 720, elapsedMs });

    expect(at(0)).toBe(30);
    expect(at(1000)).toBe(30 + 720);
    expect(at(10_000)).toBe(30 + 7200);
    // 1 秒あたりの進み方がいつでも同じ。減速していない。
    expect(at(2000) - at(1000)).toBeCloseTo(at(9000) - at(8000), 6);
  });

  it('ストップしてから決めた秒数で止まる', () => {
    const plan = planStop({ startRotation: 12, speed: 720, stopSeconds: 5, random: () => 0.42 });

    expect(plan.durationMs).toBe(5000);
    expect(stoppingRotationAt(plan, plan.durationMs)).toBeCloseTo(plan.endRotation, 6);
    // 止まったあとは動かない（行き過ぎて戻らない）。
    expect(stoppingRotationAt(plan, plan.durationMs + 5000)).toBe(plan.endRotation);
    expect(stoppingRotationAt(plan, 0)).toBe(plan.startRotation);
    // 途中は必ず手前。
    expect(stoppingRotationAt(plan, 2500)).toBeLessThan(plan.endRotation);
  });

  it('止まるまでの秒数と速さは別々に効く', () => {
    const short = planStop({ startRotation: 0, speed: 720, stopSeconds: 2, random: () => 0.5 });
    const long = planStop({ startRotation: 0, speed: 720, stopSeconds: 9, random: () => 0.5 });
    // 秒数を変えても速さは変わらない。長くした分だけ長く回る。
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
    expect(long.distance).toBeGreaterThan(short.distance);

    const slow = planStop({ startRotation: 0, speed: 180, stopSeconds: 5, random: () => 0.5 });
    const fast = planStop({ startRotation: 0, speed: 1440, stopSeconds: 5, random: () => 0.5 });
    // 速さを変えても止まるまでの秒数は変わらない。回る距離だけ変わる。
    expect(slow.durationMs).toBe(fast.durationMs);
    expect(fast.distance).toBeGreaterThan(slow.distance);
  });

  it('最低でも 1 周は回してから止める', () => {
    // 押した位置のすぐ隣で止まると「操作で止めた」ように見える。
    const plan = planStop({ startRotation: 0, speed: 90, stopSeconds: 0.5, random: () => 0 });
    expect(plan.distance).toBeGreaterThanOrEqual(MIN_TURNS_ON_STOP * 360);
  });

  it('減速に入った瞬間、速さが飛ばない', () => {
    // 回っていた速さのまま減速へ入るよう、回る距離を選んでいる。
    const speed = 720;
    const plan = planStop({ startRotation: 0, speed, stopSeconds: 6, random: () => 0.5 });

    const step = 16;
    const measured = ((stoppingRotationAt(plan, step) - plan.startRotation) / step) * 1000;
    // 周回数を整数へ丸めるぶんのずれは残る。半分〜倍に収まっていれば「飛んで」見えない。
    expect(measured).toBeGreaterThan(speed * 0.5);
    expect(measured).toBeLessThan(speed * 2);
  });

  /**
   * ここが**この機能の肝**。
   *
   * 「勢い任せ」だと、止まる角度の分布が回した長さに引きずられ、
   * 扇の広さどおりの確率にならない。
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
      const plan = planStop({
        // 押すたびに位置が違っても偏らないこと。
        startRotation: (index * 7) % 360,
        speed: 720,
        stopSeconds: 5,
        random: () => index / trials,
      });
      const winner = itemAtPointer(items, plan.endRotation);
      counts.set(winner?.label ?? '', (counts.get(winner?.label ?? '') ?? 0) + 1);
    }

    // 1 : 3 なので 25% : 75%。丸めの端数ぶんだけ許す。
    expect((counts.get('あ') ?? 0) / trials).toBeCloseTo(0.25, 2);
    expect((counts.get('い') ?? 0) / trials).toBeCloseTo(0.75, 2);
  });

  it('減速の途中の角度から結果を先読みできない', () => {
    const plan = planStop({ startRotation: 0, speed: 720, stopSeconds: 5, random: () => 0.7 });
    const midway = stoppingRotationAt(plan, plan.durationMs * 0.5);
    expect(Math.abs(plan.endRotation - midway)).toBeGreaterThan(1);
  });
});

describe('配布サイトの decel_value との換算', () => {
  it('速さと秒数から減速を求め、戻すと元の秒数になる', () => {
    const decel = decelValueFor(720, 5);
    expect(stopSecondsFromDecel(decel, 720)).toBeCloseTo(5, 6);
  });

  it('止まる秒数を短くすると減速は強くなる', () => {
    expect(decelValueFor(720, 2)).toBeGreaterThan(decelValueFor(720, 9));
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
