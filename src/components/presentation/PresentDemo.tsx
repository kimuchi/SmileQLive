'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BingoStage } from '@/components/presentation/BingoStage';
import { DrawHistoryOverlay } from '@/components/presentation/DrawHistoryOverlay';
import { LotteryStage } from '@/components/presentation/LotteryStage';
import { PresentAudioHint } from '@/components/presentation/PresentAudioHint';
import { RouletteStage } from '@/components/presentation/RouletteStage';
import { StageFrame } from '@/components/presentation/StageFrame';
import { useFullscreen } from '@/components/presentation/use-fullscreen';
import { useDrawSoundCues, useProjectorAudio } from '@/components/presentation/use-projector-audio';
import type { DrawRecord } from '@/domain/draw/draw-list';
import {
  buildDemoDraw,
  DEMO_MODE_LABELS,
  DEMO_MODES,
  pickDemoEntry,
  type DemoMode,
} from '@/domain/draw/demo-draw';
import {
  latestStageEntry,
  remainingStageEntries,
  visibleDuringSpin,
} from '@/domain/draw/draw-stage';
import { spinTotalMs, useDrawRoulette } from '@/hooks/use-draw-roulette';
import { useRouletteWheel } from '@/hooks/use-roulette-wheel';
import { cn } from '@/lib/client/cn';

/**
 * 投影画面のデモ。
 *
 * ルームもログインも要らない。この画面だけで抽選会・ビンゴ・ルーレットを回せる。
 * 「導入するとどんな画面になるのか」をその場で見せるためのもの。
 *
 * 守っていること:
 * - **本番と同じ表示部品を使う。** デモ専用の画面を別に作ると、
 *   そちらだけ直し忘れて、見せたものと本番が食い違う。
 * - 引くのはこのブラウザの中だけ。サーバーへは何も送らないし、記録も残らない。
 *   本番は「引く操作を受けたサーバーがその瞬間に決める」作りで、そこは共有しない。
 * - 自動で回している間も、いつでも止めて手で回せる。
 */

/** 1 回終わってから次を回し始めるまで。会場の反応が入るくらいの間。 */
const AUTO_GAP_MS = 2000;
/** 自動のとき、ルーレットの「スタート」から「ストップ」までの間。 */
const AUTO_SPIN_MS = 1800;
/** 全部引き終わってから、最初へ戻すまでの間。 */
const AUTO_RESTART_MS = 4000;

/**
 * 操作の帯の高さ (px)。
 *
 * この分だけ投影の 16:9 を縮めて、盤面の最後の行が帯へ隠れないようにする。
 * 帯は折り返さず横スクロールさせるので、狭い画面でも高さは変わらない。
 */
const CONTROL_BAR_HEIGHT = 64;

type DemoPhase = 'ready' | 'spinning' | 'revealed';

export function PresentDemo({ initialMode }: { initialMode: DemoMode }) {
  const [mode, setMode] = useState<DemoMode>(initialMode);
  const [drawn, setDrawn] = useState<DrawRecord[]>([]);
  const [phase, setPhase] = useState<DemoPhase>('ready');
  const [auto, setAuto] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);

  const fullscreen = useFullscreen();
  const [hintDismissed, setHintDismissed] = useState(false);

  /*
    音は本番の投影画面と同じ仕組みで鳴らす。
    ルームが無いので、一覧はデモ用の名前で取りに行く（差し替えていない
    既定の音がそのまま返る）。
  */
  const audio = useProjectorAudio('demo');
  const { play, startLoop, stopLoop } = audio;

  const draw = buildDemoDraw(mode, drawn);
  const isRoulette = mode === 'roulette';

  const roulette = useDrawRoulette({
    latestOrder: draw.latestOrder,
    winner: latestStageEntry(draw),
    candidates: remainingStageEntries(draw),
    intervalMs: draw.settings.spinIntervalMs,
    durationMs: draw.settings.spinDurationMs,
    // ルーレットは円盤そのものが回るので、候補を切り替える演出は使わない。
    enabled: !isRoulette,
  });

  const wheelSpinning = isRoulette && phase === 'spinning';
  const wheelRef = useRouletteWheel({
    entries: draw.entries,
    isSpinning: wheelSpinning,
    winnerId: draw.latestEntryId,
    latestOrder: draw.latestOrder,
    stopDurationMs: draw.settings.stopDurationMs,
  });

  useDrawSoundCues({
    play,
    startLoop,
    stopLoop,
    isUnlocked: audio.isUnlocked,
    spinning: isRoulette ? wheelSpinning : roulette.spinning,
    latestOrder: draw.latestOrder,
  });

  const exhausted = !isRoulette && draw.remainingCount === 0;

  /** 1 件引いて結果を出す。ルーレットでは「ストップ」にあたる。 */
  const drawNext = useCallback(() => {
    setDrawn((current) => {
      const picked = pickDemoEntry(mode, current, Math.random);
      if (!picked) {
        return current;
      }
      return [...current, { order: current.length + 1, entryId: picked.id }];
    });
    setPhase('revealed');
  }, [mode]);

  const startSpin = useCallback(() => {
    setPhase('spinning');
  }, []);

  const reset = useCallback(() => {
    setDrawn([]);
    setPhase('ready');
  }, []);

  const changeMode = useCallback((next: DemoMode) => {
    setMode(next);
    setDrawn([]);
    setPhase('ready');
    setHistoryOpen(false);
  }, []);

  /*
    自動で回し続ける。

    「引く → 演出が終わる → 少し置いて次」を繰り返す。
    次の一手だけをタイマーで予約し、何かを操作したら予約を捨てる
    （二重に回さないため）。
  */
  const stepRef = useRef<{ drawNext: () => void; startSpin: () => void; reset: () => void }>({
    drawNext,
    startSpin,
    reset,
  });
  useEffect(() => {
    stepRef.current = { drawNext, startSpin, reset };
  });

  useEffect(() => {
    if (!auto) {
      return;
    }

    let delay: number;
    let step: () => void;

    if (exhausted) {
      // 引き切ったら最初へ戻して、そのまま回し続ける。
      delay = AUTO_RESTART_MS;
      step = () => stepRef.current.reset();
    } else if (isRoulette && phase === 'spinning') {
      delay = AUTO_SPIN_MS;
      step = () => stepRef.current.drawNext();
    } else if (isRoulette) {
      // 止まってから次を回し始めるまで。減速にかかる時間も見込む。
      delay = phase === 'revealed' ? draw.settings.stopDurationMs + AUTO_GAP_MS : AUTO_GAP_MS;
      step = () => stepRef.current.startSpin();
    } else {
      /*
        回す時間そのものより、そのあとの減速のほうが長い。
        止まりきってから間を置くよう、合計から数える。
      */
      delay =
        phase === 'revealed'
          ? spinTotalMs(draw.settings.spinIntervalMs, draw.settings.spinDurationMs) + AUTO_GAP_MS
          : AUTO_GAP_MS;
      step = () => stepRef.current.drawNext();
    }

    const timer = window.setTimeout(step, delay);
    return () => {
      window.clearTimeout(timer);
    };
    // drawn.length を見ているのは、1 件引くごとに次を予約し直すため。
  }, [
    auto,
    exhausted,
    isRoulette,
    phase,
    drawn.length,
    draw.settings.spinIntervalMs,
    draw.settings.spinDurationMs,
    draw.settings.stopDurationMs,
  ]);

  /*
    盤面・履歴へ渡すのは「回し終わったぶんだけ」。
    回している最中に結果が盤面へ出ると、いちばん白ける。
  */
  const shownDraw = visibleDuringSpin(draw, roulette.spinning);

  let body;
  if (isRoulette) {
    body = (
      <RouletteStage
        draw={draw}
        wheelRef={wheelRef}
        spinning={wheelSpinning}
        revealed={phase === 'revealed'}
        winnerId={wheelSpinning ? null : draw.latestEntryId}
      />
    );
  } else if (mode === 'bingo') {
    body = (
      <BingoStage
        draw={shownDraw}
        display={roulette.display}
        spinning={roulette.spinning}
        revealed={phase === 'revealed'}
      />
    );
  } else {
    body = (
      <LotteryStage
        draw={shownDraw}
        display={roulette.display}
        spinning={roulette.spinning}
        revealed={phase === 'revealed'}
      />
    );
  }

  const busy = isRoulette ? wheelSpinning : roulette.spinning;

  return (
    <>
      <StageFrame bottomInset={controlsHidden ? 0 : CONTROL_BAR_HEIGHT}>
        <div className="flex min-h-0 flex-1 flex-col justify-center">{body}</div>
        {historyOpen ? (
          <DrawHistoryOverlay
            draw={shownDraw}
            ordered={mode === 'lottery'}
            onClose={() => {
              setHistoryOpen(false);
            }}
          />
        ) : null}
      </StageFrame>

      {/* 音が出せないときだけ案内を出す。デモでも画面は止めない。 */}
      {!audio.isUnlocked && !hintDismissed ? (
        <PresentAudioHint
          status={audio.status}
          testResult={audio.testResult}
          onEnable={() => {
            void audio.enable();
          }}
          onFullscreen={fullscreen.request}
          onDismiss={() => {
            setHintDismissed(true);
          }}
        />
      ) : null}

      {controlsHidden ? (
        <button
          type="button"
          onClick={() => {
            setControlsHidden(false);
          }}
          className="fixed bottom-4 left-4 z-[60] rounded-lg border border-white/30 bg-black/60 px-3 py-2 text-sm font-bold text-white/70"
        >
          操作を出す
        </button>
      ) : (
        <div
          /*
            一覧（z-50）より前に置く。後ろにすると、一覧を出している間だけ
            モードの切り替えも自動の停止もできなくなる。
          */
          className="fixed inset-x-0 bottom-0 z-[60] flex flex-nowrap items-center gap-2 overflow-x-auto bg-black/70 px-3 text-sm"
          style={{ height: CONTROL_BAR_HEIGHT }}
        >
          <span className="shrink-0 rounded-md bg-amber-300 px-2 py-1 text-xs font-bold text-black">
            デモ
          </span>

          {DEMO_MODES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                changeMode(value);
              }}
              className={cn(
                'shrink-0 rounded-lg border px-3 py-2 font-bold',
                value === mode
                  ? 'border-cyan-300 bg-cyan-300 text-black'
                  : 'border-white/30 text-white/80',
              )}
            >
              {DEMO_MODE_LABELS[value]}
            </button>
          ))}

          <span className="mx-1 h-6 w-px shrink-0 bg-white/20" aria-hidden="true" />

          {isRoulette && phase !== 'spinning' ? (
            <button
              type="button"
              onClick={startSpin}
              className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-300 px-4 py-2 font-bold text-black"
            >
              スタート
            </button>
          ) : (
            <button
              type="button"
              onClick={drawNext}
              /*
                ルーレットの「ストップ」は回っている最中にこそ押す。
                回している間を busy として塞ぐと、永久に止められなくなる。
              */
              disabled={isRoulette ? false : busy || exhausted}
              className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-300 px-4 py-2 font-bold text-black disabled:opacity-40"
            >
              {isRoulette ? 'ストップ' : '1つ引く'}
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setAuto((value) => !value);
            }}
            className={cn(
              'shrink-0 rounded-lg border px-4 py-2 font-bold',
              auto ? 'border-amber-300 bg-amber-300 text-black' : 'border-white/30 text-white/80',
            )}
          >
            {auto ? '自動を止める' : '自動で回す'}
          </button>

          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-lg border border-white/30 px-4 py-2 font-bold text-white/80"
          >
            最初から
          </button>

          <button
            type="button"
            onClick={() => {
              setHistoryOpen((open) => !open);
            }}
            className="shrink-0 rounded-lg border border-cyan-300/60 px-4 py-2 font-bold text-cyan-200"
          >
            {historyOpen ? '一覧を閉じる' : mode === 'lottery' ? '当選者一覧' : '出たもの'}
          </button>

          <span className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={fullscreen.toggle}
              className="shrink-0 rounded-lg border border-white/30 px-3 py-2 font-bold text-white/70"
            >
              {fullscreen.isFullscreen ? '全画面をやめる' : '全画面'}
            </button>
            <button
              type="button"
              onClick={() => {
                setControlsHidden(true);
              }}
              className="shrink-0 rounded-lg border border-white/30 px-3 py-2 font-bold text-white/70"
            >
              操作を隠す
            </button>
          </span>
        </div>
      )}
    </>
  );
}
