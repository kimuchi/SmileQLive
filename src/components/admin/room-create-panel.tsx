'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { Select } from '@/components/shared/Select';
import { Spinner } from '@/components/shared/Spinner';
import { TextInput } from '@/components/shared/TextInput';
import { JoinUrlPanel } from '@/components/admin/join-url-panel';
import { rememberJoinUrl } from '@/components/admin/join-url-store';
import { apiGet, apiPost } from '@/lib/client/api-client';
import { formatCount } from '@/lib/format';
import type { CreateRoomResponse, QuizListItem, QuizListResponse } from '@/types/api';

/**
 * ルーム作成。
 *
 * - 公開済みクイズだけを選べる（下書き・アーカイブはサーバー側でも弾かれる）。
 * - 作成直後にだけ平文の参加 URL が返る。ここで二次元コードを表示し、
 *   sessionStorage へ一時保管して司会画面へ引き継ぐ。
 * - ルームコードは発行しない。参加は二次元コードの URL 直行のみ。
 */

const MAX_PARTICIPANTS_MIN = 2;
const MAX_PARTICIPANTS_MAX = 1000;
const MAX_PARTICIPANTS_DEFAULT = '200';

export type RoomCreatePanelProps = {
  /** クイズ一覧から遷移してきたときの初期選択。 */
  initialQuizId: string | null;
};

export function RoomCreatePanel({ initialQuizId }: RoomCreatePanelProps) {
  const [quizzes, setQuizzes] = useState<QuizListItem[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selectedQuizId, setSelectedQuizId] = useState(initialQuizId ?? '');
  const [maxParticipants, setMaxParticipants] = useState(MAX_PARTICIPANTS_DEFAULT);
  const [maxParticipantsError, setMaxParticipantsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [created, setCreated] = useState<CreateRoomResponse | null>(null);

  // 同期的な setState を含めない（effect から呼ぶため）。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<QuizListResponse>('/api/admin/quizzes');
      setQuizzes(response.quizzes);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    // マウント時の初回取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  const publishedQuizzes = useMemo(
    () => (quizzes ?? []).filter((quiz) => quiz.status === 'published'),
    [quizzes],
  );

  const options = useMemo(
    () =>
      publishedQuizzes.map((quiz) => ({
        value: quiz.id,
        label: `${quiz.title}（${formatCount(quiz.questionCount, '問')}）`,
      })),
    [publishedQuizzes],
  );

  const handleCreate = useCallback(async () => {
    if (selectedQuizId.length === 0) {
      setCreateError('クイズを選んでください');
      return;
    }
    const normalized = maxParticipants.normalize('NFKC').trim();
    if (!/^\d+$/.test(normalized)) {
      setMaxParticipantsError('人数を数字で入力してください');
      return;
    }
    const parsed = Number.parseInt(normalized, 10);
    if (parsed < MAX_PARTICIPANTS_MIN || parsed > MAX_PARTICIPANTS_MAX) {
      setMaxParticipantsError(
        `参加人数の上限は${MAX_PARTICIPANTS_MIN}〜${MAX_PARTICIPANTS_MAX}で入力してください`,
      );
      return;
    }

    setMaxParticipantsError(null);
    setCreateError(null);
    setCreating(true);
    try {
      const response = await apiPost<CreateRoomResponse>('/api/rooms', {
        quizId: selectedQuizId,
        maxParticipants: parsed,
      });
      // 平文トークンはここでしか手に入らない。司会画面へ引き継ぐため一時保管する。
      rememberJoinUrl(response.roomId, response.joinUrl);
      setCreated(response);
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(false);
    }
  }, [maxParticipants, selectedQuizId]);

  if (created !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success" title="ルームを作成しました">
          「{created.quizTitle}」の進行を始められます。
        </Alert>

        <Card
          title="参加用の二次元コード"
          description="会場のスクリーンや掲示物でこの二次元コードを提示してください。"
        >
          <JoinUrlPanel joinUrl={created.joinUrl} qrSize={280} />
        </Card>

        <Card title="次の操作">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/host/${created.roomId}`}
              className="bg-brand-600 hover:bg-brand-700 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl px-5 text-base font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              司会画面を開く
            </Link>
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              クイズ一覧へ戻る
            </Link>
          </div>
          <p className="mt-3 text-sm text-slate-600">
            参加URLはこの画面を離れると再表示できません。必要なら今のうちにコピーしてください
            （失った場合は司会画面から再発行できます）。
          </p>
        </Card>
      </div>
    );
  }

  if (quizzes === null) {
    return (
      <Card>
        {loadError !== null ? (
          <ErrorMessage error={loadError} onRetry={() => void load()} />
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
      {loadError !== null ? <ErrorMessage error={loadError} onRetry={() => void load()} /> : null}
      {createError !== null ? <ErrorMessage error={createError} /> : null}

      {publishedQuizzes.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-700">
            公開済みのクイズがありません。クイズを編集して公開してからルームを作成してください。
          </p>
          <p className="mt-3">
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              クイズ一覧へ
            </Link>
          </p>
        </Card>
      ) : (
        <Card title="ルームの設定">
          <div className="flex flex-col gap-4">
            <Select
              label="使用するクイズ"
              required
              placeholder="クイズを選んでください"
              options={options}
              value={selectedQuizId}
              onChange={(event) => {
                setSelectedQuizId(event.currentTarget.value);
              }}
            />

            <TextInput
              label="参加人数の上限"
              inputMode="numeric"
              autoComplete="off"
              value={maxParticipants}
              error={maxParticipantsError ?? undefined}
              hint={`${MAX_PARTICIPANTS_MIN}〜${MAX_PARTICIPANTS_MAX}人。上限に達すると新しい参加を受け付けません。`}
              onChange={(event) => {
                setMaxParticipants(event.currentTarget.value);
                if (maxParticipantsError !== null) {
                  setMaxParticipantsError(null);
                }
              }}
            />

            <div>
              <Button size="lg" loading={creating} onClick={() => void handleCreate()}>
                ルームを作成する
              </Button>
              <p className="mt-2 text-xs text-slate-600">
                作成すると参加用の二次元コードが表示されます。
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
