'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ConnectionStatus } from '@/components/shared/ConnectionStatus';
import { Spinner } from '@/components/shared/Spinner';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { CopyButton } from '@/components/admin/copy-button';
import { HostBreakdownPanel } from '@/components/admin/host-breakdown-panel';
import { JoinUrlPanel } from '@/components/admin/join-url-panel';
import { ParticipantList } from '@/components/admin/participant-list';
import { recallJoinUrl, rememberJoinUrl } from '@/components/admin/join-url-store';
import type { QuestionType } from '@/domain/quiz/question';
import type { StaffSnapshot } from '@/domain/room/snapshot';
import {
  EXTEND_SECONDS_PRESETS,
  ROOM_ACTION_LABELS,
  ROOM_PHASE_LABELS,
  nextStep,
  type RoomAction,
} from '@/domain/room/state-machine';
import { useCountdown } from '@/hooks/use-countdown';
import { useRoomSnapshot } from '@/hooks/use-room-snapshot';
import { apiPost, isApiClientError } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import {
  formatCount,
  formatDateTime,
  formatPoints,
  formatQuestionProgress,
  formatRank,
  formatRatioCount,
  formatRemainingSeconds,
} from '@/lib/format';
import type { PresentationLinkResponse, RotateJoinTokenResponse } from '@/types/api';

/**
 * 司会進行画面。
 *
 * 守っている約束:
 * - ルームコードは存在しない。参加導線は二次元コード（参加URL）だけを案内する。
 * - 表示できる操作は Snapshot の availableActions だけ。処理中はすべて無効化する。
 * - 409 STATE_VERSION_CONFLICT は Snapshot を取り直して再描画する（画面は消さない）。
 * - 回答受付中は「回答済み人数」しか出さない。選択肢別集計・数値の回答値は締切後まで出さない
 *   （サーバーも受付中は breakdown を返さない）。
 * - 通信が切れても画面を保ち、ConnectionStatus で状態だけ伝える。
 * - 効果音はこの画面では鳴らさない（音は投影画面の責務）。
 */

export type HostQuestionOutline = {
  id: string;
  position: number;
  type: QuestionType;
  /** 一覧表示用の短い見出し（問題文の先頭など）。 */
  summary: string;
};

export type HostConsoleProps = {
  roomId: string;
  quizTitle: string;
  outline: readonly HostQuestionOutline[];
};

/** 延長ボタンは秒数ごとに分かれるため、押した 1 つだけを処理中にできるようにする。 */
type ExtendBusyKey = `extend-${number}`;

type BusyKey = RoomAction | ExtendBusyKey | 'join-toggle' | 'rotate' | 'presentation' | null;

export function HostConsole({ roomId, quizTitle, outline }: HostConsoleProps) {
  const { snapshot, error, status, clock, refresh } = useRoomSnapshot<StaffSnapshot>({
    roomId,
    endpoint: `/api/rooms/${roomId}/host-snapshot`,
    audience: 'staff',
  });

  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<PresentationLinkResponse | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);

  useEffect(() => {
    // 平文の参加URLはサーバーに残らない。ルーム作成時に控えた値だけを復元する。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ブラウザ保管からの復元のため
    setJoinUrl(recallJoinUrl(roomId));
  }, [roomId]);

  const countdown = useCountdown(snapshot?.answerDeadlineAt ?? null, clock);

  const phase = snapshot?.phase ?? null;
  const stateVersion = snapshot?.stateVersion ?? null;

  // 締切時刻を過ぎたら締切へ進める（冪等。DB 側がサーバー時刻で判定する）。
  const autoLockedVersionRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== 'question_open' || stateVersion === null) {
      return;
    }
    if (countdown.remainingMs > 0) {
      return;
    }
    if (autoLockedVersionRef.current === stateVersion) {
      return;
    }
    autoLockedVersionRef.current = stateVersion;
    void (async () => {
      try {
        await apiPost(`/api/rooms/${roomId}/lock-if-expired`);
      } catch {
        // 失敗しても「回答を締め切る」から手動で進められる。
      }
      await refresh();
    })();
  }, [countdown.remainingMs, phase, refresh, roomId, stateVersion]);

  const nextQuestion = useMemo(() => {
    const currentPosition = snapshot?.currentQuestionPosition ?? 0;
    return outline.find((question) => question.position === currentPosition + 1) ?? null;
  }, [outline, snapshot?.currentQuestionPosition]);

  /**
   * ふつうの進行で次に押す操作。
   *
   * 司会は本番中に会場を見ながら操作する。毎回ボタンを選ぶのではなく、
   * この 1 つを押し続けるだけで最後まで進めるようにしている。
   */
  const step = useMemo(
    () =>
      snapshot
        ? nextStep({
            phase: snapshot.phase,
            nextQuestionPosition: nextQuestion?.position ?? null,
          })
        : null,
    [nextQuestion?.position, snapshot],
  );

  /**
   * 「進行操作」へ並べる操作。
   *
   * 延長と再開はここへ出さず、それぞれ専用の欄へ出す。
   * 延長は秒数を選ばせる必要があり、再開は「得点が残る」ことを添えないと押しづらいため。
   */
  const inlineActions = useMemo(
    () =>
      (snapshot?.availableActions ?? []).filter(
        (action) => action !== 'extend_deadline' && action !== 'reopen_room',
      ),
    [snapshot?.availableActions],
  );

  const runAction = useCallback(
    async (
      action: RoomAction,
      options: { questionId?: string; extendSeconds?: number; busyKey?: ExtendBusyKey } = {},
    ) => {
      if (!snapshot) {
        return;
      }
      // 延長は秒数ごとにボタンが分かれるため、押した 1 つだけを処理中にする。
      setBusy(options.busyKey ?? action);
      setActionError(null);
      setNotice(null);
      try {
        await apiPost(`/api/rooms/${roomId}/actions`, {
          action,
          ...(options.questionId !== undefined ? { questionId: options.questionId } : {}),
          ...(options.extendSeconds !== undefined ? { extendSeconds: options.extendSeconds } : {}),
          expectedVersion: snapshot.stateVersion,
        });
        await refresh();
      } catch (caught) {
        if (isApiClientError(caught) && caught.code === 'STATE_VERSION_CONFLICT') {
          setNotice('ほかの操作で進行状況が変わっていました。最新の状態に更新しました。');
          await refresh();
        } else {
          setActionError(toUserErrorMessage(caught));
        }
      } finally {
        setBusy(null);
      }
    },
    [refresh, roomId, snapshot],
  );

  const handleToggleJoin = useCallback(
    async (open: boolean) => {
      setBusy('join-toggle');
      setActionError(null);
      try {
        await apiPost(`/api/rooms/${roomId}/${open ? 'open-join' : 'close-join'}`);
        await refresh();
      } catch (caught) {
        setActionError(toUserErrorMessage(caught));
      } finally {
        setBusy(null);
      }
    },
    [refresh, roomId],
  );

  const handleRotateJoinUrl = useCallback(async () => {
    setBusy('rotate');
    setActionError(null);
    try {
      const response = await apiPost<RotateJoinTokenResponse>(
        `/api/rooms/${roomId}/join-token/rotate`,
      );
      // 平文トークンはこの応答でしか得られない。タブ内だけに控える。
      rememberJoinUrl(roomId, response.joinUrl);
      setJoinUrl(response.joinUrl);
      setNotice('参加URLを再発行しました。会場の二次元コードを貼り替えてください。');
      await refresh();
    } catch (caught) {
      setActionError(toUserErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }, [refresh, roomId]);

  const handleIssuePresentationLink = useCallback(async () => {
    setBusy('presentation');
    setActionError(null);
    try {
      const response = await apiPost<PresentationLinkResponse>(
        `/api/rooms/${roomId}/presentation-link`,
      );
      setPresentation(response);
    } catch (caught) {
      setActionError(toUserErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }, [roomId]);

  const openPresentation = useCallback(() => {
    if (!presentation) {
      return;
    }
    window.open(presentation.presentationUrl, '_blank', 'noopener,noreferrer');
  }, [presentation]);

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-4">
        <ConnectionStatus status={status} showWhenConnected />
        {error !== null ? (
          <Alert
            variant="error"
            actions={
              <Button variant="secondary" size="sm" onClick={() => void refresh()}>
                もう一度試す
              </Button>
            }
          >
            {error}
          </Alert>
        ) : (
          <Card>
            <div className="flex items-center gap-3 text-slate-600">
              <Spinner />
              <span>ルームの状態を読み込んでいます</span>
            </div>
          </Card>
        )}
      </div>
    );
  }

  const actionsBusy = busy !== null;
  const isLobby = snapshot.phase === 'lobby';

  // 投影端末は開催中に落ちることがある。待機中に限らず常に再発行できるようにしておく。
  const presentationCard = (
    <Card title="投影画面" description="会場のスクリーンへ映す画面を開きます。">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            loading={busy === 'presentation'}
            disabled={actionsBusy && busy !== 'presentation'}
            onClick={() => void handleIssuePresentationLink()}
          >
            投影用リンクを発行
          </Button>
          <Button variant="primary" disabled={presentation === null} onClick={openPresentation}>
            投影画面を開く
          </Button>
        </div>
        {presentation !== null ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="font-mono text-xs break-all text-slate-800">
              {presentation.presentationUrl}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyButton value={presentation.presentationUrl} label="投影URLをコピー" />
              <span className="text-xs text-slate-600">
                有効期限 {formatDateTime(presentation.expiresAt)}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            投影用リンクは一時的なものです。発行した端末・ブラウザで開いてください。
          </p>
        )}
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col gap-5">
      {/* 状態サマリ */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {/* Snapshot 取得前はサーバー側で解決したタイトルを出し、表示のちらつきを防ぐ。 */}
            <p className="truncate text-lg font-bold text-slate-900">
              {snapshot.quizTitle || quizTitle}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <Badge variant="brand" size="md">
                {ROOM_PHASE_LABELS[snapshot.phase]}
              </Badge>
              <span>
                {snapshot.currentQuestionPosition === null
                  ? `全${snapshot.totalQuestions}問`
                  : formatQuestionProgress(
                      snapshot.currentQuestionPosition,
                      snapshot.totalQuestions,
                    )}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Stat label="参加人数" value={formatCount(snapshot.participantCount)} />
            <Stat label="オンライン" value={formatCount(snapshot.onlineCount)} />
            <ConnectionStatus status={status} showWhenConnected />
          </div>
        </div>
      </Card>

      {notice !== null ? (
        <Alert
          variant="info"
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setNotice(null);
              }}
            >
              閉じる
            </Button>
          }
        >
          {notice}
        </Alert>
      ) : null}
      {actionError !== null ? <Alert variant="error">{actionError}</Alert> : null}
      {error !== null ? (
        <Alert variant="warning" title="最新の状態を取得できませんでした">
          表示は最後に取得できた内容のままです。接続が戻ると自動で更新されます。
        </Alert>
      ) : null}

      {/* 進行操作 */}
      <Card
        title="進行操作"
        description="ふつうはこの大きなボタンを押していくだけで進みます。"
      >
        {step !== null ? (
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              variant={step.action === 'finish_room' ? 'danger' : 'primary'}
              className="min-h-16 w-full text-xl"
              loading={busy === step.action}
              disabled={actionsBusy && busy !== step.action}
              onClick={() => {
                if (step.action === 'finish_room') {
                  setConfirmFinish(true);
                  return;
                }
                void runAction(
                  step.action,
                  step.action === 'show_question' && nextQuestion !== null
                    ? { questionId: nextQuestion.id }
                    : {},
                );
              }}
            >
              {step.label}
            </Button>
            <p className="text-xs text-slate-600">
              いまは「{ROOM_PHASE_LABELS[snapshot.phase]}」です。
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            {snapshot.phase === 'finished'
              ? 'クイズは終了しています。下の「クイズを再開」から続きを再開できます。'
              : '進められる操作がありません。クイズに問題が登録されているか確認してください。'}
          </p>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-bold text-slate-700">
            そのほかの操作
          </summary>
          <div className="mt-3 flex flex-wrap gap-2">
          {inlineActions.length === 0 ? (
            <p className="text-sm text-slate-600">個別に選べる操作はありません。</p>
          ) : null}
          {inlineActions.map((action) => {
            if (action === 'show_question') {
              if (nextQuestion === null) {
                return null;
              }
              return (
                <Button
                  key={action}
                  size="md"
                  variant="secondary"
                  loading={busy === action}
                  disabled={actionsBusy && busy !== action}
                  onClick={() => void runAction('show_question', { questionId: nextQuestion.id })}
                >
                  第{nextQuestion.position}問を表示
                </Button>
              );
            }
            if (action === 'finish_room') {
              return (
                <Button
                  key={action}
                  size="md"
                  variant="danger"
                  disabled={actionsBusy}
                  onClick={() => {
                    setConfirmFinish(true);
                  }}
                >
                  {ROOM_ACTION_LABELS[action]}
                </Button>
              );
            }
            return (
              <Button
                key={action}
                size="md"
                variant="secondary"
                loading={busy === action}
                disabled={actionsBusy && busy !== action}
                onClick={() => void runAction(action)}
              >
                {ROOM_ACTION_LABELS[action]}
              </Button>
            );
          })}
          </div>
        </details>

        {snapshot.phase === 'question_open' ? (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-lg font-bold text-slate-900 tabular-nums">
                {formatRemainingSeconds(countdown.remainingSeconds)}
              </p>
              <p className="text-sm font-bold text-slate-700">
                回答済み {formatRatioCount(snapshot.answeredCount, snapshot.participantCount)}
              </p>
              <p className="text-xs text-slate-600">
                締切はサーバー時刻で判定します。集計は締切後に表示されます。
              </p>
            </div>

            {snapshot.availableActions.includes('extend_deadline') ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
                <span className="text-sm font-bold text-slate-700">回答時間を延長</span>
                {EXTEND_SECONDS_PRESETS.map((seconds) => (
                  <Button
                    key={seconds}
                    size="sm"
                    variant="secondary"
                    loading={busy === `extend-${seconds}`}
                    disabled={actionsBusy && busy !== `extend-${seconds}`}
                    onClick={() =>
                      void runAction('extend_deadline', {
                        extendSeconds: seconds,
                        busyKey: `extend-${seconds}`,
                      })
                    }
                  >
                    +{seconds}秒
                  </Button>
                ))}
                <span className="text-xs text-slate-600">
                  締切を過ぎていた場合は、押した時点からその秒数だけ受け付けます。
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {snapshot.phase === 'question_locked' ? (
          <p className="mt-4 text-sm font-bold text-slate-700">
            回答済み {formatRatioCount(snapshot.answeredCount, snapshot.participantCount)}
            <span className="ml-2 font-normal text-slate-600">
              — 「正解を発表」で集計と正解を表示します。
            </span>
          </p>
        ) : null}
      </Card>

      {/* 待機中の準備 */}
      {isLobby ? (
        <>
          <Card
            title="参加用の二次元コード"
            description="会場のスクリーンや掲示物に提示してください。参加はこの二次元コードの読み取りだけで完了します。"
          >
            <JoinUrlPanel
              joinUrl={joinUrl}
              qrSize={260}
              rotating={busy === 'rotate'}
              onRotate={() => void handleRotateJoinUrl()}
            />
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title="参加受付"
              description={
                snapshot.joinOpen
                  ? '現在は参加を受け付けています。'
                  : '現在は参加を締め切っています。'
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={snapshot.joinOpen ? 'success' : 'warning'} size="md">
                  {snapshot.joinOpen ? '受付中' : '締切中'}
                </Badge>
                <Button
                  variant={snapshot.joinOpen ? 'secondary' : 'primary'}
                  loading={busy === 'join-toggle'}
                  disabled={actionsBusy && busy !== 'join-toggle'}
                  onClick={() => void handleToggleJoin(!snapshot.joinOpen)}
                >
                  {snapshot.joinOpen ? '参加受付を締め切る' : '参加受付を再開する'}
                </Button>
              </div>
              <p className="mt-3 text-sm text-slate-600">
                締め切っても、すでに参加している人はそのまま回答できます。
              </p>
            </Card>

            {presentationCard}
          </div>

          <Card
            title="参加者一覧"
            description={`${formatCount(snapshot.participantCount)}（オンライン ${formatCount(
              snapshot.onlineCount,
            )}）`}
          >
            <ParticipantList participants={snapshot.participants ?? []} />
          </Card>

          <Card title="このクイズの問題">
            {outline.length === 0 ? (
              <p className="text-sm text-slate-600">問題がありません。</p>
            ) : (
              <ol className="flex flex-col gap-1 text-sm">
                {outline.map((question) => (
                  <li key={question.id} className="flex items-start gap-2 py-1">
                    <Badge>{`第${question.position}問`}</Badge>
                    <span className="text-slate-500">
                      {question.type === 'choice' ? '選択式' : '数値式'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-slate-800">
                      {question.summary}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      ) : null}

      {/* 進行中の詳細 */}
      {!isLobby && snapshot.currentQuestion !== null ? (
        <Card
          title={`第${snapshot.currentQuestionPosition ?? 0}問`}
          description={snapshot.currentQuestion.type === 'choice' ? '選択式' : '数値式'}
        >
          <p className="text-base leading-relaxed font-bold text-slate-900">
            {snapshot.currentQuestion.text ?? '（画像の問題）'}
          </p>
          {snapshot.currentQuestion.type === 'choice' ? (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-slate-800">
              {snapshot.currentQuestion.choices.map((choice) => (
                <li key={choice.id} className="flex items-start gap-2">
                  <Badge
                    variant={snapshot.reveal?.correctChoiceId === choice.id ? 'success' : 'neutral'}
                  >
                    {choice.label}
                  </Badge>
                  <span>{choice.text ?? '（画像の選択肢）'}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {!isLobby ? presentationCard : null}

      {!isLobby ? (
        <Card title="回答の集計">
          <HostBreakdownPanel
            breakdown={snapshot.breakdown}
            reveal={snapshot.reveal}
            question={snapshot.currentQuestion}
          />
        </Card>
      ) : null}

      {snapshot.reveal !== null ? (
        <Card title="正解・解説">
          {snapshot.reveal.answerRuleDisplay !== null ? (
            <p className="text-base font-bold text-slate-900">
              正解: {snapshot.reveal.answerRuleDisplay}
            </p>
          ) : null}
          {snapshot.reveal.explanation !== null ? (
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
              {snapshot.reveal.explanation}
            </p>
          ) : null}
          {snapshot.reveal.revealImage !== null ? (
            // next/image は署名付き外部 URL の設定が要るため、司会画面では素の img を使う。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={snapshot.reveal.revealImage.url}
              alt={snapshot.reveal.revealImage.alt}
              width={snapshot.reveal.revealImage.width}
              height={snapshot.reveal.revealImage.height}
              className="mt-3 block h-auto max-h-64 w-auto max-w-full rounded-xl border border-slate-200"
            />
          ) : null}
        </Card>
      ) : null}

      {snapshot.leaderboard !== null && snapshot.leaderboard.length > 0 ? (
        <Card title="ランキング">
          <ol className="flex flex-col gap-1 text-sm">
            {snapshot.leaderboard.map((entry) => (
              <li
                key={entry.participantId}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 odd:bg-slate-50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Badge variant={entry.rank <= 3 ? 'brand' : 'neutral'}>
                    {formatRank(entry.rank)}
                  </Badge>
                  <span className="truncate font-bold text-slate-900">{entry.nickname}</span>
                </span>
                <span className="shrink-0 font-bold text-slate-700 tabular-nums">
                  {formatPoints(entry.totalPoints)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {snapshot.phase === 'finished' ? (
        <Card title="クイズは終了しました">
          <p className="text-sm text-slate-700">お疲れさまでした。</p>
          <p className="mt-3 text-sm text-slate-700">
            誤って終了した場合や続きを行う場合は、ここから再開できます。
            <strong className="font-bold">得点と回答はそのまま残ります。</strong>
            参加者は同じ二次元コードのまま戻ってこられます。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              loading={busy === 'reopen_room'}
              disabled={actionsBusy && busy !== 'reopen_room'}
              onClick={() => void runAction('reopen_room')}
            >
              {ROOM_ACTION_LABELS.reopen_room}
            </Button>
            <Link href="/admin/rooms" className="text-brand-700 font-bold hover:underline">
              ルーム一覧へ
            </Link>
            <Link href="/admin/quizzes" className="text-brand-700 font-bold hover:underline">
              クイズ一覧へ戻る
            </Link>
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmFinish}
        title="クイズを終了しますか？"
        description={
          <>
            <p>終了すると出題を続けられなくなり、参加者の画面は結果表示へ切り替わります。</p>
            <p className="mt-2">
              終了したあとでも、この画面の「クイズを再開」から続きを再開できます（得点は残ります）。
            </p>
          </>
        }
        confirmLabel="終了する"
        busy={busy === 'finish_room'}
        onConfirm={() => {
          setConfirmFinish(false);
          void runAction('finish_room');
        }}
        onCancel={() => {
          setConfirmFinish(false);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <p className="rounded-xl border border-slate-200 px-3 py-1.5 text-center">
      <span className="block text-xs font-bold text-slate-600">{label}</span>
      <span className="block text-lg font-bold text-slate-900 tabular-nums">{value}</span>
    </p>
  );
}
