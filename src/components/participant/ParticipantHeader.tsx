import { Badge } from '@/components/shared/Badge';
import { ConnectionStatus } from '@/components/shared/ConnectionStatus';
import { ROOM_PHASE_LABELS, type RoomPhase } from '@/domain/room/state-machine';
import type { RoomChannelStatus } from '@/lib/client/realtime-status';
import { formatQuestionProgress } from '@/lib/format';

/**
 * 参加者画面のヘッダー。
 *
 * 通信が切れても消さない。進行状況と自分のニックネームを常に見せ、
 * 再接続中であることだけを細い帯で伝える。
 *
 * nickname が null なら名前を出さない。投票では名前を聞かずに参加させ、
 * 表示名はサーバーが割り当てている。本人が名乗っていない名前を
 * 「あなた」として出すと、別人の画面を見ているのかと迷わせてしまう。
 */
export function ParticipantHeader({
  quizTitle,
  nickname,
  phase,
  questionPosition,
  totalQuestions,
  showTotalQuestions,
  status,
}: {
  quizTitle: string;
  /** 本人が名乗った名前。名前を聞かないモードでは null。 */
  nickname: string | null;
  phase: RoomPhase;
  questionPosition: number | null;
  totalQuestions: number;
  /** 「/ 全n問」を出すか。 */
  showTotalQuestions: boolean;
  status: RoomChannelStatus;
}) {
  const showProgress =
    questionPosition !== null && (showTotalQuestions ? totalQuestions > 0 : true);

  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-600">{quizTitle}</p>
          {showProgress ? (
            <p className="mt-0.5 text-lg font-bold text-slate-900">
              {formatQuestionProgress(questionPosition, totalQuestions, {
                showTotal: showTotalQuestions,
              })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="brand" size="md">
            {ROOM_PHASE_LABELS[phase]}
          </Badge>
          {nickname !== null ? (
            <span className="max-w-32 truncate text-xs text-slate-600">{nickname}</span>
          ) : null}
        </div>
      </div>

      {/* 接続済みのときは何も出さない。切断中だけ「再接続しています」と伝える。 */}
      <ConnectionStatus status={status} className="self-start" />
    </header>
  );
}
