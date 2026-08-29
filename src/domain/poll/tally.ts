/**
 * 投票の集計。
 *
 * 大事な決まりが 2 つある。
 *
 * 1. **集計は締め切った時点で一度凍らせる。**
 *    そのあと司会が中身を確かめ、必要なら票数を直してから発表する。
 *    紙の投票と合わせる会もあるし、明らかな異常値を外したい会もある。
 *    「投票そのもの」と「発表する数字」を分けておけば、直しても投票の記録は残る。
 *
 * 2. **点数は票数から計算し直す。** 司会が直すのは票数だけ。
 *    点数を直接いじれるようにすると、票数と点数が食い違ったまま発表されうる。
 *
 * ここはドメイン層。Firestore にも React にも依存しない。
 */

import { normalizePoints, type PollSettings } from '@/domain/poll/ballot';

/** 1 つの選択肢が集めた票。`counts[0]` が 1 位票の数。 */
export type OptionTally = {
  optionId: string;
  /** 順位ごとの票数。長さは rankDepth。 */
  counts: number[];
};

/** 集計の途中経過・確定値。 */
export type PollTally = {
  /** 集計を凍らせた時点の投票数（人数）。編集しても動かさない。 */
  voterCount: number;
  entries: OptionTally[];
};

/** 順位を付けたあとの 1 件。 */
export type RankedOption = {
  optionId: string;
  /** 1 から始まる順位。同点は同じ順位になる。 */
  rank: number;
  score: number;
  counts: number[];
  /** 総得票数（何位の票でも 1 票として数える）。 */
  totalVotes: number;
};

/** 票数から点数を出す。 */
export function scoreOf(counts: readonly number[], points: readonly number[]): number {
  return counts.reduce((sum, count, index) => sum + count * (points[index] ?? 0), 0);
}

/** 空の集計。まだ 1 票も入っていない状態。 */
export function emptyTally(optionIds: readonly string[], rankDepth: number): PollTally {
  return {
    voterCount: 0,
    entries: optionIds.map((optionId) => ({
      optionId,
      counts: Array.from({ length: rankDepth }, () => 0),
    })),
  };
}

/**
 * 投票の記録から集計を作る。
 *
 * `votes` は 1 人ぶんずつの「選んだ順の選択肢 ID」。
 * 用紙に無い選択肢は捨てる（用紙を差し替えた古い投票が混ざったとき用）。
 */
export function tallyVotes(
  optionIds: readonly string[],
  rankDepth: number,
  votes: ReadonlyArray<readonly string[]>,
): PollTally {
  const counts = new Map<string, number[]>();
  for (const optionId of optionIds) {
    counts.set(
      optionId,
      Array.from({ length: rankDepth }, () => 0),
    );
  }

  for (const choices of votes) {
    choices.forEach((optionId, index) => {
      if (index >= rankDepth) {
        return;
      }
      const row = counts.get(optionId);
      if (row) {
        row[index] = (row[index] ?? 0) + 1;
      }
    });
  }

  return {
    voterCount: votes.length,
    entries: optionIds.map((optionId) => ({
      optionId,
      counts: counts.get(optionId) ?? Array.from({ length: rankDepth }, () => 0),
    })),
  };
}

/**
 * 集計を保存済みの設定に合わせて読み直す。
 *
 * 票数の長さが rankDepth と食い違っていたら、足りない分を 0 で埋める。
 * 用紙にある選択肢はすべて並べる（0 票の選択肢も出す）。
 */
export function normalizeTally(
  tally: PollTally | null | undefined,
  optionIds: readonly string[],
  rankDepth: number,
): PollTally {
  const byId = new Map((tally?.entries ?? []).map((entry) => [entry.optionId, entry]));
  return {
    voterCount: Math.max(0, Math.round(tally?.voterCount ?? 0)),
    entries: optionIds.map((optionId) => {
      const counts = byId.get(optionId)?.counts ?? [];
      return {
        optionId,
        counts: Array.from({ length: rankDepth }, (_, index) =>
          Math.max(0, Math.round(counts[index] ?? 0)),
        ),
      };
    }),
  };
}

/**
 * 順位を付ける。
 *
 * 並べ方:
 *   1. 点数が高い順
 *   2. 同点なら 1 位票が多い順（さらに 2 位票…と順に見る）
 *   3. それも同じなら、用紙の並び順（`optionIds` の順）
 *
 * **同点は同じ順位**にする（1 位が 2 つなら次は 3 位）。
 * 会場で「同点だったのに片方だけ 2 位」と出すと、あとで揉める。
 */
export function rankOptions(
  tally: PollTally,
  optionIds: readonly string[],
  settings: PollSettings,
): RankedOption[] {
  const points = normalizePoints(settings.points, settings.rankDepth);
  const order = new Map(optionIds.map((optionId, index) => [optionId, index]));

  const scored = tally.entries.map((entry) => ({
    optionId: entry.optionId,
    counts: [...entry.counts],
    score: scoreOf(entry.counts, points),
    totalVotes: entry.counts.reduce((sum, count) => sum + count, 0),
  }));

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    for (let index = 0; index < points.length; index += 1) {
      const a = left.counts[index] ?? 0;
      const b = right.counts[index] ?? 0;
      if (a !== b) {
        return b - a;
      }
    }
    return (order.get(left.optionId) ?? 0) - (order.get(right.optionId) ?? 0);
  });

  const ranked: RankedOption[] = [];
  let lastKey: string | null = null;
  let lastRank = 0;

  scored.forEach((entry, index) => {
    const key = `${entry.score}:${entry.counts.join(',')}`;
    // 同点は同じ順位。次の順位は「並びの位置」まで飛ぶ（1,1,3 のようになる）。
    const rank = key === lastKey ? lastRank : index + 1;
    lastKey = key;
    lastRank = rank;
    ranked.push({ ...entry, rank });
  });

  return ranked;
}

/**
 * 発表で出す順位の並び。
 *
 * **下の順位から**返す。3 位まで発表するなら [3, 2, 1]。
 * 1 位から出してしまうと、そのあとの発表を誰も見ない。
 */
export function revealOrder(revealDepth: number): number[] {
  return Array.from({ length: Math.max(1, revealDepth) }, (_, index) => revealDepth - index);
}

/**
 * いま出してよい順位か。
 *
 * `revealedCount` は「何回『次の順位』を押したか」。
 * 3 位まで発表する会で 1 回押したら 3 位まで、2 回押したら 2 位まで見せる。
 */
export function isRevealed(rank: number, revealDepth: number, revealedCount: number): boolean {
  if (revealedCount <= 0) {
    return false;
  }
  const lowestShown = revealDepth - revealedCount + 1;
  return rank >= lowestShown && rank <= revealDepth;
}

/** 全部出し終わったか。 */
export function revealComplete(revealDepth: number, revealedCount: number): boolean {
  return revealedCount >= Math.max(1, revealDepth);
}

/**
 * 発表で使う順位ごとのまとまり。
 *
 * 同点があると 1 つの順位に複数入る。会場へはまとめて出す。
 */
export type RevealGroup = { rank: number; options: RankedOption[] };

export function groupByRank(ranked: readonly RankedOption[], revealDepth: number): RevealGroup[] {
  const groups = new Map<number, RankedOption[]>();
  for (const entry of ranked) {
    if (entry.rank > revealDepth) {
      continue;
    }
    const list = groups.get(entry.rank) ?? [];
    list.push(entry);
    groups.set(entry.rank, list);
  }
  return [...groups.entries()]
    .map(([rank, options]) => ({ rank, options }))
    .sort((left, right) => left.rank - right.rank);
}
