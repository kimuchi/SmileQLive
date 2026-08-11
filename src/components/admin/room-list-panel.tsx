'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { Spinner } from '@/components/shared/Spinner';
import { apiGet } from '@/lib/client/api-client';
import { formatCount, formatShortDateTime } from '@/lib/format';
import type { RoomListItem, RoomListResponse } from '@/types/api';

/**
 * 作成したルームの一覧。
 *
 * 司会画面（/host/[roomId]）へ戻る唯一の導線。
 * これが無いと、ルーム作成直後の画面を離れた時点で進行に戻れなくなる。
 * 操作できるのは作成した本人だけなので、一覧も自分の分だけが返る。
 */

const PHASE_LABEL: Record<RoomListItem['phase'], string> = {
  lobby: '受付中',
  question_ready: '出題準備',
  question_open: '出題中',
  question_locked: '締切',
  answer_revealed: '正解発表',
  scoreboard: '途中経過',
  finished: '終了',
};

const PHASE_VARIANT: Record<RoomListItem['phase'], BadgeVariant> = {
  lobby: 'info',
  question_ready: 'info',
  question_open: 'brand',
  question_locked: 'warning',
  answer_revealed: 'success',
  scoreboard: 'brand',
  finished: 'neutral',
};

export function RoomListPanel() {
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await apiGet<RoomListResponse>('/api/admin/rooms');
      setRooms(response.rooms);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    // マウント時の初回取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  if (error !== null) {
    return <ErrorMessage error={error} onRetry={() => void load()} />;
  }

  if (rooms === null) {
    return <Spinner label="読み込んでいます" />;
  }

  if (rooms.length === 0) {
    return (
      <Card title="ルームがありません">
        <p className="text-sm text-slate-600">
          クイズ一覧から「ルーム作成」を選ぶと、参加用の二次元コードが表示されます。
        </p>
        <div className="mt-4">
          <Link
            href="/admin/rooms/new"
            className="text-brand-700 font-bold hover:underline"
          >
            ルームを作成する
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="作成したルーム"
      description="司会画面を開き直せます。操作できるのは作成した本人だけです。"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-160 border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-600">
              <th scope="col" className="px-4 py-2 font-bold">
                クイズ
              </th>
              <th scope="col" className="px-4 py-2 font-bold">
                状態
              </th>
              <th scope="col" className="px-4 py-2 text-right font-bold">
                参加者
              </th>
              <th scope="col" className="px-4 py-2 font-bold">
                作成日時
              </th>
              <th scope="col" className="px-4 py-2 font-bold">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => (
              <tr key={room.id} className="border-b border-slate-100 last:border-b-0">
                <th scope="row" className="px-4 py-3 text-left font-bold text-slate-900">
                  {room.quizTitle}
                </th>
                <td className="px-4 py-3">
                  <Badge variant={PHASE_VARIANT[room.phase]}>{PHASE_LABEL[room.phase]}</Badge>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatCount(room.participantCount, '人')}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {formatShortDateTime(room.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <Link href={`/host/${room.id}`}>
                    <Button variant="primary" size="sm">
                      司会画面を開く
                    </Button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
