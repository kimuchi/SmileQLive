import type { ParticipantSnapshot } from '@/domain/room/snapshot';
import { formatCount, formatPoints, formatRank } from '@/lib/format';

/**
 * ランキング表示中・終了後に出す自分の成績。
 * 他の参加者の内訳は出さない。
 */
export function MyScorePanel({
  myResult,
  participantCount,
  nickname,
}: {
  myResult: ParticipantSnapshot['myResult'];
  participantCount: number;
  nickname: string;
}) {
  return (
    <section className="border-brand-200 bg-brand-50 rounded-2xl border p-4 text-center shadow-sm">
      <p className="text-brand-800 truncate text-sm font-bold">{nickname} さんの成績</p>
      <p className="text-brand-900 mt-2 text-4xl font-bold tabular-nums">
        {formatPoints(myResult?.totalPoints ?? 0)}
      </p>
      <p className="text-brand-800 mt-1 text-base font-bold">
        {formatRank(myResult?.rank)} / 参加者 {formatCount(participantCount)}
      </p>
    </section>
  );
}
