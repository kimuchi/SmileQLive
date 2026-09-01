'use client';

import { useCallback, useMemo, useState } from 'react';
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
 * 操作は スタート → ストップ → （リセット）。
 * スタートで等速に回り続け、ストップで減速して止まる。
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

  const fullscreen = useFullscreen();
  /*
    効果音は**案内も操作も出さずに**鳴らす。

    ブラウザは操作するまで音を鳴らさない決まりだが、このフックは
    画面のどこかを最初に触った時点で自動的に解除する。
    このルーレットは必ずスタートを押してから音が要るので、
    その 1 押しで解除が済む。会場で「効果音を有効にする」を
    探させないため、案内の帯もテストのボタンも置いていない。
  */
  const audio = useProjectorAudio(AUDIO_NAMESPACE, SOUND_MANIFEST_URL);

  const items = useMemo(() => usableItems(config), [config]);
  const spinnable = items.length >= 2;

  const handleStart = useCallback(() => {
    // 押した瞬間は操作の最中なので、ここでの解除はブラウザに通る。
    void audio.enable({ silent: true });
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
    spinSpeed: config.spinSpeed,
    stopSeconds: config.stopSeconds,
    onStart: handleStart,
    onSettle: handleSettle,
  });

  const running = spin.phase === 'spinning' || spin.phase === 'stopping';

  const handleReset = useCallback(() => {
    audio.stopLoop('draw-spin');
    spin.reset();
  }, [audio, spin]);

  const handleConfigChange = useCallback((next: RouletteConfig) => {
    setConfig(next);
    setNotice(null);
  }, []);

  return (
    <div
      className="relative flex min-h-dvh flex-col text-white lg:flex-row"
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
      <section className="relative flex min-h-[70dvh] flex-1 flex-col items-center justify-center gap-4 overflow-hidden p-4 lg:min-h-dvh">
        {config.backgroundUrl !== null ? (
          <>
            {/*
              背景は CSS の url() ではなく img で敷く。
              url() へ文字列を差し込むと、引用符や括弧の入った URL で
              スタイルの外へはみ出させられる（背景は URL に載って人から人へ渡る）。
              img の src なら、どんな文字列でも「その URL の画像」以上にはならない。

              next/image を使わないのは、任意の外部 URL と blob: をそのまま出すため。
            */}
            {/* eslint-disable-next-line @next/next/no-img-element -- 任意の外部 URL と blob: を出すため */}
            <img
              src={config.backgroundUrl}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover"
            />
            {/* 文字と扇が読めなくならないよう、暗い膜を 1 枚重ねる。 */}
            <div aria-hidden="true" className="absolute inset-0 bg-black/55" />
          </>
        ) : null}

        <div
          className={cn(
            'relative flex w-full flex-col items-center gap-4',
            // 設定欄を閉じたら盤面を大きくする。投影に出すときはこちらで使う。
            panelOpen ? 'max-w-[min(66vh,36rem)]' : 'max-w-[min(76vh,48rem)]',
          )}
        >
          <RouletteBoard
            items={items}
            wheelRef={spin.wheelRef}
            spinning={running}
            showLabels={config.showLabels}
            winnerLabel={spin.phase === 'stopped' ? (spin.result?.label ?? null) : null}
          />

          <p
            aria-live="polite"
            className={cn(
              'min-h-[2.4em] text-center leading-tight font-bold break-words',
              spin.phase === 'stopped' ? 'stage-pop-big text-amber-300' : 'text-cyan-200',
            )}
            style={{
              fontSize: 'clamp(1.5rem, 5vw, 3.5rem)',
              textShadow: '0 2px 12px rgba(0,0,0,0.7)',
            }}
          >
            {spin.phase === 'spinning'
              ? 'まわっています…'
              : spin.phase === 'stopping'
                ? 'とまります…'
                : (spin.result?.label ?? (spinnable ? 'スタートを押してください' : ''))}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" disabled={!spinnable || running} onClick={spin.start}>
              {spin.phase === 'stopped' ? 'もう一度まわす' : 'スタート'}
            </Button>
            <Button
              variant="danger"
              size="lg"
              disabled={spin.phase !== 'spinning'}
              onClick={spin.stop}
            >
              ストップ
            </Button>
            <Button variant="secondary" size="lg" disabled={running} onClick={handleReset}>
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
            disabled={running}
            onClose={() => {
              setPanelOpen(false);
            }}
          />
        </aside>
      ) : null}
    </div>
  );
}
