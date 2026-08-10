/**
 * 得点とランキング。
 *
 * 初期版は固定点方式:
 *   正解 → question.points / 不正解 → 0点
 * 同点時の順位規則:
 *   1. 正解した問題の elapsed_ms 合計が小さい方を上位
 *   2. joined_at が早い方を上位
 *   3. nickname 昇順
 */

export type ParticipantScore = {
  participantId: string;
  nickname: string;
  totalPoints: number;
  correctCount: number;
  /** 正解した問題の elapsed_ms 合計。 */
  correctElapsedMsTotal: number;
  /** ISO8601 */
  joinedAt: string;
};

export type RankedParticipant = ParticipantScore & { rank: number };

export function awardPoints(isCorrect: boolean, questionPoints: number): number {
  return isCorrect ? questionPoints : 0;
}

export function compareForRanking(a: ParticipantScore, b: ParticipantScore): number {
  if (a.totalPoints !== b.totalPoints) {
    return b.totalPoints - a.totalPoints;
  }
  if (a.correctElapsedMsTotal !== b.correctElapsedMsTotal) {
    return a.correctElapsedMsTotal - b.correctElapsedMsTotal;
  }
  const joinedDiff = Date.parse(a.joinedAt) - Date.parse(b.joinedAt);
  if (joinedDiff !== 0) {
    return joinedDiff;
  }
  return a.nickname.localeCompare(b.nickname, 'ja');
}

/**
 * 順位付け。完全に同一の順序キーを持つ参加者だけ同順位とする。
 * (得点・所要時間・参加時刻・ニックネームがすべて一致するケースは実質発生しない)
 */
export function rankParticipants(scores: readonly ParticipantScore[]): RankedParticipant[] {
  const sorted = [...scores].sort(compareForRanking);
  const ranked: RankedParticipant[] = [];

  let previous: ParticipantScore | null = null;
  let previousRank = 0;

  sorted.forEach((score, index) => {
    const sameAsPrevious = previous !== null && compareForRanking(previous, score) === 0;
    const rank = sameAsPrevious ? previousRank : index + 1;
    ranked.push({ ...score, rank });
    previous = score;
    previousRank = rank;
  });

  return ranked;
}

export const DEFAULT_LEADERBOARD_SIZE = 10;

export function topRanking(
  scores: readonly ParticipantScore[],
  limit: number = DEFAULT_LEADERBOARD_SIZE,
): RankedParticipant[] {
  return rankParticipants(scores).slice(0, Math.max(0, limit));
}

export function findMyRank(
  scores: readonly ParticipantScore[],
  participantId: string,
): RankedParticipant | null {
  return rankParticipants(scores).find((s) => s.participantId === participantId) ?? null;
}
