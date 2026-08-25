'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioControls } from '@/components/presentation/AudioControls';
import { DrawWaitingStage } from '@/components/presentation/DrawWaitingStage';
import { JoinCodeBadge } from '@/components/presentation/JoinCodeBadge';
import { PresentAudioHint } from '@/components/presentation/PresentAudioHint';
import { QuestionStage } from '@/components/presentation/QuestionStage';
import { RankingStage } from '@/components/presentation/RankingStage';
import { RevealStage } from '@/components/presentation/RevealStage';
import { CONTROL_BAR_HEIGHT, DemoControlBar } from '@/components/presentation/DemoControlBar';
import { DrawStageBody, type DrawStagePhase } from '@/components/presentation/DrawStageBody';
import { StageFrame } from '@/components/presentation/StageFrame';
import { UpcomingStage } from '@/components/presentation/UpcomingStage';
import { StageHeader } from '@/components/presentation/StageHeader';
import { StageNotice } from '@/components/presentation/StageNotice';
import { WaitingStage } from '@/components/presentation/WaitingStage';
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
import { useExpiryLock } from '@/hooks/use-expiry-lock';
import { useLocalDraw } from '@/hooks/use-local-draw';
import { useRoomSnapshot } from '@/hooks/use-room-snapshot';
import {} from '@/domain/draw/draw-stage';
import { acceptsParticipants, isDrawMode } from '@/domain/room/room-mode';

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
/** ランキング発表をためる時間の下限・上限（素材の長さがこの範囲に丸められる）。 */
const RANKING_BUILD_UP_MIN_MS = 1_500;
const RANKING_BUILD_UP_MAX_MS = 6_000;

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
  const { enable, play, playTest, startLoop, stopLoop, durationOf, setMuted, setVolume } = audio;
  const fullscreen = useFullscreen();
  // 参加 URL は Snapshot がサーバーから返す。貼り付けは古いルーム用の予備。
  const { joinUrl: pastedJoinUrl, setJoinUrl } = useJoinUrl(roomId);
  const joinUrl = snapshot?.joinUrl ?? pastedJoinUrl;

  /**
   * 「音が出ません」の案内を消したか。
   *
   * 画面そのものは最初から動かす。ここで止めると、押し忘れたときに
   * 「動いているように見えて何も起きない」画面になる。
   */
  const [hintDismissed, setHintDismissed] = useState(false);

  const countdown = useCountdown(snapshot?.answerDeadlineAt ?? null, clock);

  // 次の問題の画像を先に取りに行く（正解解説画像も含む。表示は発表フェーズになってから）。
  useStagePreload(snapshot?.preloadImageUrls);

  useStageSoundCues({
    play,
    startLoop,
    stopLoop,
    // 音が解除された時点から鳴らし始める（受付中のルームへ後から繋いだときも同じ）。
    isUnlocked: audio.isUnlocked,
    phase: snapshot?.phase ?? null,
    stateVersion: snapshot?.stateVersion ?? null,
  });

  /**
   * 抽選会・ビンゴ・ルーレット。
   *
   * 引いた結果はサーバーが決めて記録済み。投影は**見せるだけ**。
   * 演出と効果音は DrawStageBody が持つ（デモと同じものを使う）。
   */
  const liveDraw = snapshot?.draw ?? null;
  const roomMode = snapshot?.mode ?? 'quiz';

  /*
    デモ。

    用意した抽選リストをそのまま使い、**ブラウザの中だけで**引く。
    サーバーへは何も送らないので、本番の記録は動かない。
    当日の前に「どんな画面になるか」を関係者へ見せるためのもの。
  */
  const [demoActive, setDemoActive] = useState(false);
  const local = useLocalDraw({
    pool: liveDraw,
    mode: roomMode,
    active: demoActive,
    // ルームの抽選リストは作成時に固まるので、ルームが同じなら母集団も同じ。
    poolKey: roomId,
  });

  const draw = demoActive ? local.draw : liveDraw;
  /** 投影へ渡す進行の段階。本番のフェーズとデモの状態を同じ 3 つへ寄せる。 */
  const drawPhase: DrawStagePhase = demoActive
    ? local.phase
    : snapshot?.phase === 'draw_spinning'
      ? 'spinning'
      : snapshot?.phase === 'draw_revealed' || snapshot?.phase === 'finished'
        ? 'revealed'
        : 'ready';

  /*
    引いたものの一覧を出しているか。

    司会画面から切り替えられる（投影担当が別の端末にいても、口で頼まなくて済む）。
    投影画面のボタンでもその場で開け閉めできるが、**司会が切り替えたらそちらに従う**。
    そのために「どの司会の値に対する操作か」を一緒に覚えておき、
    司会の値が変わったら投影側の操作を捨てる。
  */
  const hostHistoryOpen = snapshot?.showDrawHistory === true;
  const [localHistory, setLocalHistory] = useState<{ hostValue: boolean; open: boolean } | null>(
    null,
  );
  const historyOpen =
    localHistory !== null && localHistory.hostValue === hostHistoryOpen
      ? localHistory.open
      : hostHistoryOpen;
  const toggleHistory = useCallback(() => {
    setLocalHistory({ hostValue: hostHistoryOpen, open: !historyOpen });
  }, [historyOpen, hostHistoryOpen]);

  const handleLocked = useCallback(() => {
    void refresh();
  }, [refresh]);

  useExpiryLock({
    roomId,
    phase: snapshot?.phase ?? '',
    stateVersion: snapshot?.stateVersion ?? null,
    // 締切時刻に対して計算済みのときだけ「時間切れ」と見なす。
    expired: countdown.ready && countdown.remainingMs <= 0,
    onLocked: handleLocked,
  });

  /**
   * ランキングは二段構えで出す。
   *
   * ドラムロールと同時に順位が見えると、ためる意味が無くなる。
   * scoreboard へ入ったら、まず「まもなく発表します」を出してドラムロールを鳴らし、
   * **その音が鳴り終わったところで**順位を出してファンファーレを鳴らす。
   */
  /** 発表済みの状態番号。ここへ届いたら順位を出す。 */
  const [revealedVersion, setRevealedVersion] = useState<number | null>(null);
  /** ためる処理を始めた状態番号。同じ番号で二度ためない。 */
  const buildUpStartedRef = useRef<number | null>(null);

  const scoreboardVersion = snapshot?.phase === 'scoreboard' ? snapshot.stateVersion : null;

  useEffect(() => {
    if (scoreboardVersion === null || buildUpStartedRef.current === scoreboardVersion) {
      return;
    }
    buildUpStartedRef.current = scoreboardVersion;

    // 待ち時間は素材の実際の長さに合わせる（差し替えても間延びしない）。
    const seconds = durationOf('ranking');
    const waitMs = Math.min(
      RANKING_BUILD_UP_MAX_MS,
      Math.max(RANKING_BUILD_UP_MIN_MS, (seconds ?? 2.5) * 1000),
    );

    const timerId = setTimeout(() => {
      setRevealedVersion(scoreboardVersion);
      play('fanfare', `${scoreboardVersion}:fanfare`);
    }, waitMs);

    return () => {
      clearTimeout(timerId);
    };
  }, [durationOf, play, scoreboardVersion]);

  /** ランキングを出してよいか。ためている間だけ false。 */
  const rankingRevealed = scoreboardVersion === null || revealedVersion === scoreboardVersion;

  /**
   * 音の有効化はクリックイベントの中で始める必要がある。
   * 全画面要求も同じクリックの有効期間で出すため、先読みの完了は待たない。
   */
  const handleEnableAndTest = useCallback(() => {
    void enable().then(() => playTest());
  }, [enable, playTest]);

  const handleEnableFromControls = useCallback(() => {
    void enable();
  }, [enable]);

  const handleToggleMute = useCallback(() => {
    setMuted(!audio.muted);
  }, [audio.muted, setMuted]);

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
  }, []);

  // 音が出せないときだけ案内を出す。画面は止めない。
  const overlay =
    !audio.isUnlocked && !hintDismissed ? (
      <PresentAudioHint
        status={audio.status}
        testResult={audio.testResult}
        onEnable={handleEnableAndTest}
        onFullscreen={fullscreen.request}
        onDismiss={dismissHint}
      />
    ) : null;

  const controls = (
    <AudioControls
      isUnlocked={audio.isUnlocked}
      muted={audio.muted}
      volume={audio.volume}
      warning={audio.warning}
      status={audio.status}
      isFullscreen={fullscreen.isFullscreen}
      onEnable={handleEnableFromControls}
      onToggleMute={handleToggleMute}
      onVolumeChange={setVolume}
      onToggleFullscreen={fullscreen.toggle}
    />
  );

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
              司会画面で「投影用リンクを発行」して、そのURLを開いてください。
              このページのURL（/present/…）は、そのままでは他の人が開けません。
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
  const drawMode = isDrawMode(snapshot.mode);

  let body: ReactNode;

  if (drawMode && draw) {
    // 抽選会・ビンゴ・ルーレット。参加者は来ないので、待機画面も参加 URL を出さない。
    if (!demoActive && phase === 'lobby') {
      body = <DrawWaitingStage draw={draw} />;
    } else {
      body = (
        <DrawStageBody
          draw={draw}
          mode={roomMode}
          phase={drawPhase}
          audio={audio}
          historyOpen={historyOpen}
          onCloseHistory={toggleHistory}
          /*
            本番は状態番号を含む鍵で二重再生を防ぐ（取り直しのたびに鳴り直さない）。
            デモは同じ番号を何度も引き直すので鍵を渡さない（毎回鳴らす）。
          */
          {...(demoActive ? {} : { soundDedupeKey: `draw:${snapshot.stateVersion}` })}
        />
      );
    }
  } else if (phase === 'lobby') {
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
        revealed={phase === 'finished' ? true : rankingRevealed}
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

  /*
    「参加用の二次元コードをずっと表示する」設定。
    待機画面はもともと大きな二次元コードを出しているので、そこでは重ねない。
    受付を締め切っている間は出さない（読んでも入れないコードを出さない）。
  */
  const showJoinBadge =
    snapshot.alwaysShowJoinCode &&
    snapshot.joinOpen &&
    joinUrl !== null &&
    phase !== 'lobby' &&
    !drawMode;

  return (
    <>
      <StageFrame
        // デモ中は操作の帯のぶん 16:9 を縮める（盤面の最後の行が隠れないように）。
        bottomInset={demoActive ? CONTROL_BAR_HEIGHT : 0}
        // 抽選リストに背景画像があれば敷く（GAS 版の背景画像に相当）。
        backgroundUrl={draw?.background?.url ?? null}
        aside={showJoinBadge && joinUrl ? <JoinCodeBadge joinUrl={joinUrl} /> : undefined}
        header={
          <StageHeader
            quizTitle={snapshot.quizTitle}
            phase={phase}
            questionPosition={snapshot.currentQuestionPosition}
            totalQuestions={snapshot.totalQuestions}
            showTotalQuestions={snapshot.showTotalQuestions}
            participantCount={snapshot.participantCount}
            // 抽選会・ビンゴ・ルーレットは参加者が入らない。「参加 0人」を出さない。
            showParticipants={acceptsParticipants(snapshot.mode)}
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
      {drawMode && draw ? (
        <div className="fixed top-4 right-4 z-40 flex gap-2 text-sm">
          <button
            type="button"
            onClick={toggleHistory}
            className="rounded-lg border border-cyan-300/60 bg-black/60 px-3 py-2 font-bold text-cyan-200"
          >
            {historyOpen ? '閉じる' : snapshot.mode === 'lottery' ? '当選者一覧' : '出た球'}
          </button>
          {/*
            このルームの抽選リストを使ったデモ。
            ブラウザの中だけで引くので、本番の記録は動かない。
            当日の前に「どんな画面になるか」を関係者へ見せるためのもの。
          */}
          {!demoActive ? (
            <button
              type="button"
              onClick={() => {
                setDemoActive(true);
              }}
              className="rounded-lg border border-amber-300/60 bg-black/60 px-3 py-2 font-bold text-amber-200"
            >
              デモで試す
            </button>
          ) : null}
        </div>
      ) : null}
      {demoActive ? (
        <DemoControlBar
          isRoulette={roomMode === 'roulette'}
          spinning={local.phase === 'spinning'}
          exhausted={local.exhausted}
          auto={local.auto}
          onDrawNext={local.drawNext}
          onStartSpin={local.startSpin}
          onReset={local.reset}
          onToggleAuto={() => {
            local.setAuto(!local.auto);
          }}
          leading={
            <span className="shrink-0 whitespace-nowrap text-white/70">
              {draw?.title ?? ''}（本番の記録は動きません）
            </span>
          }
          trailing={
            <button
              type="button"
              onClick={() => {
                setDemoActive(false);
              }}
              className="shrink-0 rounded-lg border border-white/30 px-4 py-2 font-bold text-white/80"
            >
              デモを終える
            </button>
          }
        />
      ) : null}
      {overlay}
    </>
  );
}
