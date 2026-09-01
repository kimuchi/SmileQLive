'use client';

import { useCallback, useMemo, useState } from 'react';
import { PresentAudioHint } from '@/components/presentation/PresentAudioHint';
import { RouletteBoard } from '@/components/presentation/RouletteBoard';
import { useFullscreen } from '@/components/presentation/use-fullscreen';
import { useProjectorAudio } from '@/components/presentation/use-projector-audio';
import { RouletteSettingsPanel } from '@/components/roulette/roulette-settings-panel';
import { Button } from '@/components/shared/Button';
import { isSpinnable, usableItems, type RouletteConfig } from '@/domain/roulette/wheel';
import { useRouletteSpin, type RouletteResult } from '@/hooks/use-roulette-spin';
import { cn } from '@/lib/client/cn';

/**
 * URL だけで回すルーレット。
 *
 * **ログインもルームも要らない。** 盤面は URL に載っていて、
 * サーバーへは何も送らないし記録も残らない。
 * 会議の司会決め・席替え・罰ゲームのように「その場で開いて 1 回まわす」ためのもの。
 *
 * ルームを作って進める抽選会のルーレット（`/present/{roomId}`）とは別物。
 * あちらはサーバーが引いて記録し、司会と投影で画面が分かれる。
 *
 * 効果音だけはサーバーの設定を読む（システム全体で 1 つ・ログイン不要）。
 * 差し替えた音がこの画面でもそのまま鳴るようにするため。
 */

/** 効果音の一覧の取得先。ルームを持たないので、システム全体の一覧を読む。 */
const SOUND_MANIFEST_URL = '/api/sound-settings/manifest';

/** 二重再生を防ぐ記録を分ける鍵。ルーム ID の代わり。 */
const AUDIO_NAMESPACE = 'roulette';

/**
 * 暗い盤面の上に置く控えめなボタンの色。
 *
 * 共有部品の ghost は明るい管理画面向けで、文字が濃い灰色。
 * そのまま置くと投影の暗い背景に沈んで読めない（実際に見えなかった）。
 */
const DARK_GHOST_CLASS = 'text-white/85 hover:bg-white/10 active:bg-white/20';

export function StandaloneRoulette({
  initialConfig,
  /** URL が壊れていて読めなかったか。読めなかったときだけ最初から設定欄を開く。 */
  initialNotice,
}: {
  initialConfig: RouletteConfig;
  initialNotice: string | null;
}) {
  const [config, setConfig] = useState<RouletteConfig>(initialConfig);
  const [panelOpen, setPanelOpen] = useState(!isSpinnable(initialConfig));
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [hintDismissed, setHintDismissed] = useState(false);

  const fullscreen = useFullscreen();
  const audio = useProjectorAudio(AUDIO_NAMESPACE, SOUND_MANIFEST_URL);

  const items = useMemo(() => usableItems(config), [config]);
  const spinnable = items.length >= 2;

  const handleStart = useCallback(() => {
    // 回している間ずっと鳴らす。止まったところで止める。
    audio.startLoop('draw-spin');
  }, [audio]);

  const handleSettle = useCallback(
    (result: RouletteResult) => {
      audio.stopLoop('draw-spin');
      audio.play('draw-win', `roulette:${String(result.order)}`);
    },
    [audio],
  );

  const spin = useRouletteSpin({
    items,
    decel: config.decel,
    onStart: handleStart,
    onSettle: handleSettle,
  });

  const spinning = spin.phase === 'spinning';

  const handleReset = useCallback(() => {
    audio.stopLoop('draw-spin');
    spin.reset();
  }, [audio, spin]);

  const handleConfigChange = useCallback((next: RouletteConfig) => {
    setConfig(next);
    setNotice(null);
  }, []);

  /*
    音が出せないときの案内は画面の下へ固定で出る。

    投影画面では下に何も置いていないので重ならないが、この画面は
    スタート・リセットが下寄りにある。案内が出ている間だけ下を空けないと、
    案内の帯がボタンの上に乗って**押せなくなる**（実際にそうなった）。
  */
  const audioHintVisible = !audio.isUnlocked && !hintDismissed;

  return (
    <div
      className="flex min-h-dvh flex-col text-white lg:flex-row"
      /*
        投影画面と同じ背景。`.stage-root` を使わないのは、あちらが
        高さ 100dvh と overflow:hidden を持っており、設定欄を横に並べる
        この画面では下がはみ出して切れてしまうため。
      */
      style={{
        background:
          'radial-gradient(ellipse at top, var(--color-stage-800) 0%, var(--color-stage-950) 70%)',
      }}
    >
      {/* --- 盤面 --- */}
      <section
        className={cn(
          'relative flex min-h-[70dvh] flex-1 flex-col items-center justify-center gap-4 p-4 lg:min-h-dvh',
          audioHintVisible && 'pb-32',
        )}
      >
        <div
          className={cn(
            'flex w-full flex-col items-center gap-4',
            // 設定欄を閉じたら盤面を大きくする。投影に出すときはこちらで使う。
            panelOpen ? 'max-w-[min(66vh,36rem)]' : 'max-w-[min(76vh,48rem)]',
          )}
        >
          <RouletteBoard
            items={items}
            wheelRef={spin.wheelRef}
            spinning={spinning}
            showLabels={config.showLabels}
            winnerLabel={spin.phase === 'stopped' ? (spin.result?.label ?? null) : null}
          />

          <p
            aria-live="polite"
            className={cn(
              'min-h-[2.4em] text-center leading-tight font-bold break-words',
              spin.phase === 'stopped' ? 'stage-pop-big text-amber-300' : 'text-cyan-200',
            )}
            style={{ fontSize: 'clamp(1.5rem, 5vw, 3.5rem)' }}
          >
            {spinning
              ? 'まわっています…'
              : (spin.result?.label ?? (spinnable ? 'スタートを押してください' : ''))}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" disabled={!spinnable || spinning} onClick={spin.start}>
              {spin.phase === 'stopped' ? 'もう一度まわす' : 'スタート'}
            </Button>
            <Button variant="secondary" size="lg" disabled={spinning} onClick={handleReset}>
              リセット
            </Button>
            {!panelOpen ? (
              <Button
                variant="ghost"
                size="md"
                className={DARK_GHOST_CLASS}
                onClick={() => {
                  setPanelOpen(true);
                }}
              >
                設定
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="md"
              className={DARK_GHOST_CLASS}
              onClick={() => {
                fullscreen.toggle();
              }}
            >
              {fullscreen.isFullscreen ? '全画面をやめる' : '全画面'}
            </Button>
          </div>

          {!spinnable ? (
            <p className="text-center text-sm text-amber-200">
              項目を 2 つ以上入れると回せます。設定から入れてください。
            </p>
          ) : null}

          {spin.history.length > 1 ? (
            <ol className="flex max-h-24 w-full flex-wrap justify-center gap-x-3 gap-y-1 overflow-y-auto text-sm text-white/70">
              {spin.history.slice(1).map((entry) => (
                <li key={entry.order}>
                  {entry.order}回目 {entry.label}
                </li>
              ))}
            </ol>
          ) : null}
        </div>

        {/* 音が出せないときだけ案内を出す。案内が出ていても回せる。 */}
        {audioHintVisible ? (
          <PresentAudioHint
            status={audio.status}
            testResult={audio.testResult}
            onEnable={() => {
              void audio.enable();
            }}
            onFullscreen={() => {
              fullscreen.request();
            }}
            onDismiss={() => {
              setHintDismissed(true);
            }}
          />
        ) : null}
      </section>

      {/* --- 設定 --- */}
      {panelOpen ? (
        <aside className="w-full shrink-0 overflow-y-auto bg-white p-4 text-slate-900 lg:max-h-dvh lg:w-[26rem]">
          {notice !== null ? (
            <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm font-bold text-amber-800">
              {notice}
            </p>
          ) : null}
          <RouletteSettingsPanel
            config={config}
            onChange={handleConfigChange}
            disabled={spinning}
            onClose={() => {
              setPanelOpen(false);
            }}
          />
        </aside>
      ) : null}
    </div>
  );
}
