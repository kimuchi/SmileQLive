import { Badge } from '@/components/shared/Badge';
import { formatShortDateTime } from '@/lib/format';

/**
 * 参加者一覧（司会のみ）。
 * ニックネームと参加時刻だけを扱い、参加トークンや端末情報は表示しない。
 */

export type ParticipantListEntry = {
  participantId: string;
  nickname: string;
  isActive: boolean;
  joinedAt: string;
};

export type ParticipantListProps = {
  participants: readonly ParticipantListEntry[];
};

export function ParticipantList({ participants }: ParticipantListProps) {
  if (participants.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        まだ参加者がいません。二次元コードを読み取ってもらうとここに表示されます。
      </p>
    );
  }

  const sorted = [...participants].sort(
    (a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.nickname.localeCompare(b.nickname, 'ja'),
  );

  return (
    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
      {sorted.map((participant) => (
        <li
          key={participant.participantId}
          className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 odd:bg-slate-50"
        >
          <span className="min-w-0 truncate font-bold text-slate-900">{participant.nickname}</span>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant={participant.isActive ? 'success' : 'neutral'}>
              {participant.isActive ? 'オンライン' : '離席中'}
            </Badge>
            <span className="text-xs text-slate-500 tabular-nums">
              {formatShortDateTime(participant.joinedAt)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
