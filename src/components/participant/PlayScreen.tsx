'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChoiceAnswerList } from '@/components/participant/ChoiceAnswerList';
import { CountdownBar } from '@/components/participant/CountdownBar';
import { LeaderboardPanel } from '@/components/participant/LeaderboardPanel';
import { MyAnswerSummary } from '@/components/participant/MyAnswerSummary';
import { MyScorePanel } from '@/components/participant/MyScorePanel';
import { NoticePanel } from '@/components/participant/NoticePanel';
import { NumberAnswerForm } from '@/components/participant/NumberAnswerForm';
import { ParticipantHeader } from '@/components/participant/ParticipantHeader';
import { QuestionCard } from '@/components/participant/QuestionCard';
import { RevealPanel } from '@/components/participant/RevealPanel';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import type { MyAnswer } from '@/domain/answer/answer-dto';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import type { ParticipantSnapshot } from '@/domain/room/snapshot';
import { useCountdown } from '@/hooks/use-countdown';
import { useRoomSnapshot } from '@/hooks/use-room-snapshot';
import { ApiClientError, apiGet, apiPost } from '@/lib/client/api-client';
import { userMessageForCode } from '@/lib/errors/app-error';
import { formatCount } from '@/lib/format';
import type { MyResultResponse, SubmitAnswerResponse } from '@/types/api';

/**
 * 参加者の進行画面。
 *
 * 守ること:
 * - 状態の正は DB（Snapshot API）。Realtime は取り直しの合図としてだけ使う。
 *   ページ更新・通信断・画面復帰のいずれでも Snapshot から同じ参加者として復元される。
 * - 正解情報は Snapshot が正解発表フェーズで返した reveal / myResult だけを使う。
 *   発表前にそれらを保持も表示もしない。
 * - 「回答済み」にするのは成功応答を受け取ってから。通信エラーでは回答済みにしない。
 * - 締切の最終判定はサーバー / DB。カウントダウンは表示のための補正値にすぎない。
 * - 音・振動を一切扱わない（効果音は投影画面だけの責務）。
 */

/** 再送のために保持する送信内容。 */
type PendingSubmission =
  | { kind: 'choice'; questionId: string; choiceId: string }
  | {
      kind: 'number';
      questionId: string;
      /** 参加者が実際に入力した文字列。 */
      raw: string;
      /** クライアント側で正規化した文字列。 */
      normalizedText: string;
      /** API へ送る値。 */
      payload: string;
    };

/** submitAnswerSchema の numberValue 上限。 */
const NUMBER_VALUE_MAX_LENGTH = 64;

/** 状態がずれているため Snapshot を取り直すべきエラー。 */
const STALE_STATE_CODES = ['ANSWER_DEADLINE_PASSED', 'ANSWER_NOT_OPEN', 'ANSWER_QUESTION_MISMATCH'];

export function PlayScreen({ roomId }: { roomId: string }) {
  const { snapshot, error, status, clock, refresh } = useRoomSnapshot<ParticipantSnapshot>({
    roomId,
    endpoint: `/api/rooms/${roomId}/snapshot`,
    audience: 'participant',
  });

  const question = snapshot?.currentQuestion ?? null;
  const questionId = question?.id ?? null;

  const [localAnswer, setLocalAnswer] = useState<{ questionId: string; answer: MyAnswer } | null>(
    null,
  );
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  // 問題が切り替わったら送信状態を捨てる（レンダー中の state 調整）。
  // effect で行うと前の問題の「回答済み」表示が 1 フレーム残るため。
  const [trackedQuestionId, setTrackedQuestionId] = useState<string | null>(questionId);
  if (trackedQuestionId !== questionId) {
    setTrackedQuestionId(questionId);
    setLocalAnswer(null);
    setPending(null);
    setSubmitError(null);
  }

  /** 409（回答済み）のとき、サーバーが保持している自分の回答へ復元する。 */
  const restoreAnswerFromServer = useCallback(
    async (targetQuestionId: string): Promise<boolean> => {
      try {
        const result = await apiGet<MyResultResponse>(`/api/rooms/${roomId}/my-result`);
        if (result.myAnswer && result.questionId === targetQuestionId) {
          setLocalAnswer({ questionId: targetQuestionId, answer: result.myAnswer });
          return true;
        }
      } catch {
        // ここで失敗しても Snapshot 側で復元できるため、画面は壊さない。
      }
      return false;
    },
    [roomId],
  );

  const submit = useCallback(
    async (submission: PendingSubmission): Promise<void> => {
      setPending(submission);
      setSubmitError(null);
      setSubmitting(true);

      try {
        const body =
          submission.kind === 'choice'
            ? { questionId: submission.questionId, choiceId: submission.choiceId }
            : { questionId: submission.questionId, numberValue: submission.payload };

        const result = await apiPost<SubmitAnswerResponse>(`/api/rooms/${roomId}/answer`, body);

        // 成功応答を受け取ってから初めて「回答済み」にする。
        setLocalAnswer({
          questionId: submission.questionId,
          answer:
            submission.kind === 'choice'
              ? {
                  questionId: submission.questionId,
                  type: 'choice',
                  choiceId: submission.choiceId,
                  answeredAt: result.answeredAt,
                }
              : {
                  questionId: submission.questionId,
                  type: 'number',
                  raw: submission.raw,
                  normalizedText: submission.normalizedText,
                  answeredAt: result.answeredAt,
                },
        });
        setPending(null);
        setSubmitError(null);
      } catch (caught) {
        if (caught instanceof ApiClientError && caught.code === 'ANSWER_ALREADY_EXISTS') {
          // すでに受理済み。サーバーが持つ回答を取り直して「回答済み」へ復元する。
          const restored = await restoreAnswerFromServer(submission.questionId);
          if (restored) {
            setPending(null);
            setSubmitError(null);
          } else {
            setSubmitError(caught);
            void refresh();
          }
          return;
        }

        setSubmitError(caught);
        if (caught instanceof ApiClientError && STALE_STATE_CODES.includes(caught.code)) {
          void refresh();
        }
      } finally {
        setSubmitting(false);
      }
    },
    [refresh, restoreAnswerFromServer, roomId],
  );

  const handleSelectChoice = useCallback(
    (choiceId: string) => {
      if (!questionId || submitting) {
        return;
      }
      void submit({ kind: 'choice', questionId, choiceId });
    },
    [questionId, submit, submitting],
  );

  const handleSubmitNumber = useCallback(
    (input: { raw: string; normalizedText: string }) => {
      if (!questionId || submitting) {
        return;
      }
      // API は numberValue を 64 文字までしか受け取らない。
      // 桁区切りや空白が多い入力は、正規化済みの文字列で送る。
      const payload =
        input.raw.length <= NUMBER_VALUE_MAX_LENGTH ? input.raw : input.normalizedText;
      void submit({
        kind: 'number',
        questionId,
        raw: input.raw,
        normalizedText: input.normalizedText,
        payload,
      });
    },
    [questionId, submit, submitting],
  );

  const handleRetry = useCallback(() => {
    if (!pending || submitting) {
      return;
    }
    void submit(pending);
  }, [pending, submit, submitting]);

  const snapshotMyAnswer = snapshot?.myAnswer ?? null;
  const myAnswer = useMemo<MyAnswer | null>(() => {
    if (!questionId) {
      return null;
    }
    if (snapshotMyAnswer && snapshotMyAnswer.questionId === questionId) {
      return snapshotMyAnswer;
    }
    if (localAnswer && localAnswer.questionId === questionId) {
      return localAnswer.answer;
    }
    return null;
  }, [localAnswer, questionId, snapshotMyAnswer]);

  const countdown = useCountdown(snapshot?.answerDeadlineAt ?? null, clock);

  if (!snapshot) {
    if (error !== null) {
      const notParticipant = error === userMessageForCode('NOT_A_PARTICIPANT');
      return (
        <FullScreenMessage
          title={notParticipant ? 'このクイズに参加していません' : '読み込めませんでした'}
          description={
            notParticipant
              ? '会場の二次元コードをもう一度読み取って参加してください'
              : '電波状況を確認して、もう一度お試しください'
          }
          tone="error"
          actions={
            notParticipant ? undefined : (
              <Button variant="secondary" size="lg" onClick={() => void refresh()}>
                もう一度試す
              </Button>
            )
          }
        />
      );
    }
    return <FullScreenMessage title="読み込んでいます" loading tone="info" />;
  }

  const phase = snapshot.phase;
  // 表示上の締切。実際の締切判定はサーバー / DB が行う。
  const deadlinePassed = snapshot.answerDeadlineAt !== null && countdown.remainingMs <= 0;
  const answered = myAnswer !== null;
  const canAnswer = phase === 'question_open' && !deadlinePassed && !answered;
  const canRetrySubmit = pending !== null && phase === 'question_open' && !deadlinePassed;
  const reveal = snapshot.reveal;

  const answerErrorBlock =
    submitError !== null ? (
      <ErrorMessage
        error={submitError}
        onRetry={canRetrySubmit ? handleRetry : undefined}
        retryLabel="もう一度送信する"
      />
    ) : null;

  const submittingChoiceId =
    submitting && pending !== null && pending.kind === 'choice' ? pending.choiceId : null;

  /** 選択肢・数値入力の共通描画。フェーズごとに interactive だけ切り替える。 */
  const renderAnswerArea = (current: PublicQuestion): ReactNode => {
    if (current.type === 'choice') {
      return (
        <ChoiceAnswerList
          choices={current.choices}
          interactive={canAnswer}
          submittingChoiceId={submittingChoiceId}
          answeredChoiceId={myAnswer?.type === 'choice' ? myAnswer.choiceId : null}
          // 正解発表フェーズでしか reveal は返ってこない。
          correctChoiceId={reveal?.correctChoiceId ?? null}
          onSelect={handleSelectChoice}
        />
      );
    }

    if (canAnswer) {
      return (
        <NumberAnswerForm
          // 問題が変わったら入力欄を作り直す。
          key={current.id}
          unit={current.unit}
          decimalPlaces={current.decimalPlaces}
          interactive
          submitting={submitting}
          onSubmit={handleSubmitNumber}
        />
      );
    }

    // 受付前はまだ回答が無く、正解発表後は RevealPanel が同じ内容を含むため、
    // ここでは自分の回答を出さない。
    if (phase === 'question_ready' || phase === 'answer_revealed') {
      return null;
    }

    return <MyAnswerSummary question={current} myAnswer={myAnswer} />;
  };

  let body: ReactNode;

  if (phase === 'lobby') {
    body = (
      <NoticePanel
        title="まもなく始まります"
        description="この画面のままお待ちください"
        waiting
        tone="brand"
      >
        <p className="mt-1 text-sm font-bold">
          {snapshot.participant.nickname} さんとして参加しています
        </p>
        <p className="text-xs opacity-80">
          現在 {formatCount(snapshot.participantCount)}が参加しています
        </p>
      </NoticePanel>
    );
  } else if (phase === 'scoreboard' || phase === 'finished') {
    body = (
      <div className="flex flex-col gap-4">
        {phase === 'finished' ? (
          <NoticePanel
            title="クイズは終了しました"
            description="ご参加ありがとうございました"
            tone="brand"
          />
        ) : null}
        <MyScorePanel
          myResult={snapshot.myResult}
          participantCount={snapshot.participantCount}
          nickname={snapshot.participant.nickname}
        />
        {snapshot.leaderboard ? (
          <LeaderboardPanel
            leaderboard={snapshot.leaderboard}
            myParticipantId={snapshot.participant.participantId}
          />
        ) : (
          <NoticePanel title="ランキングは表示されません" tone="muted" />
        )}
      </div>
    );
  } else if (!question) {
    // 問題を出してよいフェーズだが Snapshot にまだ問題が無い（切り替わり中）。
    body = <NoticePanel title="次の問題を準備しています" waiting />;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <QuestionCard question={question} />

        {phase === 'question_open' ? (
          <CountdownBar
            remainingSeconds={countdown.remainingSeconds}
            remainingMs={countdown.remainingMs}
            timeLimitSeconds={question.timeLimitSeconds}
          />
        ) : null}

        {phase === 'question_ready' ? (
          <NoticePanel
            title="まもなく回答を受け付けます"
            description="司会の合図をお待ちください"
            waiting
          />
        ) : null}

        {phase === 'question_open' && answered ? (
          <NoticePanel title="回答済み" description="結果の発表までお待ちください" tone="brand" />
        ) : null}

        {phase === 'question_open' && !answered && deadlinePassed ? (
          <NoticePanel title="回答時間が終了しました" tone="muted" />
        ) : null}

        {phase === 'question_locked' ? (
          <NoticePanel
            title="回答時間が終了しました"
            description="正解の発表をお待ちください"
            waiting
            tone="muted"
          />
        ) : null}

        {renderAnswerArea(question)}

        {answerErrorBlock}

        {phase === 'answer_revealed' && reveal ? (
          <RevealPanel
            question={question}
            reveal={reveal}
            myAnswer={myAnswer}
            myResult={snapshot.myResult}
            participantCount={snapshot.participantCount}
          />
        ) : null}
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 pt-4 pb-10">
      <ParticipantHeader
        quizTitle={snapshot.quizTitle}
        nickname={snapshot.participant.nickname}
        phase={phase}
        questionPosition={snapshot.currentQuestionPosition}
        totalQuestions={snapshot.totalQuestions}
        status={status}
      />

      {error !== null ? (
        <Alert variant="warning">最新の状態を取得できませんでした。自動でやり直します</Alert>
      ) : null}

      {body}
    </main>
  );
}
