'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { Spinner } from '@/components/shared/Spinner';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { BALLOT_STRUCTURE_LABELS, type BallotStructure } from '@/domain/poll/ballot';
import { apiDelete, apiGet } from '@/lib/client/api-client';
import { formatCount, formatShortDateTime } from '@/lib/format';
import type { PollBallotsResponse } from '@/types/api';

/**
 * 投票用紙の一覧。
 *
 * 一覧・削除はすべて同一オリジンの管理 API を通す。
 * 所有者の絞り込みはサーバー側で行うため、ここでは owner を送らない。
 */

/** 一覧の 1 行。応答の型をそのまま使い、同じ形を二度書かない。 */
type BallotRow = PollBallotsResponse['ballots'][number];

const STRUCTURE_VARIANT: Record<BallotStructure, BadgeVariant> = {
  flat: 'info',
  nested: 'brand',
};

type PendingAction = { kind: 'delete'; ballot: BallotRow } | null;

export function PollBallotPanel() {
  const router = useRouter();
  const [ballots, setBallots] = useState<BallotRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyBallotId, setBusyBallotId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  // 同期的な setState を含めない（effect から呼ぶため）。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<PollBallotsResponse>('/api/admin/poll-ballots');
      setBallots(response.ballots);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  const handleDelete = useCallback(async () => {
    if (pending?.kind !== 'delete') {
      return;
    }
    const ballotId = pending.ballot.id;
    setBusyBallotId(ballotId);
    setError(null);
    try {
      await apiDelete(`/api/admin/poll-ballots/${ballotId}`);
      setPending(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyBallotId(null);
    }
  }, [load, pending]);

  if (ballots === null) {
    return (
      <Card>
        {error !== null ? (
          <ErrorMessage error={error} onRetry={() => void load()} />
        ) : (
          <div className="flex items-center gap-3 text-slate-600">
            <Spinner />
            <span>読み込んでいます</span>
          </div>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error !== null ? <ErrorMessage error={error} onRetry={() => void load()} /> : null}

      {ballots.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-700">
            まだ投票用紙がありません。「投票用紙を新規作成」から始めてください。
          </p>
          <p className="mt-2 text-sm text-slate-600">
            出し物コンテストや、いちばん良かった発表を選ぶ場面で使えます。
          </p>
        </Card>
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <caption className="sr-only">作成済み投票用紙の一覧</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th scope="col" className="px-4 py-3 font-bold">
                    名前
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    選び方
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    選択肢
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    何位まで選ぶか
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    更新日時
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {ballots.map((ballot) => {
                  const busy = busyBallotId === ballot.id;
                  return (
                    <tr key={ballot.id} className="border-b border-slate-100 last:border-b-0">
                      <th scope="row" className="px-4 py-3 text-left font-bold text-slate-900">
                        <Link
                          href={`/admin/poll-ballots/${ballot.id}/edit`}
                          className="focus-visible:outline-brand-600 rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {ballot.title}
                        </Link>
                      </th>
                      <td className="px-4 py-3">
                        <Badge variant={STRUCTURE_VARIANT[ballot.structure]}>
                          {BALLOT_STRUCTURE_LABELS[ballot.structure]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(ballot.optionCount, '件')}
                        {ballot.structure === 'nested' ? (
                          <span className="mt-0.5 block text-xs font-normal text-slate-600">
                            区分 {formatCount(ballot.groupCount, '件')}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{ballot.rankDepth}位まで</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                        {formatShortDateTime(ballot.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              router.push(`/admin/poll-ballots/${ballot.id}/edit`);
                            }}
                          >
                            編集
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy}
                            onClick={() => {
                              setPending({ kind: 'delete', ballot });
                            }}
                          >
                            削除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title="この投票用紙を削除しますか？"
        description={
          <>
            <p>
              「{pending?.ballot.title ?? ''}」と、その選択肢
              {formatCount(pending?.ballot.optionCount ?? 0, '件')}を消します。元に戻せません。
            </p>
            <p className="mt-2">
              作成済みのルームには影響しません（ルームには作成した時点の内容が入っています）。
            </p>
          </>
        }
        confirmLabel="削除する"
        busy={busyBallotId !== null && busyBallotId === pending?.ballot.id}
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          setPending(null);
        }}
      />
    </div>
  );
}
