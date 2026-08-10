import type { RankedParticipant } from '@/domain/room/scoring';
import { cn } from '@/lib/client/cn';
import { formatPoints, formatRank } from '@/lib/format';

/**
 * ランキング表示。
 *
 * - 表示するのは Snapshot が返した範囲だけ（クイズ設定で無効なら null が来る）。
 * - 自分の行だけ強調する。他人の回答内容は一切出さない。
 */
export function LeaderboardPanel({
  leaderboard,
  myParticipantId,
}: {
  leaderboard: readonly RankedParticipant[];
  myParticipantId: string;
}) {
  if (leaderboard.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-center shadow-sm">
        <p className="text-sm text-slate-600">ランキングはまだありません</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-bold text-slate-600">ランキング</h3>
      <ol className="mt-2 flex flex-col gap-2">
        {leaderboard.map((entry) => {
          const isMe = entry.participantId === myParticipantId;
          return (
            <li
              key={entry.participantId}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-xl border px-3 py-2',
                isMe ? 'border-brand-400 bg-brand-50' : 'border-slate-200 bg-white',
              )}
            >
              <span
                className={cn(
                  'w-12 shrink-0 text-center text-base font-bold tabular-nums',
                  isMe ? 'text-brand-700' : 'text-slate-700',
                )}
              >
                {formatRank(entry.rank)}
              </span>
              <span className="min-w-0 flex-1 truncate text-base font-bold text-slate-900">
                {entry.nickname}
                {isMe ? <span className="text-brand-700 ml-1 text-xs">（あなた）</span> : null}
              </span>
              <span className="shrink-0 text-base font-bold text-slate-900 tabular-nums">
                {formatPoints(entry.totalPoints)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
