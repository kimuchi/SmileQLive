/**
 * ひとりで回すルーレットの盤面。
 *
 * ルームも司会もログインも要らない、URL だけで完結するルーレット
 * （`/roulette`）が扱う設定。会議の司会決め・席替え・罰ゲームなど、
 * 「その場で開いて 1 回まわす」用途を想定している。
 *
 * ルームを作って進める抽選会のルーレット（`domain/draw/*`）とは別物として置く。
 * あちらはサーバーが引いて記録し、司会と投影で画面が分かれる。
 * こちらはブラウザの中だけで完結し、**何も保存しない・何も送らない**。
 * 同じ型に押し込めると、片方の都合がもう片方の記録の作りへ漏れる。
 *
 * ここはドメイン層。DOM も乱数も時計も触らない。
 */

/** 扇の 1 つ。 */
export type RouletteItem = {
  /** 画面で並べ替えるための鍵。URL には載らない（URL は名前と重みだけを運ぶ）。 */
  id: string;
  label: string;
  /**
   * 扇の広さ。大きいほど広く、当たりやすくなる。
   *
   * 参考にした配布サイトの `ratio` と同じ意味。整数に限らないが、
   * 会場で「2 倍」「3 倍」と言えるよう整数で入れてもらう前提にしている。
   */
  weight: number;
};

export type RouletteConfig = {
  items: RouletteItem[];
  /** 扇の中に項目名を書くか。項目が多いと読めないので消せるようにしてある。 */
  showLabels: boolean;
  /**
   * 減速の強さ。大きいほど早く止まる。
   *
   * 単位は「1 フレーム（60 分の 1 秒）あたり何度ぶん速度が落ちるか」。
   * 参考にした配布サイトの `decel_value` をそのまま受け取れるようにするため、
   * この単位にしてある（あちらの値をそのまま貼れば近い回り方になる）。
   */
  decel: number;
};

// ---------------------------------------------------------------------------
// 上限と既定
// ---------------------------------------------------------------------------

/**
 * 扇の数の上限。
 *
 * 200 を超えると 1 つの扇が 1.8 度未満になり、画面では線にしか見えない。
 * 描画も重くなるので、読めない盤面を作らせないためにここで止める。
 */
export const ROULETTE_ITEM_MAX_COUNT = 200;

/** 項目名の長さ。会場の後方から読める長さを超えない値（抽選リストと揃える）。 */
export const ROULETTE_LABEL_MAX_LENGTH = 60;

/** 重みの範囲。0 は「盤面に載せるが当たらない」ではなく、扇が消えてしまうので許さない。 */
export const ROULETTE_WEIGHT_MIN = 1;
export const ROULETTE_WEIGHT_MAX = 1000;

/**
 * 減速の範囲。
 *
 * 下限 0.001 … 60 度/秒で回し始めても 1 分近く止まらない。これ以上遅くしても待つだけ。
 * 上限 0.2   … 押した直後に止まる。演出にならないが、動作確認用に許す。
 */
export const ROULETTE_DECEL_MIN = 0.001;
export const ROULETTE_DECEL_MAX = 0.2;

/** 既定の減速。参考にした配布サイトの初期値と同じ。 */
export const ROULETTE_DECEL_DEFAULT = 0.008;

/** 何も渡されなかったときに置いておく空の扇の数。 */
const BLANK_ITEM_COUNT = 4;

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

/** 前後の空白を落とす。全角空白も空白として扱う（中の空白は残す）。 */
export function trimLabel(value: string): string {
  return value.replace(/^[\s　]+/u, '').replace(/[\s　]+$/u, '');
}

export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) {
    return ROULETTE_WEIGHT_MIN;
  }
  return Math.min(ROULETTE_WEIGHT_MAX, Math.max(ROULETTE_WEIGHT_MIN, Math.round(value)));
}

export function clampDecel(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return ROULETTE_DECEL_DEFAULT;
  }
  return Math.min(ROULETTE_DECEL_MAX, Math.max(ROULETTE_DECEL_MIN, value));
}

/** 項目名を保存できる形へそろえる。空文字は空文字のまま返す（呼び出し側が落とす）。 */
export function normalizeLabel(value: string): string {
  return trimLabel(value).slice(0, ROULETTE_LABEL_MAX_LENGTH);
}

/**
 * 回せる盤面かどうか。
 *
 * 扇が 2 つ無いルーレットは回しても意味が無い（必ず同じものが出る）。
 * 1 つでも回せてしまうと「壊れている」と思われるので、画面側で止める。
 */
export function isSpinnable(config: RouletteConfig): boolean {
  return usableItems(config).length >= 2;
}

/**
 * 実際に扇として出る項目。
 *
 * 名前が空のものは出さない。空白だけのものも同じ扱いにする
 * （打っている途中の空白を消さないため、前後の空白は入力欄では落としていない）。
 */
export function usableItems(config: RouletteConfig): RouletteItem[] {
  return config.items.filter((item) => trimLabel(item.label).length > 0);
}

// ---------------------------------------------------------------------------
// 扇の割り付け
// ---------------------------------------------------------------------------

export type RouletteSegment = {
  item: RouletteItem;
  /** 扇の始まりの角度（度）。真上を 0 度として時計回り。 */
  startAngle: number;
  endAngle: number;
  /** 扇の中心の角度（度）。ここが針の位置へ来ると当たり。 */
  centerAngle: number;
  /** 扇の広さ（度）。 */
  sweep: number;
};

/**
 * 重みに応じて 360 度を割り振る。
 *
 * 並び順はそのまま使う。並べ替えると、URL を共有した相手と盤面が変わってしまう。
 */
export function rouletteSegments(items: readonly RouletteItem[]): RouletteSegment[] {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (items.length === 0 || total <= 0) {
    return [];
  }

  let cursor = 0;
  return items.map((item) => {
    const sweep = (Math.max(0, item.weight) / total) * 360;
    const startAngle = cursor;
    cursor += sweep;
    return { item, startAngle, endAngle: cursor, centerAngle: startAngle + sweep / 2, sweep };
  });
}

/**
 * 針の下に来ている扇を返す。
 *
 * 円盤を `rotation` 度回した状態で、真上の針が指しているのはどの扇か。
 * 円盤が時計回りに回るので、針から見ると盤面は反時計回りに動く。
 * つまり針が指す盤面上の角度は `-rotation` になる。
 *
 * **止まってからここで結果を読む。** 先に当たりを決めて角度を合わせるのではなく、
 * 回した結果そこにあったものを当たりとする（配布サイトと同じ振る舞い）。
 */
export function itemAtPointer(
  items: readonly RouletteItem[],
  rotationDeg: number,
): RouletteItem | null {
  const segments = rouletteSegments(items);
  if (segments.length === 0) {
    return null;
  }

  const angle = ((-rotationDeg % 360) + 360) % 360;
  const hit = segments.find((segment) => angle >= segment.startAngle && angle < segment.endAngle);
  // 端数の丸めで最後の扇の終わりを超えることがある。そのときは最後の扇。
  return hit?.item ?? segments[segments.length - 1]?.item ?? null;
}

// ---------------------------------------------------------------------------
// 作る
// ---------------------------------------------------------------------------

/**
 * 空の盤面。
 *
 * URL に何も付いていないときはここから始める。
 * 0 件だと「何を入れる欄なのか」が分からないので、空欄をいくつか置いておく。
 */
export function blankRouletteConfig(makeId: () => string): RouletteConfig {
  return {
    items: Array.from({ length: BLANK_ITEM_COUNT }, () => ({
      id: makeId(),
      label: '',
      weight: 1,
    })),
    showLabels: true,
    decel: ROULETTE_DECEL_DEFAULT,
  };
}
