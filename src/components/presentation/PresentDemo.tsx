'use client';

import { useCallback, useState } from 'react';
import { CONTROL_BAR_HEIGHT, DemoControlBar } from '@/components/presentation/DemoControlBar';
import { DrawStageBody } from '@/components/presentation/DrawStageBody';
import { PresentAudioHint } from '@/components/presentation/PresentAudioHint';
import { StageFrame } from '@/components/presentation/StageFrame';
import { useFullscreen } from '@/components/presentation/use-fullscreen';
import { useProjectorAudio } from '@/components/presentation/use-projector-audio';
import {
  buildDemoPool,
  DEMO_MODE_LABELS,
  DEMO_MODES,
  type DemoMode,
} from '@/domain/draw/demo-draw';
import { useLocalDraw } from '@/hooks/use-local-draw';
import { cn } from '@/lib/client/cn';

/**
 * 投影画面のデモ（見本のデータ）。
 *
 * ルームもログインも要らない。この画面だけで抽選会・ビンゴ・ルーレットを回せる。
 * 「導入するとどんな画面になるのか」をその場で見せるためのもの。
 *
 * 自分で用意した抽選リストで見せたいときは、**投影画面のデモ切り替え**を使う
 * （司会画面から投影用リンクを開き、帯の「デモ」を押す）。
 */
export function PresentDemo({ initialMode }: { initialMode: DemoMode }) {
  const [mode, setMode] = useState<DemoMode>(initialMode);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);

  const fullscreen = useFullscreen();

  /*
    音は本番の投影画面と同じ仕組みで鳴らす。

    ここにはルームが無いので、同梱の一覧を直接読む。
    ルームごとの取得先は UUID しか受け付けず、`demo` では 404 になる
    （実際にそうなっていて、デモの音がまったく鳴らなかった）。
    自分で差し替えた音で見せたいときは、投影画面の「デモで試す」を使う。
  */
  const audio = useProjectorAudio('demo', '/sounds/manifest.json');

  const local = useLocalDraw({
    pool: buildDemoPool(mode),
    mode,
    active: true,
    poolKey: `demo:${mode}`,
  });

  const changeMode = useCallback((next: DemoMode) => {
    setMode(next);
    setHistoryOpen(false);
  }, []);

  return (
    <>
      <StageFrame bottomInset={controlsHidden ? 0 : CONTROL_BAR_HEIGHT}>
        <DrawStageBody
          draw={local.draw}
          mode={mode}
          phase={local.phase}
          audio={audio}
          historyOpen={historyOpen}
          onCloseHistory={() => {
            setHistoryOpen(false);
          }}
        />
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
        <DemoControlBar
          isRoulette={mode === 'roulette'}
          spinning={local.phase === 'spinning'}
          exhausted={local.exhausted}
          auto={local.auto}
          onDrawNext={local.drawNext}
          onStartSpin={local.startSpin}
          onReset={local.reset}
          onToggleAuto={() => {
            local.setAuto(!local.auto);
          }}
          leading={DEMO_MODES.map((value) => (
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
          trailing={
            <>
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen((open) => !open);
                }}
                className="shrink-0 rounded-lg border border-cyan-300/60 px-4 py-2 font-bold text-cyan-200"
              >
                {historyOpen ? '一覧を閉じる' : mode === 'lottery' ? '当選者一覧' : '出たもの'}
              </button>
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
            </>
          }
        />
      )}
    </>
  );
}
