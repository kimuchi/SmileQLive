/**
 * 投影・司会画面へ渡す抽選の状態。
 *
 * 参加者へは渡さない（抽選会・ビンゴのルームに参加者は来ない）。
 *
 * **次に何が出るかは入っていない。** 引くものはサーバーが引く操作を受けた
 * その瞬間に決めて記録する。投影画面はルーレットを回して「見せる」だけで、
 * 結果を先に知って演出しているわけではない。
 * 渡している entries は「まだ引いていないものも含む一覧」で、
 * ルーレットの見た目（名前が高速に切り替わる）とビンゴのボードに使う。
 */

import { entryWeight } from '@/domain/draw/draw-list';
import type { DrawListKind, DrawRecord, DrawSettings } from '@/domain/draw/draw-list';
import type { PublicImage } from '@/domain/quiz/public-question';

export type StageDrawEntry = {
  id: string;
  position: number;
  label: string;
  /** 品目モードのみ。配信用 URL まで解決済み。 */
  image: PublicImage | null;
  /** ルーレットの扇の広さ。持たないリストでは undefined（＝すべて同じ幅）。 */
  weight?: number;
};

export type StageDraw = {
  title: string;
  kind: DrawListKind;
  settings: DrawSettings;
  /** 抽選の対象すべて。ルーレットの見た目とビンゴのボードに使う。 */
  entries: StageDrawEntry[];
  /** 引いた順の記録。 */
  drawn: DrawRecord[];
  /** 直近に引いたもの。まだ 1 件も引いていなければ null。 */
  latestEntryId: string | null;
  /** 直近に引いたものの通し番号（抽選会では当選順位）。 */
  latestOrder: number | null;
  /** まだ引いていない件数。 */
  remainingCount: number;
  /** 数字モードのときの範囲。ボードの升目を作るのに使う。 */
  numberRange: { min: number; max: number } | null;
  /** 投影の背景に敷く画像。配信用 URL まで解決済み。無ければ null。 */
  background: PublicImage | null;
};

/**
 * 数え方の単位。
 *
 * 名簿は「人」、数字の球は「個」、景品は「件」。
 * ここを取り違えると「22人個目」のような文言になり、会場で読みづらい。
 */
export function drawUnit(kind: DrawListKind): string {
  switch (kind) {
    case 'name':
      return '人';
    case 'number':
      return '個';
    case 'item':
      return '件';
    case 'weighted':
      // ルーレットは「◯回目」と数える。引いたものは母集団から減らない。
      return '回';
  }
}

/** id からエントリを引くための索引。画面側で毎回作らないで済むように用意する。 */
export function indexEntries(entries: readonly StageDrawEntry[]): Map<string, StageDrawEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** 引いた順に並べたエントリ（履歴・ボードの表示に使う）。 */
export function drawnStageEntries(draw: StageDraw): Array<StageDrawEntry & { order: number }> {
  const byId = indexEntries(draw.entries);
  return [...draw.drawn]
    .sort((a, b) => a.order - b.order)
    .flatMap((record) => {
      const entry = byId.get(record.entryId);
      return entry ? [{ ...entry, order: record.order }] : [];
    });
}

/** 直近に引いたもの。 */
export function latestStageEntry(draw: StageDraw): (StageDrawEntry & { order: number }) | null {
  if (draw.latestEntryId === null || draw.latestOrder === null) {
    return null;
  }
  const entry = indexEntries(draw.entries).get(draw.latestEntryId);
  return entry ? { ...entry, order: draw.latestOrder } : null;
}

/** まだ引いていないもの（ルーレットで回す候補）。 */
export function remainingStageEntries(draw: StageDraw): StageDrawEntry[] {
  const taken = new Set(draw.drawn.map((record) => record.entryId));
  return draw.entries.filter((entry) => !taken.has(entry.id));
}

/**
 * ビンゴのボードで、その球が出たかどうかを引ける集合。
 */
export function drawnEntryIdSet(draw: StageDraw): Set<string> {
  return new Set(draw.drawn.map((record) => record.entryId));
}

/**
 * 数字ビンゴの列分け（B/I/N/G/O）。
 *
 * 1〜75 の一般的なビンゴでは 15 ずつ 5 列に分ける。
 * 範囲が違う場合も、同じ考え方で 5 列へ均等に割る。
 * 列の見出しは、5 列に収まるときだけ B・I・N・G・O を出す。
 */
export const BINGO_COLUMN_LABELS = ['B', 'I', 'N', 'G', 'O'] as const;

export type BingoColumn = {
  label: string | null;
  entries: StageDrawEntry[];
};

export function bingoColumns(draw: StageDraw): BingoColumn[] {
  const range = draw.numberRange;
  if (!range) {
    return [{ label: null, entries: draw.entries }];
  }

  const total = draw.entries.length;
  const columnCount = Math.min(BINGO_COLUMN_LABELS.length, Math.max(1, Math.ceil(total / 15)));
  const perColumn = Math.ceil(total / columnCount);

  return Array.from({ length: columnCount }, (_, index) => ({
    label: columnCount === BINGO_COLUMN_LABELS.length ? (BINGO_COLUMN_LABELS[index] ?? null) : null,
    entries: draw.entries.slice(index * perColumn, (index + 1) * perColumn),
  })).filter((column) => column.entries.length > 0);
}

/**
 * その球が B/I/N/G/O のどの列か。
 *
 * 球の色をこの列で決める（青・赤・白・緑・黄はビンゴの決まり事）。
 * 5 列に割れない範囲では列を決めないので null を返す。
 */
export function bingoColumnOf(draw: StageDraw, entryId: string): string | null {
  const columns = bingoColumns(draw);
  if (columns.length !== BINGO_COLUMN_LABELS.length) {
    return null;
  }
  for (const column of columns) {
    if (column.entries.some((entry) => entry.id === entryId)) {
      return column.label;
    }
  }
  return null;
}

/**
 * 回している間に見せてよい状態。
 *
 * サーバーは引く操作を受けた**その瞬間**に結果を記録する。一方で投影は
 * そこから 2〜3 秒かけてルーレットを回してから見せる。
 * その間ずっと盤面や履歴へ最新の 1 件を出していると、
 * **回し終わる前に答えが分かってしまう**（会場がいちばん白ける形）。
 *
 * そこで回している間だけ最新の 1 件を伏せる。
 * 「残り」の数え方も、まだ出ていないものとして数える。
 *
 * 伏せるのは見せ方だけで、記録には触らない。
 * 引き直しでも取り消しでもないので、サーバー側の状態は変わらない。
 */
export function visibleDuringSpin(draw: StageDraw, spinning: boolean): StageDraw {
  if (!spinning || draw.drawn.length === 0) {
    return draw;
  }

  const drawn = draw.drawn.slice(0, -1);
  const previous = drawn[drawn.length - 1] ?? null;

  return {
    ...draw,
    drawn,
    latestEntryId: previous?.entryId ?? null,
    latestOrder: previous?.order ?? null,
    remainingCount: draw.remainingCount + 1,
  };
}

// ---------------------------------------------------------------------------
// ルーレット
// ---------------------------------------------------------------------------

/** 円盤の扇 1 枚。角度は真上 (12 時) を 0 度として時計回り。 */
export type WheelSegment = {
  entry: StageDrawEntry;
  /** 扇の始まりの角度（度）。 */
  startAngle: number;
  /** 扇の終わりの角度（度）。 */
  endAngle: number;
  /** 扇の中心の角度（度）。ここが針の位置へ来るように止める。 */
  centerAngle: number;
  /** 扇の広さ（度）。 */
  sweep: number;
};

/**
 * 円盤を扇に分ける。
 *
 * 幅は重みに比例させる。重みを持たないリストではすべて同じ幅になる。
 * 角度は**真上を 0 度、時計回り**で数える（画面の針が真上にあるため）。
 */
export function wheelSegments(entries: readonly StageDrawEntry[]): WheelSegment[] {
  if (entries.length === 0) {
    return [];
  }
  const total = entries.reduce((sum, entry) => sum + entryWeight(entry), 0);
  if (total <= 0) {
    return [];
  }

  let cursor = 0;
  return entries.map((entry) => {
    const sweep = (entryWeight(entry) / total) * 360;
    const startAngle = cursor;
    cursor += sweep;
    return {
      entry,
      startAngle,
      endAngle: cursor,
      centerAngle: startAngle + sweep / 2,
      sweep,
    };
  });
}

/**
 * 当たりの扇を針の位置へ持ってくるための回転角。
 *
 * 円盤を `rotation` 度だけ回すと、`centerAngle` の扇が真上へ来る。
 * `turns` は止まるまでに回る周回数（多いほど長く回って見える）。
 *
 * **ここで結果を決めているわけではない。** 当たりはサーバーが決めて記録済みで、
 * これは「その扇が針の下へ来る角度」を求めているだけ。
 */
export function wheelRotationFor(centerAngle: number, turns: number): number {
  return turns * 360 - centerAngle;
}
