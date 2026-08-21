/**
 * 抽選リスト — 「1 つずつ引くもの」の一覧。
 *
 * クイズと同じく、司会者が事前に用意して使い回す資産。
 * 抽選会は名簿から人を引き、ビンゴは数字か景品を引く。
 * どちらも「残りから 1 つ選んで出す」という同じ仕組みなので、
 * 中身の種類 (kind) だけを分けて 1 つの概念にまとめている。
 *
 * ここはドメイン層。Firestore にも React にも依存しない。
 */

import type { MediaRef } from '@/domain/quiz/question';

export const DRAW_LIST_KINDS = ['name', 'number', 'item'] as const;

export type DrawListKind = (typeof DRAW_LIST_KINDS)[number];

export const DRAW_LIST_KIND_LABELS: Record<DrawListKind, string> = {
  name: '名簿（文字だけ）',
  number: '数字（範囲）',
  item: '品目（文字＋画像）',
};

export const DRAW_LIST_KIND_DESCRIPTIONS: Record<DrawListKind, string> = {
  name: '人の名前・部署名・座席番号など。貼り付けや CSV でまとめて取り込めます。',
  number: '1〜75 のような連番。ビンゴの球に使います。',
  item: '景品名などの文字と、その写真の組み合わせ。',
};

export function isDrawListKind(value: string): value is DrawListKind {
  return (DRAW_LIST_KINDS as readonly string[]).includes(value);
}

/**
 * そのモードで使える抽選リストの種類。
 *
 * 抽選会で数字を引いても意味が無く、ビンゴで名簿を引いても成立しない。
 * 品目（文字＋画像）はどちらでも使える（景品の抽選・景品ビンゴ）。
 */
export function drawKindsForMode(mode: 'lottery' | 'bingo'): DrawListKind[] {
  return mode === 'lottery' ? ['name', 'item'] : ['number', 'item'];
}

export function isDrawKindAllowedForMode(kind: DrawListKind, mode: 'lottery' | 'bingo'): boolean {
  return drawKindsForMode(mode).includes(kind);
}

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

/**
 * 1 つのリストに入れられる件数の上限。
 *
 * 抽選リストはルーム作成時にルームのドキュメントへ固めて持たせる。
 * Firestore の 1 ドキュメントは 1MB までなので、
 * 「名前 40 文字 × 2000 件」でも収まる範囲に抑えている。
 */
export const DRAW_ENTRY_MAX_COUNT = 2000;
/** 1 件の文字数の上限。会場の後方から読める長さを超えない値。 */
export const DRAW_LABEL_MAX_LENGTH = 60;

/** 数字モードで使える範囲。ビンゴは 1〜75 が一般的だが、任意の範囲を許す。 */
export const DRAW_NUMBER_MIN = 1;
export const DRAW_NUMBER_MAX = 9999;

// ---------------------------------------------------------------------------
// 演出の設定（GAS 版のスクリプトプロパティに相当）
// ---------------------------------------------------------------------------

export type DrawSettings = {
  /** 候補を切り替える間隔 (ms)。小さいほど速く回る。GAS の ROULETTE_SPEED 相当。 */
  spinIntervalMs: number;
  /** 回し続ける時間 (ms)。これを過ぎてから減速して止まる。 */
  spinDurationMs: number;
  /** 結果の文字の大きさ（1920x1080 基準の px）。GAS の LOTTERY_FONT_SIZE 相当。 */
  resultFontSize: number;
  /** 履歴の文字の大きさ（1920x1080 基準の px）。GAS の HISTORY_FONT_SIZE 相当。 */
  historyFontSize: number;
  /** 既に出たものを常に画面へ並べるか（ビンゴのボード）。 */
  showBoard: boolean;
  /** 投影の背景に敷く画像。無ければ既定の背景。 */
  backgroundAssetId: string | null;
  /**
   * 開始前に流すオープニング動画の URL。
   *
   * 動画そのものは受け取らない（このアプリは画像しかアップロードを許していない）。
   * すでにどこかに置いてある mp4 などの URL を指してもらう。
   */
  openingVideoUrl: string | null;
};

export const DEFAULT_DRAW_SETTINGS: DrawSettings = {
  spinIntervalMs: 50,
  spinDurationMs: 2500,
  resultFontSize: 240,
  historyFontSize: 96,
  showBoard: true,
  backgroundAssetId: null,
  openingVideoUrl: null,
};

export const SPIN_INTERVAL_MIN_MS = 20;
export const SPIN_INTERVAL_MAX_MS = 500;
export const SPIN_DURATION_MIN_MS = 500;
export const SPIN_DURATION_MAX_MS = 15_000;
export const DRAW_FONT_SIZE_MIN = 24;
export const DRAW_FONT_SIZE_MAX = 480;

// ---------------------------------------------------------------------------
// エントリ
// ---------------------------------------------------------------------------

/** 引かれる 1 件。 */
export type DrawEntry = {
  id: string;
  /** 1 始まりの並び順。数字モードでは数字そのものと一致する。 */
  position: number;
  /** 画面に出す文字。数字モードでは "17" のような数字の文字列。 */
  label: string;
  /**
   * 品目モードのみ。クイズの画像と同じ持ち方をする。
   * `url` には保存参照が入っており、読み取り時に署名 URL へ解決する。
   */
  image: MediaRef | null;
};

/**
 * ルームへ固める抽選リスト。
 *
 * クイズの quizSnapshot と同じ考え方で、**ルームを作った瞬間の内容を写し取る**。
 * 当日リストを編集されても、進行中のルームの中身は変わらない。
 */
export type DrawSnapshot = {
  listId: string;
  title: string;
  kind: DrawListKind;
  entries: DrawEntry[];
  settings: DrawSettings;
};

/**
 * 数字の範囲からエントリを作る。
 *
 * 1〜75 を 75 件のドキュメントとして持つのは無駄なので、
 * 数字モードのリストは範囲だけを保存し、ルームへ固めるときにここで展開する。
 */
export function buildNumberEntries(min: number, max: number): DrawEntry[] {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error('DRAW_NUMBER_RANGE_INVALID');
  }
  if (min < DRAW_NUMBER_MIN || max > DRAW_NUMBER_MAX || min > max) {
    throw new Error('DRAW_NUMBER_RANGE_INVALID');
  }
  const count = max - min + 1;
  if (count > DRAW_ENTRY_MAX_COUNT) {
    throw new Error('DRAW_NUMBER_RANGE_TOO_WIDE');
  }
  return Array.from({ length: count }, (_, index) => {
    const value = min + index;
    return {
      id: `n${value}`,
      position: index + 1,
      label: String(value),
      image: null,
    };
  });
}

// ---------------------------------------------------------------------------
// 引いた記録
// ---------------------------------------------------------------------------

/**
 * 引いた 1 件の記録。
 *
 * `order` は 1 始まりの通し番号で、抽選会ではそのまま当選順位になる
 * （GAS 版がスプレッドシートの「当選」列へ 1,2,3… と書いていたものに相当）。
 */
export type DrawRecord = {
  order: number;
  entryId: string;
};

/** まだ引かれていないエントリ。 */
export function remainingEntries(
  entries: readonly DrawEntry[],
  drawn: readonly DrawRecord[],
): DrawEntry[] {
  const taken = new Set(drawn.map((record) => record.entryId));
  return entries.filter((entry) => !taken.has(entry.id));
}

/** 引いた記録をエントリへ戻す（履歴表示用）。引いた順に並ぶ。 */
export function drawnEntries(
  entries: readonly DrawEntry[],
  drawn: readonly DrawRecord[],
): Array<DrawEntry & { order: number }> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return [...drawn]
    .sort((a, b) => a.order - b.order)
    .flatMap((record) => {
      const entry = byId.get(record.entryId);
      // リストを差し替えた等で見つからない場合は履歴から落とす（画面を壊さない）。
      return entry ? [{ ...entry, order: record.order }] : [];
    });
}

/** 直近に引いたもの。まだ 1 件も引いていなければ null。 */
export function latestDraw(
  entries: readonly DrawEntry[],
  drawn: readonly DrawRecord[],
): (DrawEntry & { order: number }) | null {
  const list = drawnEntries(entries, drawn);
  return list.length > 0 ? (list[list.length - 1] ?? null) : null;
}
