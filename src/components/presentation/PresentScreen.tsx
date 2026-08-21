'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioControls } from '@/components/presentation/AudioControls';
import { BingoStage } from '@/components/presentation/BingoStage';
import { DrawHistoryOverlay } from '@/components/presentation/DrawHistoryOverlay';
import { DrawWaitingStage } from '@/components/presentation/DrawWaitingStage';
import { JoinCodeBadge } from '@/components/presentation/JoinCodeBadge';
import { LotteryStage } from '@/components/presentation/LotteryStage';
import { PresentAudioHint } from '@/components/presentation/PresentAudioHint';
import { QuestionStage } from '@/components/presentation/QuestionStage';
import { RankingStage } from '@/components/presentation/RankingStage';
import { RevealStage } from '@/components/presentation/RevealStage';
import { StageFrame } from '@/components/presentation/StageFrame';
import { UpcomingStage } from '@/components/presentation/UpcomingStage';
import { StageHeader } from '@/components/presentation/StageHeader';
import { StageNotice } from '@/components/presentation/StageNotice';
import { WaitingStage } from '@/components/presentation/WaitingStage';
import { useFullscreen } from '@/components/presentation/use-fullscreen';
import { useJoinUrl } from '@/components/presentation/use-join-url';
import {
  useDrawSoundCues,
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
import { useDrawRoulette } from '@/hooks/use-draw-roulette';
import { useRoomSnapshot } from '@/hooks/use-room-snapshot';
import {
  latestStageEntry,
  remainingStageEntries,
  visibleDuringSpin,
} from '@/domain/draw/draw-stage';
import { isDrawMode } from '@/domain/room/room-mode';

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

/** 抽選が無いときに渡す空の候補。毎回 [] を作ると演出が回り直す。 */
const EMPTY_CANDIDATES: never[] = [];

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
   * 抽選会・ビンゴの演出。
   *
   * 引いた結果はサーバーが決めて記録済み。ここは**見せるだけ**。
   * 音が出せるかどうかとは切り離す。音が鳴らない会場でも演出は回す。
   */
  const draw = snapshot?.draw ?? null;
  const roulette = useDrawRoulette({
    latestOrder: draw?.latestOrder ?? null,
    winner: draw ? latestStageEntry(draw) : null,
    candidates: draw ? remainingStageEntries(draw) : EMPTY_CANDIDATES,
    intervalMs: draw?.settings.spinIntervalMs ?? 50,
    durationMs: draw?.settings.spinDurationMs ?? 2500,
    enabled: true,
  });

  useDrawSoundCues({
    play,
    startLoop,
    stopLoop,
    isUnlocked: audio.isUnlocked,
    spinning: roulette.spinning,
    latestOrder: draw?.latestOrder ?? null,
  });

  /** 引いたものの一覧を出しているか。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => !open);
  }, []);

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
  const drawMode = isDrawMode(snapshot.mode);

  /*
    盤面・履歴へ渡すのは「回し終わったぶんだけ」。
    サーバーは引く操作を受けた瞬間に記録するので、そのまま渡すと
    回している最中に答えが盤面へ出てしまう（会場がいちばん白ける形）。
    ルーレットそのものは記録の側（draw）で回す。
  */
  const shownDraw = draw ? visibleDuringSpin(draw, roulette.spinning) : null;

  let body: ReactNode;

  if (drawMode && draw && shownDraw) {
    // 抽選会・ビンゴ。参加者は来ないので、待機画面も参加 URL を出さない。
    if (phase === 'lobby') {
      body = <DrawWaitingStage draw={shownDraw} />;
    } else if (snapshot.mode === 'bingo') {
      body = (
        <BingoStage
          draw={shownDraw}
          display={roulette.display}
          spinning={roulette.spinning}
          revealed={phase === 'draw_revealed' || phase === 'finished'}
        />
      );
    } else {
      body = (
        <LotteryStage
          draw={shownDraw}
          display={roulette.display}
          spinning={roulette.spinning}
          revealed={phase === 'draw_revealed' || phase === 'finished'}
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

        {drawMode && shownDraw && historyOpen ? (
          <DrawHistoryOverlay
            draw={shownDraw}
            ordered={snapshot.mode === 'lottery'}
            onClose={toggleHistory}
          />
        ) : null}
      </StageFrame>
      {controls}
      {drawMode && draw ? (
        <button
          type="button"
          onClick={toggleHistory}
          className="fixed top-4 right-4 z-40 rounded-lg border border-cyan-300/60 bg-black/60 px-3 py-2 text-sm font-bold text-cyan-200"
        >
          {historyOpen ? '閉じる' : snapshot.mode === 'lottery' ? '当選者一覧' : '出た球'}
        </button>
      ) : null}
      {overlay}
    </>
  );
}
