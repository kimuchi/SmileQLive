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

import type { DrawListKind, DrawRecord, DrawSettings } from '@/domain/draw/draw-list';
import type { PublicImage } from '@/domain/quiz/public-question';

export type StageDrawEntry = {
  id: string;
  position: number;
  label: string;
  /** 品目モードのみ。配信用 URL まで解決済み。 */
  image: PublicImage | null;
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
  }
}

/** id からエントリを引くための索引。画面側で毎回作らないで済むように用意する。 */
export function indexEntries(entries: readonly StageDrawEntry[]): Map<string, StageDrawEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** 引いた順に並べたエントリ（履歴・ボードの表示に使う）。 */
export function drawnStageEntries(
  draw: StageDraw,
): Array<StageDrawEntry & { order: number }> {
  const byId = indexEntries(draw.entries);
  return [...draw.drawn]
    .sort((a, b) => a.order - b.order)
    .flatMap((record) => {
      const entry = byId.get(record.entryId);
      return entry ? [{ ...entry, order: record.order }] : [];
    });
}

/** 直近に引いたもの。 */
export function latestStageEntry(
  draw: StageDraw,
): (StageDrawEntry & { order: number }) | null {
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
