'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ConnectionStatus } from '@/components/shared/ConnectionStatus';
import { Spinner } from '@/components/shared/Spinner';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { CopyButton } from '@/components/admin/copy-button';
import { HostBreakdownPanel } from '@/components/admin/host-breakdown-panel';
import { HostDrawPanel } from '@/components/admin/host-draw-panel';
import { HostPollPanel } from '@/components/admin/host-poll-panel';
import { JoinUrlPanel } from '@/components/admin/join-url-panel';
import { ParticipantList } from '@/components/admin/participant-list';
import { recallJoinUrl, rememberJoinUrl } from '@/components/admin/join-url-store';
import { drawUnit } from '@/domain/draw/draw-stage';
import type { QuestionType } from '@/domain/quiz/question';
import { ROOM_MODE_LABELS, isDrawMode, isPollMode } from '@/domain/room/room-mode';
import type { StaffSnapshot } from '@/domain/room/snapshot';
import {
  EXTEND_SECONDS_PRESETS,
  ROOM_PHASE_LABELS,
  isRoomAction,
  nextStep,
  roomActionLabel,
  type RoomAction,
} from '@/domain/room/state-machine';
import { useCountdown } from '@/hooks/use-countdown';
import { useExpiryLock } from '@/hooks/use-expiry-lock';
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
 * クイズ・抽選会・ビンゴ・ルーレット・投票の 5 モードを 1 つの画面で扱う。
 * 抽選会・ビンゴには参加者も問題も無いため、クイズ用の表示
 * （問題一覧・回答済み人数・集計・参加者一覧・参加URL）は出さず、
 * 抽選の操作（host-draw-panel.tsx）へ置き換える。
 * 投票には参加者が来るので参加URLは出し、問題まわりを投票の操作
 * （host-poll-panel.tsx）へ置き換える。
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

type BusyKey =
  RoomAction | ExtendBusyKey | 'join-toggle' | 'rotate' | 'presentation' | 'draw-history' | null;

export function HostConsole({ roomId, quizTitle, outline }: HostConsoleProps) {
  const { snapshot, error, status, clock, refresh } = useRoomSnapshot<StaffSnapshot>({
    roomId,
    endpoint: `/api/rooms/${roomId}/host-snapshot`,
    audience: 'staff',
  });

  /** 再発行したときの参加 URL。ふだんは Snapshot が返す値を使う。 */
  const [rotatedJoinUrl, setRotatedJoinUrl] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<PresentationLinkResponse | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);

  useEffect(() => {
    // 平文を保存する前に作られた古いルームでは Snapshot が参加 URL を返さない。
    // その場合だけ、ルーム作成時にこの端末へ控えた値を使う。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ブラウザ保管からの復元のため
    setRotatedJoinUrl(recallJoinUrl(roomId));
  }, [roomId]);

  const countdown = useCountdown(snapshot?.answerDeadlineAt ?? null, clock);

  const phase = snapshot?.phase ?? null;
  const stateVersion = snapshot?.stateVersion ?? null;

  // 締切時刻を過ぎたら締切へ進める（冪等。DB 側がサーバー時刻で判定する）。
  // 投影画面と同じ仕組みを使う。司会画面だけを開いていても自動で締め切られる。
  const handleLocked = useCallback(() => {
    void refresh();
  }, [refresh]);

  useExpiryLock({
    roomId,
    phase: phase ?? '',
    stateVersion,
    // 締切時刻が届いてから 0 になったときだけ。未取得のうちは false。
    // 締切時刻に対して計算済みのときだけ「時間切れ」と見なす。
    expired: countdown.ready && countdown.remainingMs <= 0,
    onLocked: handleLocked,
  });

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
            mode: snapshot.mode,
            nextQuestionPosition: nextQuestion?.position ?? null,
            remainingDrawCount: snapshot.draw?.remainingCount ?? 0,
            // 選択肢の数で頭打ちにした値（サーバーが入れている）。
            revealDepth:
              snapshot.pollResult?.revealDepth ?? snapshot.poll?.settings.revealDepth ?? 1,
            revealedCount: snapshot.pollResult?.revealedCount ?? 0,
          })
        : null,
    [nextQuestion?.position, snapshot],
  );

  /**
   * 「進行操作」へ並べる操作。
   *
   * 延長・受付再開・クイズ再開はここへ出さず、それぞれ専用の欄へ出す。
   * 延長と受付再開は秒数を選ばせる必要があり、
   * クイズ再開は「得点が残る」ことを添えないと押しづらいため。
   */
  const inlineActions = useMemo(
    () =>
      (snapshot?.availableActions ?? []).filter(
        (action) =>
          action !== 'extend_deadline' && action !== 'reopen_room' && action !== 'reopen_question',
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

  /**
   * 抽選の操作。
   *
   * 進行 API はクイズと同じ。問題も秒数も伴わないので、そのまま action だけを送る。
   * 確認ダイアログは host-draw-panel 側が出す（何が消えるかは向こうしか知らない）。
   */
  const handleDrawAction = useCallback(
    (action: RoomAction) => {
      void runAction(action);
    },
    [runAction],
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

  /**
   * 投影画面へ「出たもの一覧」を出す／しまう。
   *
   * 投影担当は別の端末にいることが多い。司会から切り替えられないと、
   * 「一覧を出して」と口で頼むことになり、会場では伝わらない。
   */
  const handleToggleDrawHistory = useCallback(
    async (open: boolean) => {
      setBusy('draw-history');
      setActionError(null);
      try {
        await apiPost(`/api/rooms/${roomId}/draw-history`, { open });
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
      setRotatedJoinUrl(response.joinUrl);
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
  // 抽選会・ビンゴには参加者も問題も無い。クイズ用の表示をまとめて外すための判定。
  const isDraw = isDrawMode(snapshot.mode);
  const isPoll = isPollMode(snapshot.mode);
  const draw = snapshot.draw;
  const poll = snapshot.poll;

  // 投影端末は開催中に落ちることがある。待機中に限らず常に再発行できるようにしておく。
  const presentationCard = (
    <Card
      title="投影画面"
      description="会場のスクリーンへ映す画面を開きます。リンクはそのまま人に渡せます。"
    >
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
            投影用リンクを発行すると、そのURLを別の端末や別の人へ渡せます。
            渡された人はログイン無しで同じ投影画面を開けます（何人でも開けます）。
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
              {isDraw || isPoll ? (
                // 抽選会・ビンゴ・投票は問題数が無いので、どの催しかを添える。
                <Badge size="md">{ROOM_MODE_LABELS[snapshot.mode]}</Badge>
              ) : (
                <span>
                  {snapshot.currentQuestionPosition === null
                    ? `全${snapshot.totalQuestions}問`
                    : formatQuestionProgress(
                        snapshot.currentQuestionPosition,
                        snapshot.totalQuestions,
                      )}
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {isDraw && draw !== null ? (
              <>
                <Stat label="引いた" value={formatCount(draw.drawn.length, drawUnit(draw.kind))} />
                <Stat label="残り" value={formatCount(draw.remainingCount, drawUnit(draw.kind))} />
              </>
            ) : null}
            {isPoll ? (
              <Stat label="投票" value={formatCount(snapshot.poll?.voteCount ?? 0, '票')} />
            ) : null}
            {isDraw ? null : (
              <>
                <Stat label="参加人数" value={formatCount(snapshot.participantCount)} />
                <Stat label="オンライン" value={formatCount(snapshot.onlineCount)} />
              </>
            )}
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

      {/* 抽選会・ビンゴの進行 */}
      {isDraw ? (
        <>
          {draw !== null ? (
            <HostDrawPanel
              mode={snapshot.mode}
              phase={snapshot.phase}
              draw={draw}
              availableActions={snapshot.availableActions}
              // busy には延長ボタン用のキーも入る。進行操作のときだけ渡す。
              busyAction={busy !== null && isRoomAction(busy) ? busy : null}
              busy={actionsBusy}
              historyOpen={snapshot.showDrawHistory}
              historyBusy={busy === 'draw-history'}
              onRunAction={handleDrawAction}
              onToggleHistory={handleToggleDrawHistory}
            />
          ) : (
            <Alert variant="warning" title="引くものが入っていません">
              このルームには抽選リストが固められていません。ルーム一覧から作り直してください。
            </Alert>
          )}
          {presentationCard}
        </>
      ) : null}

      {/* 投票の進行 */}
      {isPoll ? (
        poll !== null ? (
          <HostPollPanel
            roomId={roomId}
            phase={snapshot.phase}
            poll={poll}
            result={snapshot.pollResult}
            tally={snapshot.pollTally ?? null}
            availableActions={snapshot.availableActions}
            busy={actionsBusy}
            onChanged={() => void refresh()}
          />
        ) : (
          <Alert variant="warning" title="投票の内容が入っていません">
            このルームには投票用紙が固められていません。ルーム一覧から作り直してください。
          </Alert>
        )
      ) : null}

      {/* 進行操作（クイズ・投票） */}
      {isDraw ? null : (
        <Card title="進行操作" description="ふつうはこの大きなボタンを押していくだけで進みます。">
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
                ? '終了しています。下の「再開」から続きを再開できます。'
                : isPoll
                  ? '進められる操作がありません。'
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
                      onClick={() =>
                        void runAction('show_question', { questionId: nextQuestion.id })
                      }
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
                      {roomActionLabel(action, snapshot.mode)}
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
                    {roomActionLabel(action, snapshot.mode)}
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
            <div className="mt-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-sm font-bold text-slate-700">
                回答済み {formatRatioCount(snapshot.answeredCount, snapshot.participantCount)}
                <span className="ml-2 font-normal text-slate-600">
                  — 「正解を発表」で集計と正解を表示します。
                </span>
              </p>

              {snapshot.availableActions.includes('reopen_question') ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
                  <span className="text-sm font-bold text-slate-700">回答受付を再開</span>
                  {EXTEND_SECONDS_PRESETS.map((seconds) => (
                    <Button
                      key={seconds}
                      size="sm"
                      variant="secondary"
                      loading={busy === `extend-${seconds}`}
                      disabled={actionsBusy && busy !== `extend-${seconds}`}
                      onClick={() =>
                        void runAction('reopen_question', {
                          extendSeconds: seconds,
                          busyKey: `extend-${seconds}`,
                        })
                      }
                    >
                      {seconds}秒
                    </Button>
                  ))}
                  <span className="text-xs text-slate-600">
                    締め切ってしまった直後に戻せます。正解を発表したあとは戻せません。
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      )}

      {/*
        待機中の準備（クイズ・投票）。

        投票では**受付中もここを出す**。途中から来た人がその場で入れるよう、
        二次元コードを進行中も手元に置いておく必要がある。
      */}
      {(isLobby || (isPoll && snapshot.phase === 'poll_open')) && !isDraw ? (
        <>
          <Card
            title="参加用の二次元コード"
            description="会場のスクリーンや掲示物に提示してください。参加はこの二次元コードの読み取りだけで完了します。"
          >
            <JoinUrlPanel
              joinUrl={snapshot.joinUrl ?? rotatedJoinUrl}
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

          {isPoll ? null : (
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
          )}
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

      {/*
        抽選会・ビンゴでは投影画面の欄を上へ出しているので、ここでは重ねない。
        投票の受付中も上の準備欄に出ているので重ねない。
      */}
      {!isLobby && !isDraw && !(isPoll && snapshot.phase === 'poll_open') ? presentationCard : null}

      {!isLobby && !isDraw && !isPoll ? (
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

      {/* 抽選会・ビンゴの再開は host-draw-panel が出す（上のバーからルーム一覧へ戻れる）。 */}
      {snapshot.phase === 'finished' && !isDraw ? (
        <Card title={isPoll ? '投票は終了しました' : 'クイズは終了しました'}>
          <p className="text-sm text-slate-700">お疲れさまでした。</p>
          <p className="mt-3 text-sm text-slate-700">
            誤って終了した場合や続きを行う場合は、ここから再開できます。
            <strong className="font-bold">
              {isPoll ? '投票と集計はそのまま残ります。' : '得点と回答はそのまま残ります。'}
            </strong>
            参加者は同じ二次元コードのまま戻ってこられます。
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              loading={busy === 'reopen_room'}
              disabled={actionsBusy && busy !== 'reopen_room'}
              onClick={() => void runAction('reopen_room')}
            >
              {roomActionLabel('reopen_room', snapshot.mode)}
            </Button>
            <Link href="/admin/rooms" className="text-brand-700 font-bold hover:underline">
              ルーム一覧へ
            </Link>
            <Link
              href={isPoll ? '/admin/poll-ballots' : '/admin/quizzes'}
              className="text-brand-700 font-bold hover:underline"
            >
              {isPoll ? '投票用紙一覧へ戻る' : 'クイズ一覧へ戻る'}
            </Link>
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmFinish}
        title={isPoll ? '投票を終了しますか？' : 'クイズを終了しますか？'}
        description={
          <>
            <p>終了すると進行を続けられなくなり、参加者の画面は結果表示へ切り替わります。</p>
            <p className="mt-2">
              終了したあとでも、この画面の「再開」から続きを再開できます
              {isPoll ? '（投票と集計は残ります）' : '（得点は残ります）'}。
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
