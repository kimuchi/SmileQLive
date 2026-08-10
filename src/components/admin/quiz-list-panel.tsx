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
import { apiDelete, apiGet, apiPost } from '@/lib/client/api-client';
import { formatCount, formatShortDateTime } from '@/lib/format';
import type { QuizDetailResponse, QuizListItem, QuizListResponse } from '@/types/api';

/**
 * クイズ一覧。
 *
 * 一覧・複製・アーカイブはすべて同一オリジンの管理 API を通す。
 * 所有者の絞り込みはサーバー側で行うため、ここでは owner を送らない。
 */

const STATUS_LABEL: Record<QuizListItem['status'], string> = {
  draft: '下書き',
  published: '公開済み',
  archived: 'アーカイブ',
};

const STATUS_VARIANT: Record<QuizListItem['status'], BadgeVariant> = {
  draft: 'neutral',
  published: 'success',
  archived: 'warning',
};

type PendingAction = { kind: 'archive'; quiz: QuizListItem } | null;

export function QuizListPanel() {
  const router = useRouter();
  const [quizzes, setQuizzes] = useState<QuizListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyQuizId, setBusyQuizId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  // 同期的な setState を含めない（effect から呼ぶため）。
  // 取得中は前回のエラー表示を残し、成功した時点で消す。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<QuizListResponse>('/api/admin/quizzes');
      setQuizzes(response.quizzes);
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

  const handleDuplicate = useCallback(
    async (quiz: QuizListItem) => {
      setBusyQuizId(quiz.id);
      setError(null);
      try {
        const response = await apiPost<QuizDetailResponse>(
          `/api/admin/quizzes/${quiz.id}/duplicate`,
        );
        router.push(`/admin/quizzes/${response.quiz.id}/edit`);
      } catch (caught) {
        setError(caught);
        setBusyQuizId(null);
      }
    },
    [router],
  );

  const handleArchive = useCallback(async () => {
    if (pending?.kind !== 'archive') {
      return;
    }
    const quizId = pending.quiz.id;
    setBusyQuizId(quizId);
    setError(null);
    try {
      await apiDelete(`/api/admin/quizzes/${quizId}`);
      setPending(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusyQuizId(null);
    }
  }, [load, pending]);

  if (quizzes === null) {
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

      {quizzes.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-700">
            まだクイズがありません。「クイズを新規作成」から始めてください。
          </p>
        </Card>
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <caption className="sr-only">作成済みクイズの一覧</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th scope="col" className="px-4 py-3 font-bold">
                    タイトル
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    問題数
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    選択式
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    数値式
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    状態
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
                {quizzes.map((quiz) => {
                  const busy = busyQuizId === quiz.id;
                  return (
                    <tr key={quiz.id} className="border-b border-slate-100 last:border-b-0">
                      <th scope="row" className="px-4 py-3 text-left font-bold text-slate-900">
                        <Link
                          href={`/admin/quizzes/${quiz.id}/edit`}
                          className="focus-visible:outline-brand-600 rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {quiz.title}
                        </Link>
                        {quiz.description !== null && quiz.description.length > 0 ? (
                          <span className="mt-0.5 block text-xs font-normal text-slate-600">
                            {quiz.description}
                          </span>
                        ) : null}
                      </th>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(quiz.questionCount, '問')}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(quiz.choiceQuestionCount, '問')}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCount(quiz.numberQuestionCount, '問')}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_VARIANT[quiz.status]}>
                          {STATUS_LABEL[quiz.status]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                        {formatShortDateTime(quiz.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              router.push(`/admin/quizzes/${quiz.id}/edit`);
                            }}
                          >
                            編集
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={busy}
                            onClick={() => void handleDuplicate(quiz)}
                          >
                            複製
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={quiz.status !== 'published'}
                            title={
                              quiz.status === 'published'
                                ? undefined
                                : '公開済みのクイズだけルームを作成できます'
                            }
                            onClick={() => {
                              router.push(`/admin/rooms/new?quizId=${quiz.id}`);
                            }}
                          >
                            ルーム作成
                          </Button>
                          {quiz.status === 'archived' ? null : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setPending({ kind: 'archive', quiz });
                              }}
                            >
                              アーカイブ
                            </Button>
                          )}
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
        open={pending?.kind === 'archive'}
        title="クイズをアーカイブしますか？"
        description={
          <>
            <p>
              「{pending?.quiz.title ?? ''}」を一覧から下げます。開催中のルームには影響しません。
            </p>
            <p className="mt-2">アーカイブしたクイズからは新しいルームを作成できません。</p>
          </>
        }
        confirmLabel="アーカイブする"
        busy={busyQuizId !== null && busyQuizId === pending?.quiz.id}
        onConfirm={() => void handleArchive()}
        onCancel={() => {
          setPending(null);
        }}
      />
    </div>
  );
}
