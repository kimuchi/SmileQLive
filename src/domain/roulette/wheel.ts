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
   * 回っている間の速さ（度/秒）。
   *
   * スタートを押してからストップを押すまで、この速さで回り続ける。
   * 360 で 1 秒に 1 周。
   */
  spinSpeed: number;
  /**
   * ストップを押してから止まるまでの秒数。
   *
   * **速さとは別に決める。** 速く回して短く止めることも、
   * ゆっくり回して長く引っぱることもできるようにするため。
   */
  stopSeconds: number;
  /**
   * 投影の背景に敷く画像の URL。無ければ null。
   *
   * URL に載せて共有できるよう、画像そのものではなく置き場所を持つ。
   * 手元のファイルを選んだときは、その端末の中だけで使う一時的な URL が入る
   * （共有できないので、URL へ書き出すときは落とす）。
   */
  backgroundUrl: string | null;
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
 * 回る速さの範囲（度/秒）。
 *
 * 下限 90   … 4 秒で 1 周。字を読ませながらゆっくり回したいとき。
 * 上限 2160 … 1 秒で 6 周。これ以上は扇が溶けて何も見えない。
 */
export const ROULETTE_SPEED_MIN = 90;
export const ROULETTE_SPEED_MAX = 2160;

/** 既定の速さ。1 秒で 2 周。会場で「回っている」と分かり、字も追える。 */
export const ROULETTE_SPEED_DEFAULT = 720;

/**
 * 止まるまでの秒数の範囲。
 *
 * 下限 0.5 … ほぼ即止まり。動作確認用。
 * 上限 30  … これ以上引っぱると会場が飽きる。
 */
export const ROULETTE_STOP_SECONDS_MIN = 0.5;
export const ROULETTE_STOP_SECONDS_MAX = 30;

/** 既定の止まるまでの秒数。 */
export const ROULETTE_STOP_SECONDS_DEFAULT = 5;

/** 背景画像の URL の長さ。長すぎる data: URL を URL へ載せさせないための頭打ち。 */
export const ROULETTE_BACKGROUND_URL_MAX_LENGTH = 2048;

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

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return ROULETTE_SPEED_DEFAULT;
  }
  return Math.min(ROULETTE_SPEED_MAX, Math.max(ROULETTE_SPEED_MIN, Math.round(value)));
}

export function clampStopSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return ROULETTE_STOP_SECONDS_DEFAULT;
  }
  // 0.1 秒刻み。これより細かく指定できても会場では違いが分からない。
  const rounded = Math.round(value * 10) / 10;
  return Math.min(ROULETTE_STOP_SECONDS_MAX, Math.max(ROULETTE_STOP_SECONDS_MIN, rounded));
}

/**
 * 背景画像の URL を受け取れる形にそろえる。
 *
 * **`http(s)` と、その端末だけで使える `blob:` しか通さない。**
 * `javascript:` や `data:text/html` を背景として受け取ると、
 * URL を渡すだけで人の画面で好きなものを実行できてしまう。
 * 背景は URL に載って人から人へ渡るものなので、ここは狭く開ける。
 */
export function normalizeBackgroundUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = trimLabel(value);
  if (trimmed.length === 0 || trimmed.length > ROULETTE_BACKGROUND_URL_MAX_LENGTH) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('blob:')) {
    return trimmed;
  }
  return null;
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
    spinSpeed: ROULETTE_SPEED_DEFAULT,
    stopSeconds: ROULETTE_STOP_SECONDS_DEFAULT,
    backgroundUrl: null,
  };
}
