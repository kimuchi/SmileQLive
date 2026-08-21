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
import { DRAW_LIST_KIND_LABELS, type DrawListKind } from '@/domain/draw/draw-list';
import { apiDelete, apiGet } from '@/lib/client/api-client';
import { formatCount, formatShortDateTime } from '@/lib/format';
import type { DrawListsResponse } from '@/types/api';

/**
 * 抽選リスト一覧。
 *
 * 一覧・削除はすべて同一オリジンの管理 API を通す。
 * 所有者の絞り込みはサーバー側で行うため、ここでは owner を送らない。
 */

/** 一覧の 1 行。応答の型をそのまま使い、同じ形を二度書かない。 */
type DrawListRow = DrawListsResponse['lists'][number];

const KIND_VARIANT: Record<DrawListKind, BadgeVariant> = {
  name: 'info',
  number: 'brand',
  item: 'success',
};

type PendingAction = { kind: 'delete'; list: DrawListRow } | null;

export function DrawListPanel() {
  const router = useRouter();
  const [lists, setLists] = useState<DrawListRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyListId, setBusyListId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  // 同期的な setState を含めない（effect から呼ぶため）。
  // 取得中は前回のエラー表示を残し、成功した時点で消す。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<DrawListsResponse>('/api/admin/draw-lists');
      setLists(response.lists);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    // マウント時の初回取得。load は依存が空で安定しており、
    // 成功／失敗のどちらでも 1 回だけ state を更新して終わるため再取得ループにならない。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  const handleDelete = useCallback(async () => {
    if (pending?.kind !== 'delete') {
      return;
    }
    const listId = pending.list.id;
    setBusyListId(listId);
    setError(null);
    try {
      await apiDelete(`/api/admin/draw-lists/${listId}`);
      setPending(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyListId(null);
    }
  }, [load, pending]);

  if (lists === null) {
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

      {lists.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-700">
            まだ抽選リストがありません。「抽選リストを新規作成」から始めてください。
          </p>
          <p className="mt-2 text-sm text-slate-600">
            表計算ソフトの名簿は、リストを作ったあとに範囲をコピーして貼り付けられます。
          </p>
        </Card>
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <caption className="sr-only">作成済み抽選リストの一覧</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th scope="col" className="px-4 py-3 font-bold">
                    名前
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    種類
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    件数
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
                {lists.map((list) => {
                  const busy = busyListId === list.id;
                  return (
                    <tr key={list.id} className="border-b border-slate-100 last:border-b-0">
                      <th scope="row" className="px-4 py-3 text-left font-bold text-slate-900">
                        <Link
                          href={`/admin/draw-lists/${list.id}/edit`}
                          className="focus-visible:outline-brand-600 rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {list.title}
                        </Link>
                      </th>
                      <td className="px-4 py-3">
                        <Badge variant={KIND_VARIANT[list.kind]}>
                          {DRAW_LIST_KIND_LABELS[list.kind]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(list.entryCount, '件')}
                        {list.kind === 'number' &&
                        list.numberMin !== null &&
                        list.numberMax !== null ? (
                          <span className="mt-0.5 block text-xs font-normal text-slate-600">
                            {list.numberMin}〜{list.numberMax}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                        {formatShortDateTime(list.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              router.push(`/admin/draw-lists/${list.id}/edit`);
                            }}
                          >
                            編集
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busy}
                            onClick={() => {
                              setPending({ kind: 'delete', list });
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
        title="この抽選リストを削除しますか？"
        description={
          <>
            <p>
              「{pending?.list.title ?? ''}」と、その中身
              {formatCount(pending?.list.entryCount ?? 0, '件')}を消します。元に戻せません。
            </p>
            <p className="mt-2">
              作成済みのルームには影響しません（ルームには作成した時点の中身が入っています）。
            </p>
          </>
        }
        confirmLabel="削除する"
        busy={busyListId !== null && busyListId === pending?.list.id}
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          setPending(null);
        }}
      />
    </div>
  );
}
