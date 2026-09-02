'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RouletteBoard } from '@/components/presentation/RouletteBoard';
import { StageBurst, StageConfetti, StageFlash } from '@/components/presentation/StageEffects';
import { useFullscreen } from '@/components/presentation/use-fullscreen';
import { useProjectorAudio } from '@/components/presentation/use-projector-audio';
import { RouletteSettingsPanel } from '@/components/roulette/roulette-settings-panel';
import { Button } from '@/components/shared/Button';
import { isSpinnable, usableItems, type RouletteConfig } from '@/domain/roulette/wheel';
import { useRouletteSpin, type RouletteResult } from '@/hooks/use-roulette-spin';
import { cn } from '@/lib/client/cn';
import {
  readSavedRouletteBoard,
  saveRouletteBoard,
  syncRouletteUrl,
} from '@/lib/client/roulette-storage';

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

/** 設定を URL とこの端末へ書き戻すまでの待ち時間。打鍵のたびに書かない。 */
const SAVE_DEBOUNCE_MS = 400;

export function StandaloneRoulette({
  initialConfig,
  /** URL が壊れていて読めなかったか。読めなかったときだけ最初から設定欄を開く。 */
  initialNotice,
  /**
   * URL に盤面が付いていなかったか。
   *
   * 付いていなければ、この端末に控えてある前回の内容へ戻す。
   * 付いているときは戻さない。**渡された URL のほうが新しい意図**だから。
   */
  restoreSaved,
}: {
  initialConfig: RouletteConfig;
  initialNotice: string | null;
  restoreSaved: boolean;
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
      // 当選音とファンファーレを重ねて鳴らす。1 音だけだと会場では
      // 「止まった」ようにしか聞こえず、決まった感じが出ない。
      audio.play('draw-win', `roulette:win:${String(result.order)}`);
      audio.play('fanfare', `roulette:fanfare:${String(result.order)}`);
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
  /** 止まって結果が出ている状態。演出はここでだけ出す。 */
  const settled = spin.phase === 'stopped' && spin.result !== null;

  const handleReset = useCallback(() => {
    audio.stopLoop('draw-spin');
    spin.reset();
  }, [audio, spin]);

  const handleConfigChange = useCallback((next: RouletteConfig) => {
    setConfig(next);
    setNotice(null);
  }, []);

  /*
    前回の内容を戻す。

    URL に盤面が付いていないときだけ。付いているときに上書きすると、
    人から渡された URL を開いても自分の前回の盤面が出てしまう。
    書き戻し（下の効果）より先に済ませる必要があるので、ref で順番を作る。
  */
  const restoredRef = useRef(!restoreSaved);
  useEffect(() => {
    if (restoredRef.current) {
      return;
    }
    restoredRef.current = true;

    const saved = readSavedRouletteBoard(() => crypto.randomUUID());
    if (!saved) {
      return;
    }
    /* eslint-disable react-hooks/set-state-in-effect -- 控えはブラウザにしか無く、レンダー中に読めないため */
    setConfig(saved);
    setNotice('前回の内容を出しました。作り直すときは項目を書き換えてください。');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  /*
    設定を URL とこの端末へ書き戻す。

    **これが無いと、読み込み直した瞬間に設定が消える**（実際に消えた）。
    盤面の置き場所は URL なので、触ったらアドレス欄も合わせておく。
    打鍵のたびに書くと重いので、少し待ってからまとめて書く。
  */
  useEffect(() => {
    if (!restoredRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      syncRouletteUrl(config);
      saveRouletteBoard(config);
    }, SAVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [config]);

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
      {/*
        --- 盤面と操作 ---

        横長（投影・ノートパソコン）では**盤面を画面の高さいっぱい**に出し、
        結果とボタンはその右へ置く。縦長（スマートフォン）では上下に積む。

        `landscape` は画面の向きそのもの。幅の断点（lg など）で分けると、
        横長でも幅の狭い投影機で縦積みになってしまう。
      */}
      <section
        /*
          演出（光線・輪・紙吹雪）は cqw で寸法を決めている。
          ここを問い合わせ対象にしておかないと、投影機の大きさに比例しない。
        */
        style={{ containerType: 'inline-size' }}
        className={cn(
          'relative overflow-hidden lg:flex-1 landscape:h-dvh',
          /*
            高さははっきり決める。min-height だけにすると、中の
            container-type: size が寸法を決められず盤面が消える（実際に消えた）。

            縦長で設定欄を開いているときだけ少し縮める。画面いっぱいにすると、
            項目を入れるために毎回スクロールさせることになる。
          */
          panelOpen ? 'h-[60dvh]' : 'h-dvh',
        )}
      >
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
          </>
        ) : null}

        {/*
          決まった瞬間の演出。閃光と紙吹雪は画面全体へ。
          **光線と輪は結果の文字の側だけ**に置く（下の列の中）。
          円盤の上まで広げると、扇の名前が読みにくくなる。
        */}
        {settled ? (
          <>
            <StageFlash burst={spin.result?.order ?? 0} />
            <StageConfetti burst={spin.result?.order ?? 0} />
          </>
        ) : null}

        <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-4 p-3 landscape:flex-row landscape:gap-5">
          {/*
            盤面。置ける場所の**短いほう**に合わせて正方形にする。
            container-type: size と cqmin を使うのは、高さと幅のどちらが
            足りないかを CSS だけで判断させるため（縦長でも横長でも同じ書き方で済む）。
            98% にしているのは、真上の針が枠から出ているぶんの逃げ。
          */}
          <div
            /*
              `self-stretch` が要る。親は items-center なので、これが無いと
              高さが中身なりになる。container-type: size は中身を寸法から
              切り離すので、中身なり＝**高さ 0** になって盤面が消える（実際に消えた）。
            */
            className="flex min-h-0 w-full flex-1 items-center justify-center self-stretch landscape:w-auto"
            style={{ containerType: 'size' }}
          >
            <div style={{ width: '98cqmin', height: '98cqmin' }}>
              <RouletteBoard
                items={items}
                wheelRef={spin.wheelRef}
                spinning={running}
                showLabels={config.showLabels}
                winnerLabel={spin.phase === 'stopped' ? (spin.result?.label ?? null) : null}
              />
            </div>
          </div>

          {/*
            結果とボタン。横長では盤面の右へ縦に並べる。

            幅は画面の 3 割。固定幅にすると、狭い画面では盤面を食いつぶし、
            広い画面では決まった名前が入りきらない。
          */}
          <div className="relative flex w-full shrink-0 flex-col items-center gap-4 landscape:w-[30%] landscape:max-w-[34rem] landscape:min-w-[16rem] landscape:items-stretch">
            {/*
              光線と輪は**名前のうしろ**に置く。列の真ん中へ置くと
              中心がボタンの側へずれて、どこが決まったのか分かりにくい。
            */}
            <div className="relative flex items-center justify-center">
              {settled ? <StageBurst burst={spin.result?.order ?? 0} /> : null}

              <p
                aria-live="polite"
                // 回すたびに演出をやり直す。同じ名前が続けて出ても「決まった」と分かる。
                key={settled ? `result-${String(spin.result?.order ?? 0)}` : spin.phase}
                className={cn(
                  'relative z-10 min-h-[2.2em] text-center leading-tight font-bold break-words',
                  /*
                  決まった名前は**塗りつぶしの明るい色**にする。
                  金色のきらめき（stage-shine）は文字そのものを透明にして描くので、
                  暗い背景や背景画像の上では読みづらくなった。
                  会場の後方から読めることを優先する。
                */
                  settled ? 'stage-slam text-amber-300' : 'text-cyan-200',
                )}
                style={{
                  /*
                  決まった名前は会場の後方から読めるところまで大きく出す。
                  途中の案内は同じ大きさだと騒がしいので、そちらは控えめにする。
                */
                  fontSize: settled ? 'clamp(2rem, 5.2vw, 6rem)' : 'clamp(1.25rem, 2.2vw, 2.25rem)',
                  // 背景画像の上でも読めるよう、膜の代わりに字の側へ影を付ける。
                  textShadow: '0 2px 10px rgba(0,0,0,0.85), 0 0 28px rgba(0,0,0,0.65)',
                }}
              >
                {spin.phase === 'spinning'
                  ? 'まわっています…'
                  : spin.phase === 'stopping'
                    ? 'とまります…'
                    : (spin.result?.label ?? (spinnable ? 'スタートを押してください' : ''))}
              </p>
            </div>

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
              {/*
                設定は**開いていても出したままにする**。
                押したら消える作りだったので、閉じ方が分からなくなっていた。
              */}
              <Button
                variant="ghost"
                size="md"
                className={DARK_GHOST_CLASS}
                onClick={() => {
                  setPanelOpen((previous) => !previous);
                }}
              >
                {panelOpen ? '設定を閉じる' : '設定'}
              </Button>
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
              <p
                className="text-center text-sm text-amber-200"
                style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}
              >
                項目を 2 つ以上入れると回せます。設定から入れてください。
              </p>
            ) : null}

            {spin.history.length > 1 ? (
              <ol className="flex max-h-24 w-full flex-wrap justify-center gap-x-3 gap-y-1 overflow-y-auto text-sm text-white/80">
                {spin.history.slice(1).map((entry) => (
                  <li key={entry.order} style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>
                    {entry.order}回目 {entry.label}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
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
