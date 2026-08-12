'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { AudioControls } from '@/components/presentation/AudioControls';
import { PresentSetupOverlay } from '@/components/presentation/PresentSetupOverlay';
import { QuestionStage } from '@/components/presentation/QuestionStage';
import { RankingStage } from '@/components/presentation/RankingStage';
import { RevealStage } from '@/components/presentation/RevealStage';
import { StageFrame } from '@/components/presentation/StageFrame';
import { UpcomingStage } from '@/components/presentation/UpcomingStage';
import { StageHeader } from '@/components/presentation/StageHeader';
import { StageNotice } from '@/components/presentation/StageNotice';
import { WaitingStage } from '@/components/presentation/WaitingStage';
import { useExpiryLock } from '@/components/presentation/use-expiry-lock';
import { useFullscreen } from '@/components/presentation/use-fullscreen';
import { useJoinUrl } from '@/components/presentation/use-join-url';
import {
  useProjectorAudio,
  useStageSoundCues,
} from '@/components/presentation/use-projector-audio';
import { useStagePreload } from '@/components/presentation/use-stage-preload';
import { Button } from '@/components/shared/Button';
import { FullScreenMessage } from '@/components/shared/FullScreenMessage';
import type { StaffSnapshot } from '@/domain/room/snapshot';
import { useAnonymousSessionReady } from '@/hooks/use-anonymous-session';
import { useCountdown } from '@/hooks/use-countdown';
import { useRoomSnapshot } from '@/hooks/use-room-snapshot';

/**
 * 会場投影画面。
 *
 * 守っていること:
 * - 状態の正は DB（staff Snapshot API）。Realtime は「取り直せ」という合図としてだけ使う。
 * - 通信が切れても画面を消さない。直前に取れた内容を出したまま「再接続中」とだけ伝える。
 * - 正解情報は Snapshot が正解発表フェーズで返した reveal / breakdown だけを使う。
 *   発表前に受け取って隠しておく実装にしない。
 * - 効果音は操作者のクリック（投影開始）より前には一切鳴らさない。
 * - 残り 0 秒になったら冪等な締切 API を 1 回だけ呼ぶ。締切の判定はサーバーが行う。
 * - 投影担当にログインは求めない。匿名認証（＝ /present/token/... で presenter として
 *   登録済みの端末）が整うまで取得も購読も始めない。
 */
export function PresentScreen({ roomId }: { roomId: string }) {
  // 再読込でセッションクッキーが切れていても、同じ匿名ユーザーで張り直せるようにする。
  const sessionReady = useAnonymousSessionReady();

  const { snapshot, error, status, clock, refresh } = useRoomSnapshot<StaffSnapshot>({
    roomId,
    endpoint: `/api/rooms/${roomId}/staff-snapshot`,
    audience: 'staff',
    enabled: sessionReady,
  });

  const audio = useProjectorAudio(roomId);
  const { enable, play, playTest, setMuted, setVolume } = audio;
  const fullscreen = useFullscreen();
  const { joinUrl, setJoinUrl } = useJoinUrl(roomId);

  /** 操作者が「投影を開始」を押したか。押すまでは準備オーバーレイを出す。 */
  const [started, setStarted] = useState(false);

  const countdown = useCountdown(snapshot?.answerDeadlineAt ?? null, clock);

  // 次の問題の画像を先に取りに行く（正解解説画像も含む。表示は発表フェーズになってから）。
  useStagePreload(snapshot?.preloadImageUrls);

  useStageSoundCues({
    play,
    phase: snapshot?.phase ?? null,
    stateVersion: snapshot?.stateVersion ?? null,
    remainingSeconds: countdown.remainingSeconds,
    hasDeadline: Boolean(snapshot?.answerDeadlineAt),
  });

  const handleLocked = useCallback(() => {
    void refresh();
  }, [refresh]);

  useExpiryLock({
    roomId,
    phase: snapshot?.phase ?? '',
    stateVersion: snapshot?.stateVersion ?? null,
    expired: Boolean(snapshot?.answerDeadlineAt) && countdown.remainingMs <= 0,
    onLocked: handleLocked,
  });

  /**
   * 音の有効化はクリックイベントの中で始める必要がある。
   * 全画面要求も同じクリックの有効期間で出すため、先読みの完了は待たない。
   */
  const handleTest = useCallback(() => {
    void enable().then(() => playTest());
  }, [enable, playTest]);

  const handleStart = useCallback(() => {
    setStarted(true);
    void enable().then(() => playTest());
    fullscreen.request();
  }, [enable, fullscreen, playTest]);

  const handleEnableFromControls = useCallback(() => {
    void enable();
  }, [enable]);

  const handleToggleMute = useCallback(() => {
    setMuted(!audio.muted);
  }, [audio.muted, setMuted]);

  const overlay = !started ? (
    <PresentSetupOverlay
      quizTitle={snapshot?.quizTitle ?? null}
      previouslyEnabled={audio.previouslyEnabled}
      warning={audio.warning}
      status={audio.status}
      testResult={audio.testResult}
      onTest={handleTest}
      onStart={handleStart}
    />
  ) : null;

  const controls = started ? (
    <AudioControls
      isUnlocked={audio.isUnlocked}
      muted={audio.muted}
      volume={audio.volume}
      warning={audio.warning}
      isFullscreen={fullscreen.isFullscreen}
      onEnable={handleEnableFromControls}
      onToggleMute={handleToggleMute}
      onVolumeChange={setVolume}
      onToggleFullscreen={fullscreen.toggle}
    />
  ) : null;

  if (!snapshot) {
    return (
      <>
        {error !== null ? (
          <FullScreenMessage
            tone="stage"
            title="投影画面を表示できません"
            description={error}
            actions={
              <Button variant="secondary" size="lg" onClick={() => void refresh()}>
                もう一度試す
              </Button>
            }
          >
            <p className="max-w-xl text-sm text-white/60">
              司会画面で発行した投影用リンクを開いているか確認してください。
            </p>
          </FullScreenMessage>
        ) : (
          <FullScreenMessage tone="stage" title="読み込んでいます" loading />
        )}
        {controls}
        {overlay}
      </>
    );
  }

  const phase = snapshot.phase;
  const question = snapshot.currentQuestion;

  let body: ReactNode;

  if (phase === 'lobby') {
    body = (
      <WaitingStage
        quizTitle={snapshot.quizTitle}
        joinUrl={joinUrl}
        joinOpen={snapshot.joinOpen}
        participantCount={snapshot.participantCount}
        onSetJoinUrl={setJoinUrl}
      />
    );
  } else if (phase === 'scoreboard' || phase === 'finished') {
    body = (
      <RankingStage
        leaderboard={snapshot.leaderboard}
        showLeaderboard={snapshot.showLeaderboard}
        participantCount={snapshot.participantCount}
        finished={phase === 'finished'}
      />
    );
  } else if (phase === 'question_ready' && !question) {
    // 「受付開始前は見せない」設定。問題そのものがサーバーから送られてこないので、
    // ここで隠しているのではなく、そもそも持っていない。
    body = (
      <UpcomingStage
        questionPosition={snapshot.currentQuestionPosition}
        totalQuestions={snapshot.totalQuestions}
        showTotalQuestions={snapshot.showTotalQuestions}
      />
    );
  } else if (!question) {
    body = <StageNotice title="次の問題を準備しています" description="そのままお待ちください" />;
  } else if (phase === 'answer_revealed') {
    body = snapshot.reveal ? (
      <RevealStage
        question={question}
        reveal={snapshot.reveal}
        breakdown={snapshot.breakdown}
        questionPosition={snapshot.currentQuestionPosition}
        totalQuestions={snapshot.totalQuestions}
        showTotalQuestions={snapshot.showTotalQuestions}
      />
    ) : (
      <StageNotice title="正解を表示しています" />
    );
  } else {
    body = (
      <QuestionStage
        question={question}
        phase={phase}
        questionPosition={snapshot.currentQuestionPosition}
        totalQuestions={snapshot.totalQuestions}
        showTotalQuestions={snapshot.showTotalQuestions}
        remainingSeconds={countdown.remainingSeconds}
        remainingMs={countdown.remainingMs}
        answeredCount={snapshot.answeredCount}
        participantCount={snapshot.participantCount}
      />
    );
  }

  return (
    <>
      <StageFrame
        header={
          <StageHeader
            quizTitle={snapshot.quizTitle}
            phase={phase}
            questionPosition={snapshot.currentQuestionPosition}
            totalQuestions={snapshot.totalQuestions}
            showTotalQuestions={snapshot.showTotalQuestions}
            participantCount={snapshot.participantCount}
            status={status}
            stale={error !== null}
          />
        }
      >
        {/*
          場面（フェーズ・問題）が変わるたびに入場効果をやり直す。
          key を変えることで React が要素を作り直し、CSS アニメーションが再生される。
          会場では画面の切り替わりが伝わりにくいため、動きで「変わった」ことを示す。
        */}
        <div
          key={`${phase}-${snapshot.currentQuestion?.id ?? ''}`}
          className="stage-enter flex min-h-0 flex-1 flex-col justify-center"
        >
          {body}
        </div>
      </StageFrame>
      {controls}
      {overlay}
    </>
  );
}
