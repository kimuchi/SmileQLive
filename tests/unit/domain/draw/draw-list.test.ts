import { describe, expect, it } from 'vitest';
import {
  DRAW_ENTRY_MAX_COUNT,
  buildNumberEntries,
  drawLayoutOf,
  entryWeight,
  pickWeighted,
  drawnEntries,
  latestDraw,
  remainingEntries,
  type DrawEntry,
  type DrawRecord,
} from '@/domain/draw/draw-list';
import { ROOM_MODES, acceptsParticipants, isDrawMode, roomModeOf } from '@/domain/room/room-mode';

/**
 * 抽選リストの計算。
 *
 * 「もう出たものを二度出さない」「引いた順が当選順位になる」という、
 * 会場でやり直しの効かない部分をここで固める。
 */

function entry(id: string, position: number, label: string): DrawEntry {
  return { id, position, label, image: null };
}

describe('数字の展開', () => {
  it('範囲から連番を作る', () => {
    const entries = buildNumberEntries(1, 5);

    expect(entries.map((e) => e.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(entries.map((e) => e.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ビンゴの 1〜75 を作れる', () => {
    expect(buildNumberEntries(1, 75)).toHaveLength(75);
  });

  it('1 から始まらない範囲も作れる', () => {
    const entries = buildNumberEntries(100, 102);

    expect(entries.map((e) => e.label)).toEqual(['100', '101', '102']);
    // 並び順は 1 始まり。数字そのものとは別に持つ。
    expect(entries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('id は数字ごとに決まる（引き直しても同じものを指す）', () => {
    expect(buildNumberEntries(1, 3).map((e) => e.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('逆さまの範囲・整数でない値は受け付けない', () => {
    expect(() => buildNumberEntries(10, 1)).toThrow();
    expect(() => buildNumberEntries(1.5, 10)).toThrow();
    expect(() => buildNumberEntries(0, 10)).toThrow();
  });

  it('広すぎる範囲は受け付けない', () => {
    expect(() => buildNumberEntries(1, DRAW_ENTRY_MAX_COUNT + 1)).toThrow();
  });
});

describe('残りと履歴', () => {
  const entries = [entry('a', 1, '山田'), entry('b', 2, '田中'), entry('c', 3, '佐藤')];

  it('引いたものは残りから消える', () => {
    const drawn: DrawRecord[] = [{ order: 1, entryId: 'b' }];

    expect(remainingEntries(entries, drawn).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('全部引いたら残りは空', () => {
    const drawn: DrawRecord[] = [
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'b' },
      { order: 3, entryId: 'c' },
    ];

    expect(remainingEntries(entries, drawn)).toEqual([]);
  });

  it('履歴は引いた順に並ぶ（保存の順番に左右されない）', () => {
    const drawn: DrawRecord[] = [
      { order: 3, entryId: 'c' },
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'b' },
    ];

    expect(drawnEntries(entries, drawn).map((e) => e.label)).toEqual(['山田', '田中', '佐藤']);
    expect(drawnEntries(entries, drawn).map((e) => e.order)).toEqual([1, 2, 3]);
  });

  it('リストに無い id は履歴から落とす（画面を壊さない）', () => {
    const drawn: DrawRecord[] = [
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'missing' },
    ];

    expect(drawnEntries(entries, drawn).map((e) => e.id)).toEqual(['a']);
  });

  it('直近に引いたものを返す', () => {
    const drawn: DrawRecord[] = [
      { order: 1, entryId: 'a' },
      { order: 2, entryId: 'c' },
    ];

    expect(latestDraw(entries, drawn)?.label).toBe('佐藤');
    expect(latestDraw(entries, drawn)?.order).toBe(2);
  });

  it('1 件も引いていなければ直近は無い', () => {
    expect(latestDraw(entries, [])).toBeNull();
  });
});

describe('ルームのモード', () => {
  it('保存されていなければクイズとして扱う', () => {
    // モードが増える前に作られたルームには mode が入っていない。
    expect(roomModeOf(undefined)).toBe('quiz');
    expect(roomModeOf(null)).toBe('quiz');
    expect(roomModeOf('')).toBe('quiz');
    expect(roomModeOf('unknown-mode')).toBe('quiz');
  });

  it('保存された値をそのまま読む', () => {
    for (const mode of ROOM_MODES) {
      expect(roomModeOf(mode)).toBe(mode);
    }
  });

  it('抽選会とビンゴは「1 つずつ引く」モード', () => {
    expect(isDrawMode('lottery')).toBe(true);
    expect(isDrawMode('bingo')).toBe(true);
    expect(isDrawMode('quiz')).toBe(false);
  });

  it('参加者のスマホを使うのはクイズだけ', () => {
    // 抽選会は名簿、ビンゴは紙のカードで進める。参加受付を開かない。
    expect(acceptsParticipants('quiz')).toBe(true);
    expect(acceptsParticipants('lottery')).toBe(false);
    expect(acceptsParticipants('bingo')).toBe(false);
  });
});

describe('drawLayoutOf', () => {
  /**
   * 見せ方は途中で増えた設定。古い抽選リストには showBoard（真偽値）しか無い。
   * 会の途中で見た目が勝手に変わると事故なので、そのときの意図を引き継ぐ。
   */
  it('layout があればそれを使う', () => {
    expect(drawLayoutOf({ layout: 'list' })).toBe('list');
    expect(drawLayoutOf({ layout: 'result' })).toBe('result');
    expect(drawLayoutOf({ layout: 'board' })).toBe('board');
  });

  it('古い設定の showBoard: true は「大きい表示と一覧」', () => {
    expect(drawLayoutOf({ showBoard: true })).toBe('board');
  });

  it('古い設定の showBoard: false は「いま出たものだけ」', () => {
    expect(drawLayoutOf({ showBoard: false })).toBe('result');
  });

  it('どちらも無ければ既定（大きい表示と一覧）', () => {
    expect(drawLayoutOf({})).toBe('board');
  });

  it('知らない値は既定へ寄せる', () => {
    // 手で書き換えられた設定でも、投影が壊れるより既定で出るほうがよい。
    expect(drawLayoutOf({ layout: 'wall' })).toBe('board');
  });

  it('新しい設定では layout が showBoard より強い', () => {
    expect(drawLayoutOf({ layout: 'list', showBoard: true })).toBe('list');
  });
});

describe('pickWeighted', () => {
  /**
   * ルーレットの当たりを決める。
   *
   * 重みは「扇の広さ」そのもの。広い扇ほど当たりやすくなければ、
   * 会場に見えている円盤と結果が食い違う（これがいちばんの事故）。
   * 乱数は差し替えて、区間の境目まで確かめる。
   */
  const entries = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 3 },
    { id: 'c', weight: 6 },
  ];

  it('くじ番号が入った区間の 1 件を返す', () => {
    // 合計 10。0 → a、1〜3 → b、4〜9 → c。
    expect(pickWeighted(entries, () => 0)?.id).toBe('a');
    expect(pickWeighted(entries, () => 1)?.id).toBe('b');
    expect(pickWeighted(entries, () => 3)?.id).toBe('b');
    expect(pickWeighted(entries, () => 4)?.id).toBe('c');
    expect(pickWeighted(entries, () => 9)?.id).toBe('c');
  });

  it('重みの合計を上限として渡す', () => {
    // 乱数へ渡す上限が合計と違うと、端の扇が当たらない／はみ出す。
    let received: number | null = null;
    pickWeighted(entries, (max) => {
      received = max;
      return 0;
    });
    expect(received).toBe(10);
  });

  it('重みを持たない項目はすべて同じ幅', () => {
    const plain = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    expect(pickWeighted(plain, () => 0)?.id).toBe('x');
    expect(pickWeighted(plain, () => 1)?.id).toBe('y');
    expect(pickWeighted(plain, () => 2)?.id).toBe('z');
  });

  it('空なら null', () => {
    expect(pickWeighted([], () => 0)).toBeNull();
  });

  it('偏りが重みどおりになる', () => {
    // 実際に 1 万回引いて、割合が重みへ寄ることを確かめる。
    const counts = new Map<string, number>();
    /*
      決まった手順で数を進める（テストの結果を毎回同じにする）。

      線形合同法の下位ビットをそのまま剰余で使うと、周期が短くて偏る
      （実際、素朴に seed % max で書いたときは 6 倍のはずが 3 倍になった）。
      本番が node:crypto の randomInt を使っているのも同じ理由。
    */
    let seed = 12345;
    const next = (max: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(unit * max);
    };
    for (let i = 0; i < 10_000; i += 1) {
      const picked = pickWeighted(entries, next);
      counts.set(picked?.id ?? '', (counts.get(picked?.id ?? '') ?? 0) + 1);
    }
    // c は a の 6 倍あたりやすい。乱数のぶれを見て幅を持たせる。
    expect((counts.get('c') ?? 0) / (counts.get('a') ?? 1)).toBeGreaterThan(4);
    expect((counts.get('c') ?? 0) / (counts.get('a') ?? 1)).toBeLessThan(9);
  });
});

describe('entryWeight', () => {
  it('無い・0 以下・数字でないものは 1 として扱う', () => {
    // 0 の扇は「絶対に当たらないのに見えている」になってしまう。
    expect(entryWeight({})).toBe(1);
    expect(entryWeight({ weight: 0 })).toBe(1);
    expect(entryWeight({ weight: -5 })).toBe(1);
    expect(entryWeight({ weight: Number.NaN })).toBe(1);
    expect(entryWeight({ weight: null })).toBe(1);
  });

  it('大きすぎる重みは上限で止める', () => {
    expect(entryWeight({ weight: 10_000_000 })).toBe(100_000);
  });
});
