'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createProjectorAudioManager,
  describeFailure,
  type AudioReadiness,
  type ProjectorAudioManager,
  type SoundName,
} from '@/lib/audio/projector-audio-manager';
import type { RoomPhase } from '@/domain/room/state-machine';

/**
 * 投影画面の効果音を React から扱うためのフック。
 *
 * 約束:
 * - AudioContext を作るのは `enable()` だけ。`enable()` は操作者のクリックイベント内から呼ぶ。
 *   画面の表示・Snapshot の取得・再接続では音が鳴る余地を作らない。
 * - 音量・ミュート・「この端末で音を有効にしたか」は sessionStorage に保管する。
 *   タブを閉じれば消え、端末へ長く残らない。
 * - 効果音の再生要求には `${stateVersion}:${soundName}` のキーを添え、二重再生を防ぐ。
 */

const ENABLED_KEY_PREFIX = 'smileq.present.audioEnabled.';
const SETTINGS_KEY = 'smileq.present.audioSettings';
const DEFAULT_VOLUME = 0.8;

/** 音声テストで鳴らす音。 */
const TEST_SOUND: SoundName = 'question-start';

type AudioSettings = { volume: number; muted: boolean };

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readSettings(): AudioSettings {
  try {
    const raw = storage()?.getItem(SETTINGS_KEY);
    if (!raw) {
      return { volume: DEFAULT_VOLUME, muted: false };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { volume: DEFAULT_VOLUME, muted: false };
    }
    const record = parsed as Record<string, unknown>;
    const volume = typeof record.volume === 'number' ? record.volume : DEFAULT_VOLUME;
    const muted = typeof record.muted === 'boolean' ? record.muted : false;
    return { volume: Math.min(1, Math.max(0, volume)), muted };
  } catch {
    return { volume: DEFAULT_VOLUME, muted: false };
  }
}

function writeSettings(settings: AudioSettings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 保管できなくても進行は続けられる。
  }
}

function readEnabledFlag(roomId: string): boolean {
  try {
    return storage()?.getItem(`${ENABLED_KEY_PREFIX}${roomId}`) === '1';
  } catch {
    return false;
  }
}

function writeEnabledFlag(roomId: string): void {
  try {
    storage()?.setItem(`${ENABLED_KEY_PREFIX}${roomId}`, '1');
  } catch {
    // 保管できなくても進行は続けられる。
  }
}

/** 投影準備の画面へ出す、効果音の状態。 */
export type AudioStatus =
  /** まだ投影開始の操作をしていない。 */
  | { kind: 'idle' }
  /** 読み込み中。 */
  | { kind: 'loading' }
  /** すべて鳴らせる。 */
  | { kind: 'ready'; count: number }
  /** 一部または全部が鳴らせない。理由つき。 */
  | { kind: 'partial'; count: number; total: number; problems: string[] };

export type ProjectorAudio = {
  /** 効果音を鳴らせる状態か。 */
  isUnlocked: boolean;
  muted: boolean;
  volume: number;
  /** 音源が見つからないなど、操作者へ伝えたい注意。 */
  warning: string | null;
  /** 何件鳴らせるか・何が足りないか。会場で原因を切り分けるために必ず表示する。 */
  status: AudioStatus;
  /** 音声テストの結果（押すたびに更新）。 */
  testResult: string | null;
  /** 以前この端末（タブ）で音を有効にしたか。案内文の出し分けに使う。 */
  previouslyEnabled: boolean;
  /**
   * AudioContext を作り、音源の先読みを始める。
   *
   * 読み込み直後と最初の操作で自動的に呼ばれるので、ふだん画面側から呼ぶ必要はない。
   * `silent` を付けると、解除できなくても注意文を出さない（自動で試すとき用）。
   */
  enable: (options?: { silent?: boolean }) => Promise<void>;
  /** 動作確認用に 1 音鳴らす（二重再生防止の対象外）。結果は testResult に入る。 */
  playTest: () => Promise<void>;
  play: (name: SoundName, dedupeKey?: string) => void;
  /** 鳴らし続ける（回答時間中のタイマー音）。 */
  startLoop: (name: SoundName) => void;
  stopLoop: (name: SoundName) => void;
  /** 読み込み済みの音の長さ（秒）。素材に合わせて次の演出を出すために使う。 */
  durationOf: (name: SoundName) => number | null;
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
};

function toStatus(readiness: AudioReadiness): AudioStatus {
  const total = readiness.ready.length + readiness.failed.length;
  if (!readiness.manifestOk) {
    return {
      kind: 'partial',
      count: 0,
      total: 0,
      problems: ['効果音の一覧 (/sounds/manifest.json) を読み込めませんでした'],
    };
  }
  if (readiness.failed.length === 0 && readiness.ready.length > 0) {
    return { kind: 'ready', count: readiness.ready.length };
  }
  return {
    kind: 'partial',
    count: readiness.ready.length,
    total,
    problems: readiness.failed.map((failure) => describeFailure(failure.name, failure.reason)),
  };
}

export function useProjectorAudio(roomId: string): ProjectorAudio {
  const managerRef = useRef<ProjectorAudioManager | null>(null);

  const [isUnlocked, setIsUnlocked] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [warning, setWarning] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioStatus>({ kind: 'idle' });
  const [testResult, setTestResult] = useState<string | null>(null);
  const [previouslyEnabled, setPreviouslyEnabled] = useState(false);

  useEffect(() => {
    const settings = readSettings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: roomId,
      volume: settings.volume,
      muted: settings.muted,
      onWarning: setWarning,
    });
    managerRef.current = manager;

    // sessionStorage はブラウザにしか無く、レンダー中に読むとサーバー描画と食い違う。
    // そのため生成直後にここで一度だけ state へ反映する。
    /* eslint-disable react-hooks/set-state-in-effect -- 保存済み設定はレンダー中に読めないため */
    setVolumeState(settings.volume);
    setMutedState(settings.muted);
    setPreviouslyEnabled(readEnabledFlag(roomId));
    /* eslint-enable react-hooks/set-state-in-effect */

    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, [roomId]);

  const enable = useCallback(
    async (options: { silent?: boolean } = {}): Promise<void> => {
      const manager = managerRef.current;
      if (!manager) {
        return;
      }
      if (!options.silent) {
        setWarning(null);
      }

      // AudioContext の生成はこの呼び出しの同期部分で行われる（クリックの有効期間を使う）。
      await manager.unlock({ silent: options.silent ?? false });
      setIsUnlocked(manager.isUnlocked);

      if (manager.isUnlocked) {
        writeEnabledFlag(roomId);
        setPreviouslyEnabled(true);
      } else if (options.silent) {
        // 自動で試して駄目だっただけ。次の操作で解除されるので、まだ何も言わない。
        return;
      }

      // 先読みは待たない。待つと全画面要求までにクリックの有効期間を使い切ってしまう。
      // 結果は届き次第、画面へ出す（黙って失敗させない）。
      setStatus({ kind: 'loading' });
      void manager.preload().then((readiness) => {
        if (managerRef.current === manager) {
          setStatus(toStatus(readiness));
        }
      });
    },
    [roomId],
  );

  /**
   * 操作なしで音を出せるようにする。
   *
   * 会場の投影担当に「まずこのボタンを押してください」を強いると、
   * 押し忘れたときに画面が黙って止まったように見える。そこで:
   *
   *   1. 読み込み直後に一度だけ静かに試す。
   *      ブラウザの設定でこのサイトの自動再生が許可されていれば、これで鳴るようになる。
   *   2. 駄目なら、画面のどこかを触った**最初の一回**で解除する。
   *      「効果音を有効にする」を押す必要はない（押しても同じことが起きる）。
   *
   * どちらも失敗しても画面は動き続ける。音だけが出ない。
   */
  useEffect(() => {
    if (isUnlocked) {
      return;
    }

    let cancelled = false;
    // 解除できたかどうかはブラウザに聞くしかない（レンダー中には分からない）。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 解除の可否はブラウザへ問い合わせないと分からないため
    void enable({ silent: true });

    const handleGesture = (): void => {
      if (cancelled) {
        return;
      }
      void enable({ silent: true });
    };

    // capture で拾う。画面の中の要素が止めても、ここまでは必ず届く。
    const options = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', handleGesture, options);
    window.addEventListener('keydown', handleGesture, options);
    window.addEventListener('touchend', handleGesture, options);

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', handleGesture, options);
      window.removeEventListener('keydown', handleGesture, options);
      window.removeEventListener('touchend', handleGesture, options);
    };
  }, [enable, isUnlocked]);

  const play = useCallback((name: SoundName, dedupeKey?: string): void => {
    managerRef.current?.play(name, dedupeKey);
  }, []);

  const startLoop = useCallback((name: SoundName): void => {
    managerRef.current?.startLoop(name);
  }, []);

  const stopLoop = useCallback((name: SoundName): void => {
    managerRef.current?.stopLoop(name);
  }, []);

  const durationOf = useCallback(
    (name: SoundName): number | null => managerRef.current?.durationOf(name) ?? null,
    [],
  );

  const playTest = useCallback(async (): Promise<void> => {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    setTestResult(null);
    // 動作確認は何度でも鳴らせるようにキーを渡さない。
    const result = await manager.playTest(TEST_SOUND);
    setTestResult(result.ok ? 'テスト音を鳴らしました。会場のスピーカーを確認してください。' : (result.reason ?? '鳴らせませんでした'));
  }, []);

  const setMuted = useCallback(
    (next: boolean): void => {
      managerRef.current?.setMuted(next);
      setMutedState(next);
      writeSettings({ volume, muted: next });
    },
    [volume],
  );

  const setVolume = useCallback(
    (next: number): void => {
      const clamped = Math.min(1, Math.max(0, next));
      managerRef.current?.setVolume(clamped);
      setVolumeState(clamped);
      writeSettings({ volume: clamped, muted });
    },
    [muted],
  );

  return {
    isUnlocked,
    muted,
    volume,
    warning,
    status,
    testResult,
    previouslyEnabled,
    enable,
    playTest,
    play,
    startLoop,
    stopLoop,
    durationOf,
    setMuted,
    setVolume,
  };
}

/**
 * フェーズごとに鳴らす音。ここに無いフェーズでは鳴らさない。
 *
 * scoreboard で鳴らすのは「ためる音」。
 * ランキングそのものの発表音（fanfare）は、ためる音が鳴り終わってから
 * RankingStage の表示に合わせて鳴らす（PresentScreen 側）。
 */
const PHASE_SOUND: Partial<Record<RoomPhase, SoundName>> = {
  question_open: 'question-start',
  question_locked: 'answer-lock',
  answer_revealed: 'answer-reveal',
  scoreboard: 'ranking',
  finished: 'finish',
};

// 抽選会・ビンゴの音はフェーズでは鳴らさない。
// draw_revealed へ入った瞬間はまだルーレットを回している最中で、
// そこで当選音を鳴らすと結果より先に音が出てしまう。
// 回し終わったところで useDrawSoundCues が鳴らす。

/**
 * ルームの状態変化から効果音を鳴らす。
 *
 * - 画面を開いた直後に見えた状態では鳴らさない（進行中のルームへ後から繋いだとき、
 *   いきなり正解音や終了音が鳴らないようにする）。
 * - タイマー音は残り秒数を見ない。受付が開いている間ずっと鳴らし、締まったら止める。
 * - すべての再生要求に `${stateVersion}:...` のキーを添えるため、
 *   Snapshot を取り直しても、画面を再読込しても同じ音は二度鳴らない。
 */
export function useStageSoundCues({
  play,
  startLoop,
  stopLoop,
  isUnlocked,
  phase,
  stateVersion,
}: {
  play: (name: SoundName, dedupeKey?: string) => void;
  startLoop: (name: SoundName) => void;
  stopLoop: (name: SoundName) => void;
  /** 効果音を鳴らせる状態か（投影開始の操作が済んでいるか）。 */
  isUnlocked: boolean;
  phase: RoomPhase | null;
  stateVersion: number | null;
}): void {
  /**
   * 直前に観測したフェーズ。null なら未観測。
   *
   * **状態番号ではなくフェーズで見る。** 回答時間を延長すると状態番号だけが増えて
   * フェーズは question_open のままなので、番号で見ていると出題音が鳴り直してしまう。
   */
  const lastPhaseRef = useRef<RoomPhase | null>(null);

  useEffect(() => {
    if (phase === null || stateVersion === null) {
      return;
    }
    if (lastPhaseRef.current === phase) {
      // 同じフェーズのまま状態番号だけが変わった（回答時間の延長など）。鳴らさない。
      return;
    }
    const isFirstObservation = lastPhaseRef.current === null;
    lastPhaseRef.current = phase;
    if (isFirstObservation) {
      // 接続直後の状態は「変化」ではないため鳴らさない。
      return;
    }
    const sound = PHASE_SOUND[phase];
    if (sound) {
      play(sound, `${stateVersion}:${sound}`);
    }
  }, [phase, play, stateVersion]);

  /**
   * 回答時間のタイマー音。
   *
   * 受付が開いている間ずっと鳴らす。残りわずかのときだけ鳴らす作りだと、
   * 「あと何秒か」が音から分からず、残り時間の緊張も伝わらない。
   * 素材が短くても繰り返して最後まで鳴らす。
   *
   * `isUnlocked` も見る。**出題中に投影画面を開き直した場合**、
   * 音がまだ解除されていない状態でこの効果が走る。そこで諦めてしまうと、
   * 解除されたあとも鳴り始めず、その問題は最後まで無音になる。
   */
  useEffect(() => {
    if (!isUnlocked || phase !== 'question_open') {
      stopLoop('tick');
      return;
    }
    startLoop('tick');
    return () => {
      stopLoop('tick');
    };
  }, [isUnlocked, phase, startLoop, stopLoop]);
}

/**
 * 抽選会・ビンゴの効果音。
 *
 * - 回している間はずっと `draw-spin`（繰り返し再生）
 * - 回し終わって当たりが見えた瞬間に `draw-win`
 *
 * **フェーズでは鳴らさない。** 引いた直後はまだ回している最中で、
 * そこで当選音を鳴らすと結果より先に音が出てしまう。
 * 「回し終わった」を合図にするのが、会場での見え方と合う。
 */
export function useDrawSoundCues({
  play,
  startLoop,
  stopLoop,
  isUnlocked,
  spinning,
  latestOrder,
}: {
  play: (name: SoundName, dedupeKey?: string) => void;
  startLoop: (name: SoundName) => void;
  stopLoop: (name: SoundName) => void;
  isUnlocked: boolean;
  /** ルーレットを回している最中か。 */
  spinning: boolean;
  /** 直近に引いたものの通し番号。同じ番号で二度鳴らさないための鍵。 */
  latestOrder: number | null;
}): void {
  useEffect(() => {
    if (!isUnlocked || !spinning) {
      stopLoop('draw-spin');
      return;
    }
    startLoop('draw-spin');
    return () => {
      stopLoop('draw-spin');
    };
  }, [isUnlocked, spinning, startLoop, stopLoop]);

  /** 当選音を鳴らし終えた通し番号。取り直しで鳴り直さないようにする。 */
  const soundedOrderRef = useRef<number | null>(null);
  /** 直前に回していたか。回し終わった瞬間だけを拾う。 */
  const wasSpinningRef = useRef(false);

  useEffect(() => {
    const wasSpinning = wasSpinningRef.current;
    wasSpinningRef.current = spinning;

    if (!isUnlocked || latestOrder === null) {
      return;
    }
    // 回し終わった瞬間だけ鳴らす。
    if (!wasSpinning || spinning) {
      return;
    }
    if (soundedOrderRef.current === latestOrder) {
      return;
    }
    soundedOrderRef.current = latestOrder;
    play('draw-win', `draw:${latestOrder}`);
  }, [isUnlocked, latestOrder, play, spinning]);
}
