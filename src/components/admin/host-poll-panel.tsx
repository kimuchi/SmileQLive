'use client';

import { useCallback, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { TextInput } from '@/components/shared/TextInput';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { rankLabel } from '@/domain/poll/ballot';
import type { PollResult, PollStage, PollTallyRow } from '@/domain/poll/poll-stage';
import {
  nextRevealRank,
  revealComplete,
  type RoomAction,
  type RoomPhase,
} from '@/domain/room/state-machine';
import { apiDelete, apiPatch, apiPost } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import { formatCount, formatRatioCount } from '@/lib/format';
import type { PollTallyResponse, PollVotesClearedResponse } from '@/types/api';

/**
 * 司会画面の投票パネル。
 *
 * 進行は「受付 → 締切 → 中身を確かめる → 発表」の一本道。大きなボタンは
 * 司会画面本体が出すので、ここは**確かめて直す**ところに集中する。
 *
 * 守っている約束:
 * - 票数を直せるのは**締切後・発表前だけ**。会場へ出した数字が後から変わると混乱する。
 * - 直すのは票数だけ。点数と順位はサーバーが数え直す
 *   （点数を直接いじれると、票数と食い違ったまま発表されうる）。
 * - 受付中は順位を出さない。司会画面は会場のスクリーンに映ることがある。
 */

export type HostPollPanelProps = {
  roomId: string;
  phase: RoomPhase;
  poll: PollStage;
  result: PollResult | null;
  /** 締切後の全順位。受付中は null。 */
  tally: readonly PollTallyRow[] | null;
  availableActions: readonly RoomAction[];
  busy: boolean;
  /** 集計を直したあとに Snapshot を取り直す。 */
  onChanged: () => void;
};

/** 全角で入力された数字も受け取る（会場の PC は日本語入力のままのことが多い）。 */
function parseIntegerInput(value: string): number | null {
  const normalized = value.normalize('NFKC').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type Draft = Record<string, string[]>;

function toDraft(rows: readonly PollTallyRow[]): Draft {
  return Object.fromEntries(rows.map((row) => [row.optionId, row.counts.map(String)]));
}

export function HostPollPanel({
  roomId,
  phase,
  poll,
  result,
  tally,
  availableActions,
  busy,
  onChanged,
}: HostPollPanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [voterCount, setVoterCount] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const rankDepth = poll.settings.rankDepth;
  const revealDepth = poll.settings.revealDepth;
  const revealedCount = result?.revealedCount ?? 0;
  const editable = phase === 'poll_closed';

  const startEditing = useCallback(() => {
    setDraft(toDraft(tally ?? []));
    setVoterCount(String(poll.voteCount));
    setEditError(null);
    setEditing(true);
  }, [poll.voteCount, tally]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setDraft(null);
    setEditError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (draft === null) {
      return;
    }
    const entries: Array<{ optionId: string; counts: number[] }> = [];
    for (const [optionId, counts] of Object.entries(draft)) {
      const parsed = counts.map(parseIntegerInput);
      if (parsed.some((value) => value === null)) {
        setEditError('票数は 0 以上の数字で入力してください。');
        return;
      }
      entries.push({ optionId, counts: parsed.map((value) => value ?? 0) });
    }

    const voters = parseIntegerInput(voterCount);
    if (voters === null) {
      setEditError('投票した人数は 0 以上の数字で入力してください。');
      return;
    }

    setEditError(null);
    setSaving(true);
    try {
      await apiPatch<PollTallyResponse>(`/api/rooms/${roomId}/poll-tally`, {
        entries,
        voterCount: voters,
      });
      setEditing(false);
      setDraft(null);
      onChanged();
    } catch (caught) {
      setEditError(toUserErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [draft, onChanged, roomId, voterCount]);

  const handleRecount = useCallback(async () => {
    setEditError(null);
    setSaving(true);
    try {
      await apiPost<PollTallyResponse>(`/api/rooms/${roomId}/poll-tally`, {});
      setEditing(false);
      setDraft(null);
      onChanged();
    } catch (caught) {
      setEditError(toUserErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [onChanged, roomId]);

  const handleClearVotes = useCallback(async () => {
    setClearing(true);
    setEditError(null);
    try {
      await apiDelete<PollVotesClearedResponse>(`/api/rooms/${roomId}/votes`);
      setConfirmClear(false);
      setEditing(false);
      setDraft(null);
      onChanged();
    } catch (caught) {
      setEditError(toUserErrorMessage(caught));
    } finally {
      setClearing(false);
    }
  }, [onChanged, roomId]);

  return (
    <div className="flex flex-col gap-5">
      <Card title="投票の状況">
        <div className="flex flex-wrap items-center gap-4">
          <Badge variant={phase === 'poll_open' ? 'success' : 'neutral'} size="md">
            {phase === 'poll_open' ? '受付中' : phase === 'poll_closed' ? '締切' : '発表'}
          </Badge>
          <p className="text-lg font-bold text-slate-900 tabular-nums">
            投票 {formatRatioCount(poll.voteCount, poll.participantCount)}
          </p>
          <p className="text-sm text-slate-600">
            {rankDepth === 1 ? '1位だけを選ぶ投票' : `${rankDepth}位まで選ぶ投票`}／
            {revealDepth === 1 ? '1位だけ発表' : `${revealDepth}位から順に発表`}
          </p>
        </div>

        {phase === 'poll_open' ? (
          <p className="mt-3 text-sm text-slate-600">
            1台につき1票です。同じ端末から入れ直すことはできません。
            締め切った時点の票を数えて固めます。
          </p>
        ) : null}

        {phase === 'poll_revealing' ? (
          <p className="mt-3 text-sm font-bold text-slate-700">
            {revealComplete(revealDepth, revealedCount)
              ? 'すべて発表しました。'
              : `次は${rankLabel(nextRevealRank(revealDepth, revealedCount))}です。`}
            <span className="ml-2 font-normal text-slate-600">
              発表済み {revealedCount} / {revealDepth}
            </span>
          </p>
        ) : null}

        {phase === 'poll_open' || phase === 'poll_closed' ? (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || poll.voteCount === 0}
              onClick={() => {
                setConfirmClear(true);
              }}
            >
              入っている票をすべて捨てる
            </Button>
            <p className="mt-1 text-xs text-slate-600">
              練習で入れた票を消してから本番を始めるときに使います。元に戻せません。
            </p>
          </div>
        ) : null}
      </Card>

      {editError !== null ? <Alert variant="error">{editError}</Alert> : null}

      {tally !== null && phase !== 'poll_open' ? (
        <Card
          title="集計の確認"
          description={
            editable
              ? '発表の前にここで中身を確かめてください。紙の投票を足したり、明らかな異常値を外したりできます。'
              : '発表を始めたあとは直せません。会場へ出した数字が後から変わると混乱するためです。'
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <caption className="sr-only">投票の集計</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th scope="col" className="px-3 py-2 font-bold">
                    順位
                  </th>
                  <th scope="col" className="px-3 py-2 font-bold">
                    選択肢
                  </th>
                  {Array.from({ length: rankDepth }, (_, index) => (
                    <th
                      key={`head-${String(index)}`}
                      scope="col"
                      className="px-3 py-2 text-right font-bold"
                    >
                      {rankLabel(index + 1)}票
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-bold">
                    点数
                  </th>
                </tr>
              </thead>
              <tbody>
                {tally.map((row) => (
                  <tr key={row.optionId} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-3 py-2 font-bold tabular-nums">
                      {row.rank <= revealDepth ? (
                        <Badge variant={row.rank === 1 ? 'brand' : 'info'}>
                          {rankLabel(row.rank)}
                        </Badge>
                      ) : (
                        <span className="text-slate-500">{rankLabel(row.rank)}</span>
                      )}
                    </td>
                    <th scope="row" className="px-3 py-2 text-left font-bold text-slate-900">
                      {row.label}
                      {row.groupLabel !== null ? (
                        <span className="ml-2 text-xs font-normal text-slate-600">
                          {row.groupLabel}
                        </span>
                      ) : null}
                    </th>
                    {Array.from({ length: rankDepth }, (_, index) => (
                      <td
                        key={`${row.optionId}-${String(index)}`}
                        className="px-3 py-2 text-right tabular-nums"
                      >
                        {editing && draft !== null ? (
                          <TextInput
                            label={
                              <span className="sr-only">{`${row.label}の${rankLabel(index + 1)}票`}</span>
                            }
                            inputMode="numeric"
                            autoComplete="off"
                            className="w-20"
                            inputClassName="text-right"
                            value={draft[row.optionId]?.[index] ?? '0'}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setDraft((previous) => {
                                if (previous === null) {
                                  return previous;
                                }
                                const counts = [...(previous[row.optionId] ?? [])];
                                counts[index] = value;
                                return { ...previous, [row.optionId]: counts };
                              });
                            }}
                          />
                        ) : (
                          (row.counts[index] ?? 0)
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{row.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
            {editing ? (
              <>
                <TextInput
                  label="投票した人数"
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-40"
                  value={voterCount}
                  hint="紙の票を足したときはここも直します。"
                  onChange={(event) => {
                    setVoterCount(event.currentTarget.value);
                  }}
                />
                <Button loading={saving} onClick={() => void handleSave()}>
                  直した票数を反映する
                </Button>
                <Button variant="secondary" disabled={saving} onClick={cancelEditing}>
                  やめる
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" disabled={!editable || busy} onClick={startEditing}>
                  票数を直す
                </Button>
                <Button
                  variant="ghost"
                  disabled={!editable || busy}
                  loading={saving}
                  onClick={() => void handleRecount()}
                >
                  投票の記録から数え直す
                </Button>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-600">
            直すのは票数だけです。点数と順位は票数から計算し直します。
            投票の記録そのものは消さないので、いつでも数え直せます。
          </p>
        </Card>
      ) : null}

      {result !== null && result.entries.length > 0 ? (
        <Card title="発表済みの順位" description="会場のスクリーンに出ているものと同じです。">
          <ol className="flex flex-col gap-2">
            {result.entries.map((entry) => (
              <li key={entry.optionId} className="flex flex-wrap items-center gap-3">
                <Badge variant={entry.rank === 1 ? 'brand' : 'info'} size="md">
                  {rankLabel(entry.rank)}
                </Badge>
                <span className="font-bold text-slate-900">{entry.label}</span>
                {entry.groupLabel !== null ? (
                  <span className="text-sm text-slate-600">{entry.groupLabel}</span>
                ) : null}
                <span className="text-sm text-slate-600 tabular-nums">
                  {entry.score}点／{formatCount(entry.totalVotes, '票')}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {availableActions.includes('reopen_poll') ? (
        <Alert variant="info">
          締切を押し間違えたときは「そのほかの操作」から受付へ戻せます。
          結果発表を始めたあとは戻せません（結果を見てから投票できてしまうため）。
        </Alert>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="入っている票をすべて捨てますか？"
        description={
          <>
            <p>{formatCount(poll.voteCount, '票')}を消します。元に戻せません。</p>
            <p className="mt-2">
              捨てると、同じ端末からもう一度投票できるようになります。
              練習のあと本番を始めるときに使ってください。
            </p>
          </>
        }
        confirmLabel="すべて捨てる"
        busy={clearing}
        onConfirm={() => void handleClearVotes()}
        onCancel={() => {
          setConfirmClear(false);
        }}
      />
    </div>
  );
}
