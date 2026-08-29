/**
 * 投票の画面へ渡す形。
 *
 * 参加者・投影・司会で見せてよい中身が違う。
 *   参加者 … 選択肢と、自分が投票したかどうか。**票数も順位も渡さない**
 *            （投票中に途中経過が見えると、あとの人の投票が引っぱられる）。
 *   投影   … 発表した順位までの結果だけ。まだ出していない順位は渡さない。
 *   司会   … 締め切ったあとは全部。確かめて直すのが仕事なので。
 *
 * ここはドメイン層。Firestore にも React にも依存しない。
 */

import type { BallotGroup, BallotOption, PollSettings, PollSnapshot } from '@/domain/poll/ballot';
import { isRevealed, revealComplete, type RankedOption } from '@/domain/poll/tally';
import type { PublicImage } from '@/domain/quiz/public-question';

/** 参加者・投影が見る投票の状態。 */
export type PollStage = {
  title: string;
  structure: 'flat' | 'nested';
  groups: BallotGroup[];
  options: BallotOption[];
  settings: PollSettings;
  /** 投票した人数。受付中も出してよい（誰が何に入れたかは含まない）。 */
  voteCount: number;
  /** 参加している人数。 */
  participantCount: number;
  /**
   * 投影の背景に敷く画像。
   *
   * 設定に入っているのは保存参照だけなので、**署名 URL への解決はサーバーが行う**
   * （期限付きの URL を用紙へ固めると、当日には切れている）。
   */
  background: PublicImage | null;
};

/** 発表済みの 1 順位。 */
export type PollRevealEntry = {
  rank: number;
  optionId: string;
  label: string;
  note: string | null;
  /** 1 階層目の名前。flat では null。 */
  groupLabel: string | null;
  score: number;
  /** 順位ごとの票数。`counts[0]` が 1 位票。 */
  counts: number[];
  totalVotes: number;
};

/** 投影・司会へ渡す結果。 */
export type PollResult = {
  /** 何位まで発表するか。 */
  revealDepth: number;
  /** すでに出した順位の数。 */
  revealedCount: number;
  /**
   * 出してよい順位だけ。まだ出していない順位は**入っていない**。
   * 投影画面へ全部渡すと、画面のどこかから先に読めてしまう。
   */
  entries: PollRevealEntry[];
  /** 発表しきったか。 */
  complete: boolean;
};

/** 司会だけが見る、締切後の全順位。 */
export type PollTallyRow = {
  optionId: string;
  label: string;
  groupLabel: string | null;
  rank: number;
  score: number;
  counts: number[];
  totalVotes: number;
};

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/**
 * 参加者・投影へ渡す「投票そのもの」。
 *
 * 選択肢と設定と人数だけ。**票数も順位もここには入れない。**
 */
export function pollStageOf(
  snapshot: PollSnapshot,
  counts: {
    voteCount: number;
    participantCount: number;
    /** 解決済みの背景画像。無ければ既定の背景。 */
    background?: PublicImage | null;
  },
): PollStage {
  return {
    title: snapshot.title,
    structure: snapshot.structure,
    groups: snapshot.groups,
    options: snapshot.options,
    settings: snapshot.settings,
    voteCount: counts.voteCount,
    participantCount: counts.participantCount,
    background: counts.background ?? null,
  };
}

function labelsOf(snapshot: PollSnapshot) {
  const options = new Map(snapshot.options.map((option) => [option.id, option]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group.label]));
  return { options, groups };
}

/**
 * 発表用の結果。
 *
 * **出してよい順位だけを詰めて返す。** まだ出していない順位は配列に入らない。
 * 「全部渡して画面で隠す」にすると、投影の HTML から先に読めてしまう。
 *
 * 並びは発表する順（下の順位が先）。同点は同じ順位で並ぶ。
 */
export function pollResultOf(
  snapshot: PollSnapshot,
  ranked: readonly RankedOption[],
  revealedCount: number,
): PollResult {
  const revealDepth = snapshot.settings.revealDepth;
  const { options, groups } = labelsOf(snapshot);

  const entries = ranked
    .filter((entry) => isRevealed(entry.rank, revealDepth, revealedCount))
    .sort((left, right) => right.rank - left.rank)
    .map((entry) => {
      const option = options.get(entry.optionId);
      return {
        rank: entry.rank,
        optionId: entry.optionId,
        label: option?.label ?? '（削除された選択肢）',
        note: option?.note ?? null,
        groupLabel: option?.groupId ? (groups.get(option.groupId) ?? null) : null,
        score: entry.score,
        counts: entry.counts,
        totalVotes: entry.totalVotes,
      };
    });

  return {
    revealDepth,
    revealedCount,
    entries,
    complete: revealComplete(revealDepth, revealedCount),
  };
}

/** 司会が確かめる表。全順位ぶん、点数の高い順。 */
export function pollTallyRowsOf(
  snapshot: PollSnapshot,
  ranked: readonly RankedOption[],
): PollTallyRow[] {
  const { options, groups } = labelsOf(snapshot);
  return ranked.map((entry) => {
    const option = options.get(entry.optionId);
    return {
      optionId: entry.optionId,
      label: option?.label ?? '（削除された選択肢）',
      groupLabel: option?.groupId ? (groups.get(option.groupId) ?? null) : null,
      rank: entry.rank,
      score: entry.score,
      counts: entry.counts,
      totalVotes: entry.totalVotes,
    };
  });
}
