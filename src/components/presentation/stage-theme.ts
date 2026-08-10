/**
 * 会場投影画面の寸法と配色の共通定義。
 *
 * 設計基準は 1920x1080 (16:9)。
 * 実際の投影機は 1280x720 や 3840x2160 のこともあるため、
 * 「1920 のときに何 px か」を書けば自動的に比例する単位 (cqw) へ変換する。
 * cqw はステージ要素 (.stage-scale = container-type: inline-size) の幅に対する割合。
 *
 * 会場の後方から読めることを最優先にし、
 * 情報は「大きく・少なく・色以外の手がかりも添えて」表示する。
 */

/** 設計基準の幅 (px)。 */
export const DESIGN_WIDTH = 1920;
/** 設計基準の高さ (px)。 */
export const DESIGN_HEIGHT = 1080;

/**
 * 1920x1080 基準の px を、ステージ幅に比例する長さへ変換する。
 *
 * 例: stageSize(48) → '2.5cqw'（ステージが 1920px 幅のとき 48px）
 */
export function stageSize(designPx: number): string {
  return `${((designPx / DESIGN_WIDTH) * 100).toFixed(4)}cqw`;
}

/** 高さ基準の割合を長さへ変換する。例: 画面高 40% → stageHeightRatio(0.4) */
export function stageHeightRatio(ratio: number): string {
  return stageSize(DESIGN_HEIGHT * ratio);
}

/** よく使う文字サイズ（1920 基準の px）。 */
export const STAGE_FONT = {
  /** 画面上部の補助情報。 */
  caption: 26,
  /** 補足文・注記。 */
  small: 30,
  /** 本文。 */
  body: 36,
  /** 選択肢（32px 以上の要件に対する余裕を持たせた値）。 */
  choice: 40,
  /** 見出し。 */
  heading: 56,
  /** 問題文（48px 以上の要件に対する余裕を持たせた値）。 */
  question: 60,
  /** 強調する数値（残り秒・人数など）。 */
  emphasis: 92,
  /** 最も目立たせる表示（クイズ名・残り秒）。 */
  hero: 120,
} as const;

/** 選択肢グリッドの列指定。2→2列 / 3→3列 / 4→2x2 / 5→上段3+下段2（中央寄せ）。 */
export function choiceGridClassName(count: number): string {
  switch (count) {
    case 2:
      return 'grid-cols-2';
    case 3:
      return 'grid-cols-3';
    case 4:
      return 'grid-cols-2';
    case 5:
      // 6 列を土台にして 2 列ずつ使うと、下段 2 個を中央へ寄せられる。
      return 'grid-cols-6';
    default:
      return 'grid-cols-2';
  }
}

/** 5 択のときだけ、上段 3 個・下段 2 個（中央寄せ）になるよう各セルの占有列を決める。 */
export function choiceCellClassName(count: number, index: number): string {
  if (count !== 5) {
    return '';
  }
  if (index === 3) {
    // 下段の 1 個目を 2 列目から始めることで、下段 2 個が中央に並ぶ。
    return 'col-span-2 col-start-2';
  }
  return 'col-span-2';
}

/** 順位ごとの装飾。色だけに頼らないよう、順位の数字と枠線も併せて変える。 */
export function rankAccentClassName(rank: number): string {
  switch (rank) {
    case 1:
      return 'border-amber-300 bg-amber-300/20';
    case 2:
      return 'border-slate-200 bg-slate-200/15';
    case 3:
      return 'border-orange-300 bg-orange-300/15';
    default:
      return 'border-white/20 bg-white/5';
  }
}
