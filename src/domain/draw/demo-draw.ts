/**
 * デモ用の抽選データ。
 *
 * 投影画面だけで抽選会・ビンゴ・ルーレットを回して見せるためのもの。
 * ルームもログインも要らないので、「どんな画面になるのか」を人に見せられる。
 *
 * **本番の抽選には一切関わらない。**
 * 本番は「引く操作を受けたサーバーがその瞬間に決めて記録する」作りで、
 * こちらはブラウザの中だけで完結する。混ざらないよう、置き場所も分けている。
 *
 * 中身は決め打ち。ここで乱数を使うと、サーバーで描いた HTML と
 * ブラウザで描いた HTML が食い違う（画面がちらつく）。
 */

import { DEFAULT_DRAW_SETTINGS, type DrawListKind, type DrawRecord } from '@/domain/draw/draw-list';
import type { StageDraw, StageDrawEntry } from '@/domain/draw/draw-stage';

/** デモで見せられる催し。クイズは問題が要るのでここには入れない。 */
export const DEMO_MODES = ['lottery', 'bingo', 'roulette'] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

export const DEMO_MODE_LABELS: Record<DemoMode, string> = {
  lottery: '抽選会',
  bingo: 'ビンゴ',
  roulette: 'ルーレット',
};

export function isDemoMode(value: unknown): value is DemoMode {
  return typeof value === 'string' && (DEMO_MODES as readonly string[]).includes(value);
}

/** 抽選会のデモに使う名前。実在の人物ではない。 */
const DEMO_NAMES = [
  '青木 大輔',
  '飯田 さやか',
  '上野 健一',
  '遠藤 美咲',
  '大山 直樹',
  '加藤 千夏',
  '木村 亮',
  '工藤 彩',
  '小林 誠',
  '佐々木 遥',
  '柴田 悠斗',
  '鈴木 里奈',
  '瀬戸 和也',
  '高橋 未来',
  '田村 翔',
  '土屋 真由美',
  '中村 拓海',
  '西野 優花',
  '野口 隆',
  '橋本 奈々',
  '林 俊介',
  '平野 結衣',
  '藤井 大地',
  '前田 桜',
  '松本 悠',
  '三浦 愛子',
  '宮田 蓮',
  '村上 香織',
  '森 陽介',
  '山田 詩織',
];

/** ルーレットのデモに使う扇。重みの差が見た目で分かる並びにしている。 */
const DEMO_WHEEL = [
  { label: '大当たり', weight: 1 },
  { label: 'ハズレ', weight: 12 },
  { label: 'もう一回', weight: 6 },
  { label: '当たり', weight: 4 },
  { label: '参加賞', weight: 9 },
  { label: '特賞', weight: 2 },
];

/** ビンゴのデモに使う範囲。一般的なビンゴと同じ 1〜75。 */
const DEMO_NUMBER_MIN = 1;
const DEMO_NUMBER_MAX = 75;

function demoEntries(mode: DemoMode): StageDrawEntry[] {
  if (mode === 'bingo') {
    return Array.from({ length: DEMO_NUMBER_MAX - DEMO_NUMBER_MIN + 1 }, (_, index) => ({
      id: `n${index}`,
      position: index + 1,
      label: String(DEMO_NUMBER_MIN + index),
      image: null,
    }));
  }
  if (mode === 'roulette') {
    return DEMO_WHEEL.map((entry, index) => ({
      id: `w${index}`,
      position: index + 1,
      label: entry.label,
      image: null,
      weight: entry.weight,
    }));
  }
  return DEMO_NAMES.map((label, index) => ({
    id: `p${index}`,
    position: index + 1,
    label,
    image: null,
  }));
}

function demoKind(mode: DemoMode): DrawListKind {
  switch (mode) {
    case 'bingo':
      return 'number';
    case 'roulette':
      return 'weighted';
    case 'lottery':
      return 'name';
  }
}

const DEMO_TITLES: Record<DemoMode, string> = {
  lottery: '大抽選会（デモ）',
  bingo: 'ビンゴ大会（デモ）',
  roulette: 'お楽しみルーレット（デモ）',
};

/**
 * 引いた記録から、投影画面へ渡す形を作る。
 *
 * 本番と同じ `StageDraw` を作るので、**見え方は本番とまったく同じ**になる。
 * デモ専用の画面を別に作ると、そちらだけ直し忘れて食い違う。
 */
export function buildDemoDraw(mode: DemoMode, drawn: readonly DrawRecord[]): StageDraw {
  const entries = demoEntries(mode);
  const latest = drawn[drawn.length - 1] ?? null;

  return {
    title: DEMO_TITLES[mode],
    kind: demoKind(mode),
    settings: {
      ...DEFAULT_DRAW_SETTINGS,
      // デモは見せるのが目的なので、少し短めに回して次々出す。
      spinDurationMs: 1800,
      stopDurationMs: 2600,
      layout: mode === 'bingo' ? 'board' : 'result',
    },
    entries,
    drawn: [...drawn],
    latestEntryId: latest?.entryId ?? null,
    latestOrder: latest?.order ?? null,
    // ルーレットは引いても母集団が減らない（本番と同じ扱い）。
    remainingCount: mode === 'roulette' ? entries.length : entries.length - drawn.length,
    numberRange: mode === 'bingo' ? { min: DEMO_NUMBER_MIN, max: DEMO_NUMBER_MAX } : null,
    background: null,
  };
}

/**
 * 次の 1 件を選ぶ。
 *
 * `random` は 0 以上 1 未満を返す関数（ブラウザでは Math.random）。
 * **本番はこの経路を通らない。** 本番はサーバーが `node:crypto` の
 * randomInt で偏りなく引く。ここは見せるためだけの抽選なので、
 * 引数で受け取れるようにして、テストからは決め打ちの値を渡せるようにしている。
 */
export function pickDemoEntry(
  mode: DemoMode,
  drawn: readonly DrawRecord[],
  random: () => number,
): StageDrawEntry | null {
  const entries = demoEntries(mode);

  if (mode === 'roulette') {
    // 重みぶんの幅を持つ「くじ」を 1 本引く。広い扇ほど当たりやすい。
    const total = entries.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
    let ticket = random() * total;
    for (const entry of entries) {
      ticket -= entry.weight ?? 1;
      if (ticket < 0) {
        return entry;
      }
    }
    return entries[entries.length - 1] ?? null;
  }

  const taken = new Set(drawn.map((record) => record.entryId));
  const remaining = entries.filter((entry) => !taken.has(entry.id));
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(remaining.length - 1, Math.floor(random() * remaining.length))] ?? null;
}
