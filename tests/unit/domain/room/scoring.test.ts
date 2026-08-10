import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEADERBOARD_SIZE,
  awardPoints,
  compareForRanking,
  findMyRank,
  rankParticipants,
  topRanking,
} from '@/domain/room/scoring';
import type { ParticipantScore } from '@/domain/room/scoring';

/**
 * 得点とランキング（仕様書 §37.1）。
 *
 * 同点時の順位規則:
 *   1. totalPoints 降順
 *   2. correctElapsedMsTotal 昇順（正解までが速い方が上位）
 *   3. joinedAt 昇順（先に参加した方が上位）
 *   4. nickname 昇順（ja ロケール）
 */

const BASE_JOINED_AT = '2026-08-10T10:00:00.000Z';

function score(overrides: Partial<ParticipantScore> & { participantId: string }): ParticipantScore {
  return {
    nickname: 'たろう',
    totalPoints: 1000,
    correctCount: 1,
    correctElapsedMsTotal: 5000,
    joinedAt: BASE_JOINED_AT,
    ...overrides,
  };
}

function idsInOrder(scores: readonly ParticipantScore[]): string[] {
  return rankParticipants(scores).map((s) => s.participantId);
}

describe('awardPoints', () => {
  it('正解なら問題の配点を、そのまま与える', () => {
    expect(awardPoints(true, 1000)).toBe(1000);
    expect(awardPoints(true, 1)).toBe(1);
  });

  it('不正解なら 0 点', () => {
    expect(awardPoints(false, 1000)).toBe(0);
    expect(awardPoints(false, 0)).toBe(0);
  });

  it('配点 0 の問題は正解でも 0 点', () => {
    expect(awardPoints(true, 0)).toBe(0);
  });
});

describe('compareForRanking', () => {
  it('得点が高い方を上位にする', () => {
    const high = score({ participantId: 'a', totalPoints: 2000 });
    const low = score({ participantId: 'b', totalPoints: 1000 });

    expect(compareForRanking(high, low)).toBeLessThan(0);
    expect(compareForRanking(low, high)).toBeGreaterThan(0);
  });

  it('同点なら正解までの合計所要時間が短い方を上位にする', () => {
    const fast = score({ participantId: 'a', correctElapsedMsTotal: 3000 });
    const slow = score({ participantId: 'b', correctElapsedMsTotal: 9000 });

    expect(compareForRanking(fast, slow)).toBeLessThan(0);
  });

  it('得点も所要時間も同じなら参加が早い方を上位にする', () => {
    const early = score({ participantId: 'a', joinedAt: '2026-08-10T09:59:00.000Z' });
    const late = score({ participantId: 'b', joinedAt: '2026-08-10T10:05:00.000Z' });

    expect(compareForRanking(early, late)).toBeLessThan(0);
  });

  it('参加時刻まで同じならニックネーム昇順にする', () => {
    const first = score({ participantId: 'a', nickname: 'あいこ' });
    const second = score({ participantId: 'b', nickname: 'かなこ' });

    expect(compareForRanking(first, second)).toBeLessThan(0);
    expect(compareForRanking(second, first)).toBeGreaterThan(0);
  });

  it('すべての順序キーが同じなら 0 を返す', () => {
    expect(compareForRanking(score({ participantId: 'a' }), score({ participantId: 'b' }))).toBe(0);
  });

  it('順序キーは 得点 → 所要時間 → 参加時刻 → 名前 の優先度で効く', () => {
    // 得点が低ければ、所要時間がどれだけ速くても下位。
    const richSlow = score({
      participantId: 'a',
      totalPoints: 2000,
      correctElapsedMsTotal: 60_000,
    });
    const poorFast = score({ participantId: 'b', totalPoints: 1000, correctElapsedMsTotal: 100 });
    expect(compareForRanking(richSlow, poorFast)).toBeLessThan(0);

    // 所要時間が短ければ、参加が遅くても上位。
    const fastLate = score({
      participantId: 'c',
      correctElapsedMsTotal: 100,
      joinedAt: '2026-08-10T11:00:00.000Z',
    });
    const slowEarly = score({
      participantId: 'd',
      correctElapsedMsTotal: 200,
      joinedAt: '2026-08-10T09:00:00.000Z',
    });
    expect(compareForRanking(fastLate, slowEarly)).toBeLessThan(0);
  });
});

describe('rankParticipants', () => {
  it('得点降順に並べ、1 位から順位を振る', () => {
    const ranked = rankParticipants([
      score({ participantId: 'b', totalPoints: 2000 }),
      score({ participantId: 'c', totalPoints: 1000 }),
      score({ participantId: 'a', totalPoints: 3000 }),
    ]);

    expect(ranked.map((r) => r.participantId)).toEqual(['a', 'b', 'c']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('同点は所要時間・参加時刻・名前の順で解決する', () => {
    expect(
      idsInOrder([
        score({ participantId: 'name-late', nickname: 'さとし' }),
        score({ participantId: 'name-early', nickname: 'あきら' }),
        score({ participantId: 'joined-early', joinedAt: '2026-08-10T09:00:00.000Z' }),
        score({ participantId: 'fast', correctElapsedMsTotal: 1000 }),
      ]),
    ).toEqual(['fast', 'joined-early', 'name-early', 'name-late']);
  });

  it('順序キーが完全に一致する参加者は同順位になり、次の順位は繰り下がる', () => {
    const ranked = rankParticipants([
      score({ participantId: 'tie-1', nickname: 'ゆうこ' }),
      score({ participantId: 'tie-2', nickname: 'ゆうこ' }),
      score({ participantId: 'lower', totalPoints: 500 }),
    ]);

    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it('入力配列を破壊しない', () => {
    const input = [
      score({ participantId: 'low', totalPoints: 100 }),
      score({ participantId: 'high', totalPoints: 900 }),
    ];
    const snapshot = input.map((s) => s.participantId);

    rankParticipants(input);

    expect(input.map((s) => s.participantId)).toEqual(snapshot);
  });

  it('元の得点情報を保ったまま rank を足す', () => {
    const ranked = rankParticipants([score({ participantId: 'a', correctCount: 3 })]);

    expect(ranked.at(0)).toEqual({
      participantId: 'a',
      nickname: 'たろう',
      totalPoints: 1000,
      correctCount: 3,
      correctElapsedMsTotal: 5000,
      joinedAt: BASE_JOINED_AT,
      rank: 1,
    });
  });

  it('参加者がいなければ空配列', () => {
    expect(rankParticipants([])).toEqual([]);
  });
});

describe('topRanking', () => {
  const many = Array.from({ length: 15 }, (_unused, index) =>
    score({ participantId: `p${index}`, totalPoints: 1500 - index * 10 }),
  );

  it('既定では上位 10 件を返す', () => {
    expect(DEFAULT_LEADERBOARD_SIZE).toBe(10);
    expect(topRanking(many)).toHaveLength(10);
    expect(topRanking(many).at(0)?.participantId).toBe('p0');
    expect(topRanking(many).at(9)?.participantId).toBe('p9');
  });

  it('件数を指定できる', () => {
    expect(topRanking(many, 3).map((r) => r.participantId)).toEqual(['p0', 'p1', 'p2']);
  });

  it('0 以下の指定では空配列', () => {
    expect(topRanking(many, 0)).toEqual([]);
    expect(topRanking(many, -5)).toEqual([]);
  });

  it('参加者数より大きい指定でも全件だけ返す', () => {
    expect(topRanking(many, 100)).toHaveLength(15);
  });
});

describe('findMyRank', () => {
  const scores = [
    score({ participantId: 'a', totalPoints: 3000 }),
    score({ participantId: 'b', totalPoints: 2000 }),
    score({ participantId: 'c', totalPoints: 1000 }),
  ];

  it('上位 10 件の外にいても自分の順位を返す', () => {
    const long = Array.from({ length: 30 }, (_unused, index) =>
      score({ participantId: `p${index}`, totalPoints: 3000 - index }),
    );

    expect(findMyRank(long, 'p25')?.rank).toBe(26);
  });

  it('自分の得点情報を含めて返す', () => {
    const mine = findMyRank(scores, 'b');

    expect(mine?.rank).toBe(2);
    expect(mine?.participantId).toBe('b');
    expect(mine?.totalPoints).toBe(2000);
  });

  it('見つからなければ null', () => {
    expect(findMyRank(scores, 'unknown')).toBeNull();
    expect(findMyRank([], 'a')).toBeNull();
  });
});
