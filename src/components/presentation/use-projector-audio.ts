'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createProjectorAudioManager,
  type ProjectorAudioManager,
  type SoundName,
} from '@/lib/audio/projector-audio-manager';
import type { RoomPhase } from '@/domain/room/state-machine';
import { shouldPlayTick } from '@/domain/room/timer';

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

export type ProjectorAudio = {
  /** 効果音を鳴らせる状態か。 */
  isUnlocked: boolean;
  muted: boolean;
  volume: number;
  /** 音源が見つからないなど、操作者へ伝えたい注意。 */
  warning: string | null;
  /** 以前この端末（タブ）で音を有効にしたか。案内文の出し分けに使う。 */
  previouslyEnabled: boolean;
  /** **クリックイベント内から呼ぶこと。** AudioContext を作り、音源の先読みを始める。 */
  enable: () => Promise<void>;
  /** 動作確認用に 1 音鳴らす（二重再生防止の対象外）。 */
  playTest: () => void;
  play: (name: SoundName, dedupeKey?: string) => void;
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
};

export function useProjectorAudio(roomId: string): ProjectorAudio {
  const managerRef = useRef<ProjectorAudioManager | null>(null);

  const [isUnlocked, setIsUnlocked] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [warning, setWarning] = useState<string | null>(null);
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

  const enable = useCallback(async (): Promise<void> => {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    setWarning(null);

    // AudioContext の生成はこの呼び出しの同期部分で行われる（クリックの有効期間を使う）。
    await manager.unlock();
    setIsUnlocked(manager.isUnlocked);

    if (manager.isUnlocked) {
      writeEnabledFlag(roomId);
      setPreviouslyEnabled(true);
    }

    // 先読みは待たない。待つと全画面要求までにクリックの有効期間を使い切ってしまう。
    void manager.preload();
  }, [roomId]);

  const play = useCallback((name: SoundName, dedupeKey?: string): void => {
    managerRef.current?.play(name, dedupeKey);
  }, []);

  const playTest = useCallback((): void => {
    // 動作確認は何度でも鳴らせるようにキーを渡さない。
    managerRef.current?.play(TEST_SOUND);
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
    previouslyEnabled,
    enable,
    playTest,
    play,
    setMuted,
    setVolume,
  };
}

/** フェーズごとに鳴らす音。ここに無いフェーズでは鳴らさない。 */
const PHASE_SOUND: Partial<Record<RoomPhase, SoundName>> = {
  question_open: 'question-start',
  question_locked: 'answer-lock',
  answer_revealed: 'answer-reveal',
  scoreboard: 'ranking',
  finished: 'finish',
};

/**
 * ルームの状態変化と残り時間から効果音を鳴らす。
 *
 * - 画面を開いた直後に見えた状態では鳴らさない（進行中のルームへ後から繋いだとき、
 *   いきなり正解音や終了音が鳴らないようにする）。
 * - 残り 5..1 秒の tick は `shouldPlayTick()` で判定する。
 *   タブ復帰で秒が飛んだ場合も、飛ばした分をまとめて鳴らさない。
 * - すべての再生要求に `${stateVersion}:...` のキーを添えるため、
 *   Snapshot を取り直しても、画面を再読込しても同じ音は二度鳴らない。
 */
export function useStageSoundCues({
  play,
  phase,
  stateVersion,
  remainingSeconds,
  hasDeadline,
}: {
  play: (name: SoundName, dedupeKey?: string) => void;
  phase: RoomPhase | null;
  stateVersion: number | null;
  remainingSeconds: number;
  hasDeadline: boolean;
}): void {
  /** 直前に処理した「状態番号:フェーズ」。null なら未観測。 */
  const lastPhaseKeyRef = useRef<string | null>(null);
  /** 直前の残り秒。タブ復帰で巻き戻ったときの判定に使う。 */
  const lastSecondsRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase === null || stateVersion === null) {
      return;
    }
    const key = `${stateVersion}:${phase}`;
    if (lastPhaseKeyRef.current === key) {
      return;
    }
    const isFirstObservation = lastPhaseKeyRef.current === null;
    lastPhaseKeyRef.current = key;
    if (isFirstObservation) {
      // 接続直後の状態は「変化」ではないため鳴らさない。
      return;
    }
    const sound = PHASE_SOUND[phase];
    if (sound) {
      play(sound, `${stateVersion}:${sound}`);
    }
  }, [phase, play, stateVersion]);

  useEffect(() => {
    if (phase !== 'question_open' || !hasDeadline || stateVersion === null) {
      lastSecondsRef.current = null;
      return;
    }
    const previous = lastSecondsRef.current;
    lastSecondsRef.current = remainingSeconds;
    if (shouldPlayTick(previous, remainingSeconds)) {
      play('tick', `${stateVersion}:tick:${remainingSeconds}`);
    }
  }, [hasDeadline, phase, play, remainingSeconds, stateVersion]);
}
