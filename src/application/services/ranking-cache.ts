import 'server-only';

/**
 * 正解発表中のランキングを、インスタンス内で一度だけ作る。
 *
 * ---------------------------------------------------------------------------
 * なぜ要るか
 * ---------------------------------------------------------------------------
 * 順位を出すには参加者全員の得点を読む必要がある。
 * 正解発表に切り替わると全員の画面が**同時に**取りに来るため、
 * そのまま作ると「参加人数 × 参加人数」の読み取りになる。
 * 500 人なら 1 回の正解発表で 25 万件。問題数だけ繰り返される。
 *
 * 実測（tests/load/scale.test.ts）でも、25 人と 500 人で
 * 1 リクエストあたりの所要時間が 16 倍に伸びていた。
 *
 * ---------------------------------------------------------------------------
 * なぜ安全か
 * ---------------------------------------------------------------------------
 * 得点が動くのは回答受付中だけ。正解発表・ランキング・終了の各フェーズでは
 * 誰の得点も変わらない。そしてフェーズが変われば必ず stateVersion が増える。
 * したがって **(ルーム, stateVersion) が同じなら順位も同じ**。
 * ここではその組をキーにして覚えるだけなので、古い順位を見せることはない。
 *
 * 覚えているのはインスタンスのメモリだけで、進行状態そのものは持たない
 * （インスタンスが増えても減っても、結果は Firestore から作り直せる）。
 */

import { getLeaderboard } from '@/infrastructure/firebase/repositories/answer-repository';
import { rankParticipants } from '@/domain/room/scoring';
import type { RankedParticipant } from '@/domain/room/scoring';

/** 覚えておく上限（ルーム数 × 直近の状態）。超えたら古いものから捨てる。 */
const MAX_ENTRIES = 200;

/**
 * 保険の有効期限。
 *
 * stateVersion が同じなら順位も同じなので本来は不要だが、
 * 万一の取りこぼしで古い値を長く抱え込まないよう上限を設ける。
 */
const MAX_AGE_MS = 60_000;

type Entry = {
  /** 作成中でも同じ約束を返す（同時アクセスで人数ぶん問い合わせない）。 */
  promise: Promise<RankedParticipant[]>;
  createdAt: number;
};

const entries = new Map<string, Entry>();

function keyOf(roomId: string, stateVersion: number): string {
  return `${roomId}:${stateVersion}`;
}

function sweep(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      entries.delete(key);
    }
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) {
      break;
    }
    entries.delete(oldest.value);
  }
}

/**
 * 順位つきの参加者一覧を返す。
 *
 * **得点が動かないフェーズからだけ呼ぶこと**（正解発表・ランキング・終了）。
 * 回答受付中に呼ぶと、同じ stateVersion のまま得点が増えるため古い順位が返る。
 */
export async function getRankedParticipants(
  roomId: string,
  stateVersion: number,
): Promise<RankedParticipant[]> {
  const now = Date.now();
  const key = keyOf(roomId, stateVersion);

  const existing = entries.get(key);
  if (existing && now - existing.createdAt <= MAX_AGE_MS) {
    return existing.promise;
  }

  const promise = getLeaderboard(roomId)
    .then(rankParticipants)
    .catch((error: unknown) => {
      // 失敗を覚え込まない。次の要求でもう一度取りに行けるようにする。
      entries.delete(key);
      throw error;
    });

  entries.set(key, { promise, createdAt: now });
  sweep(now);

  return promise;
}

/** テスト用に覚えている内容を捨てる。 */
export function resetRankingCache(): void {
  entries.clear();
}
