'use client';

import { BingoStage } from '@/components/presentation/BingoStage';
import { DrawHistoryOverlay } from '@/components/presentation/DrawHistoryOverlay';
import { LotteryStage } from '@/components/presentation/LotteryStage';
import { RouletteStage } from '@/components/presentation/RouletteStage';
import {
  useDrawSoundCues,
  type ProjectorAudio,
} from '@/components/presentation/use-projector-audio';
import {
  latestStageEntry,
  remainingStageEntries,
  visibleDuringSpin,
  type StageDraw,
} from '@/domain/draw/draw-stage';
import { removesDrawnEntries, type RoomMode } from '@/domain/room/room-mode';
import { useDrawRoulette } from '@/hooks/use-draw-roulette';
import { useRouletteWheel } from '@/hooks/use-roulette-wheel';

/**
 * 抽選会・ビンゴ・ルーレットの投影本体。
 *
 * 本番（サーバーが引く）とデモ（ブラウザが引く）で**同じものを使う**。
 * 演出も効果音もここが持つので、片方だけ直し忘れて食い違うことがない。
 *
 * 引いた結果は呼び出し側が決めて渡す。ここは**見せるだけ**。
 */

/** 進行の段階。本番のフェーズとデモの状態を、この 3 つへ寄せて渡す。 */
export type DrawStagePhase = 'ready' | 'spinning' | 'revealed';

export function DrawStageBody({
  draw,
  mode,
  phase,
  audio,
  soundDedupeKey,
  historyOpen = false,
  onCloseHistory,
}: {
  draw: StageDraw | null;
  mode: RoomMode;
  phase: DrawStagePhase;
  audio: ProjectorAudio;
  /** 引いたものの一覧を重ねて出すか。 */
  historyOpen?: boolean;
  onCloseHistory?: (() => void) | undefined;
  /**
   * 同じ出来事で二度鳴らさないための鍵。
   *
   * 本番は状態番号を含む鍵を渡す（取り直しのたびに鳴り直さないため）。
   * **デモは渡さない。** 同じ番号を何度も引き直すので、鍵を付けると
   * 2 周目から無音になる。
   */
  soundDedupeKey?: string | undefined;
}) {
  const isRoulette = !removesDrawnEntries(mode);
  const empty = draw === null;

  const roulette = useDrawRoulette({
    latestOrder: draw?.latestOrder ?? null,
    winner: draw ? latestStageEntry(draw) : null,
    candidates: draw ? remainingStageEntries(draw) : EMPTY_ENTRIES,
    intervalMs: draw?.settings.spinIntervalMs ?? 50,
    durationMs: draw?.settings.spinDurationMs ?? 2500,
    // ルーレットは円盤そのものが回るので、候補を切り替える演出は使わない。
    enabled: !isRoulette && !empty,
  });

  const wheelSpinning = isRoulette && phase === 'spinning';
  const wheelRef = useRouletteWheel({
    entries: draw?.entries ?? EMPTY_ENTRIES,
    isSpinning: wheelSpinning,
    winnerId: draw?.latestEntryId ?? null,
    latestOrder: draw?.latestOrder ?? null,
    stopDurationMs: draw?.settings.stopDurationMs ?? 4000,
  });

  useDrawSoundCues({
    play: audio.play,
    startLoop: audio.startLoop,
    stopLoop: audio.stopLoop,
    isUnlocked: audio.isUnlocked,
    // 回している合図は、円盤（ルーレット）と候補送り（抽選会・ビンゴ）の両方を拾う。
    spinning: isRoulette ? wheelSpinning : roulette.spinning,
    latestOrder: draw?.latestOrder ?? null,
    ...(soundDedupeKey !== undefined ? { dedupeKey: soundDedupeKey } : {}),
  });

  if (!draw) {
    return null;
  }

  const revealed = phase === 'revealed';
  /*
    盤面・一覧へ渡すのは「回し終わったぶんだけ」。
    回している最中に結果が盤面や一覧へ出ると、会場がいちばん白ける。
  */
  const shown = visibleDuringSpin(draw, roulette.spinning);

  let stage;
  if (isRoulette) {
    stage = (
      <RouletteStage
        draw={draw}
        wheelRef={wheelRef}
        spinning={wheelSpinning}
        revealed={revealed}
        winnerId={wheelSpinning ? null : draw.latestEntryId}
      />
    );
  } else if (mode === 'bingo') {
    stage = (
      <BingoStage
        draw={shown}
        display={roulette.display}
        spinning={roulette.spinning}
        revealed={revealed}
      />
    );
  } else {
    stage = (
      <LotteryStage
        draw={shown}
        display={roulette.display}
        spinning={roulette.spinning}
        revealed={revealed}
      />
    );
  }

  return (
    <>
      {stage}
      {historyOpen ? (
        <DrawHistoryOverlay
          draw={shown}
          ordered={mode === 'lottery'}
          onClose={onCloseHistory ?? (() => {})}
        />
      ) : null}
    </>
  );
}

/** 参照が変わると効果が回り直すので、空の配列は使い回す。 */
const EMPTY_ENTRIES: never[] = [];
