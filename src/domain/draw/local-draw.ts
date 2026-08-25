/**
 * ブラウザの中だけで引く抽選（デモ）。
 *
 * 本番は「引く操作を受けたサーバーがその瞬間に決めて記録する」作り。
 * こちらは**サーバーへ何も送らず、記録も残さない**。
 * 用意した抽選リストで「当日どんな画面になるか」を見せるためだけのもの。
 *
 * 母集団と設定は本番と同じ `StageDraw` を受け取り、引いた記録だけを差し替える。
 * こうしておくと、投影の見え方が本番とまったく同じになる
 * （デモ専用の画面を別に作ると、そちらだけ直し忘れて食い違う）。
 */

import { entryWeight, pickWeighted, type DrawRecord } from '@/domain/draw/draw-list';
import type { StageDraw, StageDrawEntry } from '@/domain/draw/draw-stage';
import { removesDrawnEntries, type RoomMode } from '@/domain/room/room-mode';

/** 引いた記録を差し替えた `StageDraw` を作る。 */
export function applyLocalDraw(
  pool: StageDraw,
  drawn: readonly DrawRecord[],
  mode: RoomMode,
): StageDraw {
  const latest = drawn[drawn.length - 1] ?? null;
  return {
    ...pool,
    drawn: [...drawn],
    latestEntryId: latest?.entryId ?? null,
    latestOrder: latest?.order ?? null,
    // ルーレットは引いても母集団が減らない（本番と同じ扱い）。
    remainingCount: removesDrawnEntries(mode)
      ? Math.max(0, pool.entries.length - drawn.length)
      : pool.entries.length,
  };
}

/** まだ引いていないもの。ルーレットは減らないので全件。 */
export function localCandidates(
  pool: StageDraw,
  drawn: readonly DrawRecord[],
  mode: RoomMode,
): StageDrawEntry[] {
  if (!removesDrawnEntries(mode)) {
    return [...pool.entries];
  }
  const taken = new Set(drawn.map((record) => record.entryId));
  return pool.entries.filter((entry) => !taken.has(entry.id));
}

/**
 * 次の 1 件を選ぶ。
 *
 * `random` は 0 以上 1 未満を返す関数（ブラウザでは Math.random）。
 * **本番はこの経路を通らない。** 本番はサーバーが `node:crypto` の randomInt で
 * 偏りなく引く。ここは見せるためだけなので Math.random で足りるが、
 * 引数で受け取れるようにして、テストからは決め打ちの値を渡せるようにしている。
 */
export function pickLocalEntry(
  pool: StageDraw,
  drawn: readonly DrawRecord[],
  mode: RoomMode,
  random: () => number,
): StageDrawEntry | null {
  const candidates = localCandidates(pool, drawn, mode);
  if (candidates.length === 0) {
    return null;
  }

  if (!removesDrawnEntries(mode)) {
    // ルーレット。重みが大きい扇ほど当たりやすい（本番と同じ選び方）。
    const total = candidates.reduce((sum, entry) => sum + entryWeight(entry), 0);
    return pickWeighted(candidates, () => Math.min(total - 1, Math.floor(random() * total)));
  }

  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index] ?? null;
}
