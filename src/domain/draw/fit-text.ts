/**
 * 決められた幅に収まる文字の大きさを見積もる。
 *
 * 投影画面は 1920×1080 を基準に比率で伸び縮みするため、ブラウザで実寸を測って
 * 縮めると、測る前の 1 フレームだけ大きい文字が出てしまう（会場で目立つ）。
 * 文字数から見積もれば、最初の描画から正しい大きさで出せる。
 *
 * 見積もりなので、正確に埋まるわけではない。
 * **少し小さめに出る側へ倒す**（はみ出して切れるより、少し余るほうが困らない）。
 */

/**
 * 1 文字がフォントサイズの何倍の幅になるか。
 *
 * 全角（漢字・かな）はほぼ 1 文字ぶん。半角英数と半角カナはその半分強。
 * 日本語の名前は全角が主なので、この 2 種類の区別で足りる。
 */
const HALF_WIDTH = /[ -~｡-ﾟ]/;
const HALF_WIDTH_RATIO = 0.55;
const FULL_WIDTH_RATIO = 1;

/** 文字列の幅（フォントサイズの何倍か）。 */
export function textWidthRatio(text: string): number {
  let ratio = 0;
  for (const character of text) {
    ratio += HALF_WIDTH.test(character) ? HALF_WIDTH_RATIO : FULL_WIDTH_RATIO;
  }
  return ratio;
}

export type FitFontSizeOptions = {
  /** 収めたい幅（1920 基準の px）。 */
  maxWidth: number;
  /** これ以上は大きくしない（設定された文字の大きさ）。 */
  maxFontSize: number;
  /**
   * これ以上は小さくしない。
   *
   * ここを下回るなら、縮めるより折り返させるほうが読める。
   * 会場の後方から読める下限として決めている。
   */
  minFontSize?: number;
};

export const DEFAULT_MIN_FONT_SIZE = 28;

/**
 * 文字列が `maxWidth` に収まる大きさを返す。
 *
 * 収まるなら `maxFontSize` のまま。収まらなければ縮める。
 * `minFontSize` まで縮めても収まらないときは `minFontSize` を返す
 * （呼び出し側は折り返しを許しておくこと）。
 */
export function fitFontSize(text: string, options: FitFontSizeOptions): number {
  const minFontSize = options.minFontSize ?? DEFAULT_MIN_FONT_SIZE;
  const ratio = textWidthRatio(text);

  if (ratio <= 0 || options.maxWidth <= 0) {
    return options.maxFontSize;
  }

  const fitted = options.maxWidth / ratio;
  return Math.max(
    Math.min(minFontSize, options.maxFontSize),
    Math.min(options.maxFontSize, fitted),
  );
}
