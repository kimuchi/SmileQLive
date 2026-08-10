/**
 * 会場投影画面の効果音再生。
 *
 * このモジュールは投影画面 (src/app/present, src/components/presentation) だけが使う。
 * 参加者画面・共通レイアウトからは import しない（ESLint の no-restricted-imports で禁止済み）。
 *
 * 守っていること:
 * - AudioContext は **操作者のクリックイベント内でしか作らない / resume しない**。
 *   モジュールの読み込みや画面表示だけでは音が鳴る余地を作らない。
 * - 音源は public/sounds/manifest.json（ファイル名の一覧）を読んでから取得する。
 *   ファイルが無い（404）場合は警告を出すだけで、投影は止めない。
 * - 同じ出来事で二度鳴らさない。`${stateVersion}:${soundName}` のようなキーを
 *   sessionStorage へ記録し、再読込・再接続でも鳴り直さない。
 * - タブが裏へ回ると AudioContext は suspended になることがあるため、復帰時に resume する。
 */

import { createSoundDedupeStore, type SoundDedupeStore } from '@/lib/audio/sound-dedupe-store';

export type SoundName =
  | 'question-start'
  | 'tick'
  | 'answer-lock'
  | 'answer-reveal'
  | 'ranking'
  | 'finish';

export const SOUND_NAMES = [
  'question-start',
  'tick',
  'answer-lock',
  'answer-reveal',
  'ranking',
  'finish',
] as const satisfies readonly SoundName[];

export function isSoundName(value: string): value is SoundName {
  return (SOUND_NAMES as readonly string[]).includes(value);
}

export interface ProjectorAudioManager {
  /** 操作者のクリックイベント内から呼ぶこと。AudioContext を作り、再生を許可させる。 */
  unlock(): Promise<void>;
  /** manifest.json を読み、音源を取得・デコードする。失敗しても例外は投げない。 */
  preload(): Promise<void>;
  /** 効果音を鳴らす。dedupeKey を渡すと同じキーでは二度鳴らさない。 */
  play(name: SoundName, dedupeKey?: string): void;
  setMuted(muted: boolean): void;
  /** 0.0〜1.0。範囲外は丸める。 */
  setVolume(volume: number): void;
  dispose(): void;
  readonly isUnlocked: boolean;
}

export type ProjectorAudioManagerOptions = {
  /** 既定 '/sounds/manifest.json'。音源 URL はこの位置からの相対で解決する。 */
  manifestUrl?: string;
  /** 初期音量 (0.0〜1.0)。既定 0.8。 */
  volume?: number;
  /** 初期ミュート状態。既定 false。 */
  muted?: boolean;
  /** 二重再生防止の記録を分ける単位（ルーム ID を推奨）。 */
  dedupeNamespace?: string;
  /** 警告の通知先。未指定なら console.warn。 */
  onWarning?: (message: string) => void;
};

const DEFAULT_MANIFEST_URL = '/sounds/manifest.json';
const DEFAULT_VOLUME = 0.8;

/**
 * 再生要求からデコード完了までに許す遅れ。
 * これを超えたら「もう場面が変わっている」とみなして鳴らさない
 * （締切音が正解発表のあとに鳴る、といった事故を防ぐ）。
 */
const LATE_PLAY_WINDOW_MS = 1_500;

/** 音量の立ち上がり・立ち下がりを少しだけなだらかにして、クリックノイズを避ける。 */
const GAIN_RAMP_SECONDS = 0.02;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  // `window` は `Window & typeof globalThis` として型付けされており、
  // AudioContext はグローバル宣言側にある。`Window` だけへ絞ると参照できなくなるため
  // typeof window を基点に拡張する（Safari の webkit 接頭辞にも対応）。
  const candidate = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * manifest の値からファイル URL を組み立てる。
 * パス脱出や外部ホストの読み込みを防ぐため、同一オリジンだけ許可する。
 */
function resolveSoundUrl(fileName: string, manifestUrl: string): string | null {
  if (typeof fileName !== 'string' || fileName.trim().length === 0) {
    return null;
  }
  try {
    const base = new URL(manifestUrl, window.location.href);
    const resolved = new URL(fileName, base);
    if (resolved.origin !== window.location.origin) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function parseManifest(payload: unknown, manifestUrl: string): Map<SoundName, string> {
  const result = new Map<SoundName, string>();
  if (typeof payload !== 'object' || payload === null) {
    return result;
  }
  const record = payload as Record<string, unknown>;
  for (const name of SOUND_NAMES) {
    const value = record[name];
    if (typeof value !== 'string') {
      continue;
    }
    const url = resolveSoundUrl(value, manifestUrl);
    if (url) {
      result.set(name, url);
    }
  }
  return result;
}

export function createProjectorAudioManager(
  options: ProjectorAudioManagerOptions = {},
): ProjectorAudioManager {
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const dedupe: SoundDedupeStore = createSoundDedupeStore(options.dedupeNamespace ?? 'default');

  let volume = clampVolume(options.volume ?? DEFAULT_VOLUME);
  let muted = options.muted ?? false;
  let disposed = false;
  let unlocked = false;

  let context: AudioContext | null = null;
  let gain: GainNode | null = null;

  /** 取得済みの音源バイト列（デコード前）。decodeAudioData は入力を消費するため複製して渡す。 */
  const encoded = new Map<SoundName, Uint8Array>();
  const decoded = new Map<SoundName, AudioBuffer>();
  const loading = new Map<SoundName, Promise<AudioBuffer | null>>();
  const activeSources = new Set<AudioBufferSourceNode>();

  let manifest: Map<SoundName, string> | null = null;
  let manifestPromise: Promise<Map<SoundName, string>> | null = null;

  /** 同じ警告を会場で何度も出さない。 */
  const warned = new Set<string>();

  const warn = (key: string, message: string): void => {
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    if (options.onWarning) {
      options.onWarning(message);
      return;
    }
    console.warn(`[projector-audio] ${message}`);
  };

  const applyGain = (): void => {
    if (!gain || !context) {
      return;
    }
    const target = muted ? 0 : volume;
    try {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setTargetAtTime(target, context.currentTime, GAIN_RAMP_SECONDS);
    } catch {
      gain.gain.value = target;
    }
  };

  const loadManifest = async (): Promise<Map<SoundName, string>> => {
    if (manifest) {
      return manifest;
    }
    if (manifestPromise) {
      return manifestPromise;
    }
    manifestPromise = (async () => {
      try {
        const response = await fetch(manifestUrl, { credentials: 'same-origin' });
        if (!response.ok) {
          warn(
            'manifest',
            `効果音の一覧 (${manifestUrl}) を読み込めませんでした。効果音なしで進行します。`,
          );
          return new Map<SoundName, string>();
        }
        const payload: unknown = await response.json();
        const parsed = parseManifest(payload, manifestUrl);
        if (parsed.size === 0) {
          warn('manifest-empty', '効果音の一覧が空でした。効果音なしで進行します。');
        }
        return parsed;
      } catch {
        warn(
          'manifest',
          `効果音の一覧 (${manifestUrl}) を読み込めませんでした。効果音なしで進行します。`,
        );
        return new Map<SoundName, string>();
      }
    })();

    manifest = await manifestPromise;
    return manifest;
  };

  const fetchBytes = async (name: SoundName): Promise<Uint8Array | null> => {
    const existing = encoded.get(name);
    if (existing) {
      return existing;
    }
    const table = await loadManifest();
    const url = table.get(name);
    if (!url) {
      warn(`missing:${name}`, `効果音「${name}」が一覧にありません。この音は鳴りません。`);
      return null;
    }
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        warn(
          `fetch:${name}`,
          `効果音「${name}」のファイルが見つかりません (${response.status})。この音は鳴りません。`,
        );
        return null;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (disposed) {
        return null;
      }
      encoded.set(name, bytes);
      return bytes;
    } catch {
      warn(`fetch:${name}`, `効果音「${name}」を取得できませんでした。この音は鳴りません。`);
      return null;
    }
  };

  /** 取得とデコードをまとめて行う。AudioContext が無い間はデコードできないため null を返す。 */
  const ensureDecoded = (name: SoundName): Promise<AudioBuffer | null> => {
    const ready = decoded.get(name);
    if (ready) {
      return Promise.resolve(ready);
    }
    const running = loading.get(name);
    if (running) {
      return running;
    }

    const task = (async (): Promise<AudioBuffer | null> => {
      const bytes = await fetchBytes(name);
      if (!bytes || disposed) {
        return null;
      }
      const target = context;
      if (!target) {
        // まだ操作者のクリックが無い。デコードは unlock 後にやり直す。
        return null;
      }
      try {
        // decodeAudioData は渡した ArrayBuffer を切り離すため、必ず複製を渡す。
        const copy = bytes.slice().buffer;
        const buffer = await target.decodeAudioData(copy);
        if (disposed) {
          return null;
        }
        decoded.set(name, buffer);
        return buffer;
      } catch {
        warn(`decode:${name}`, `効果音「${name}」を再生できる形式に変換できませんでした。`);
        return null;
      } finally {
        loading.delete(name);
      }
    })();

    loading.set(name, task);
    return task;
  };

  const startSource = (buffer: AudioBuffer): void => {
    if (!context || !gain || disposed) {
      return;
    }
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        activeSources.delete(source);
      };
      activeSources.add(source);
      source.start();
    } catch {
      warn('start', '効果音を再生できませんでした。');
    }
  };

  const resumeIfNeeded = async (): Promise<void> => {
    if (!context || disposed) {
      return;
    }
    if (context.state !== 'suspended') {
      return;
    }
    try {
      await context.resume();
    } catch {
      // 操作なしでは resume できないことがある。次のクリックで解除される。
      warn('resume', '効果音の再開にはもう一度画面を操作してください。');
    }
  };

  const handleVisibilityChange = (): void => {
    if (disposed || !unlocked) {
      return;
    }
    if (document.visibilityState === 'visible') {
      void resumeIfNeeded();
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return {
    get isUnlocked(): boolean {
      return unlocked && context !== null && context.state === 'running';
    },

    async unlock(): Promise<void> {
      if (disposed) {
        return;
      }
      const Ctor = resolveAudioContextConstructor();
      if (!Ctor) {
        warn('unsupported', 'このブラウザは効果音の再生に対応していません。');
        return;
      }

      if (!context) {
        try {
          context = new Ctor();
        } catch {
          warn('create', '効果音を初期化できませんでした。');
          context = null;
          return;
        }
        gain = context.createGain();
        gain.gain.value = muted ? 0 : volume;
        gain.connect(context.destination);
      }

      await resumeIfNeeded();

      // iOS Safari は「無音でも一度再生する」ことで初めて解除される。
      try {
        const silent = context.createBuffer(1, 1, context.sampleRate);
        const source = context.createBufferSource();
        source.buffer = silent;
        source.connect(context.destination);
        source.start();
      } catch {
        // 解除の補助にすぎないため、失敗しても続行する。
      }

      unlocked = context.state === 'running';
      applyGain();

      if (!unlocked) {
        warn('locked', '効果音がブラウザに止められています。もう一度画面を操作してください。');
      }
    },

    async preload(): Promise<void> {
      if (disposed) {
        return;
      }
      await loadManifest();
      // 1 つ失敗しても他は読み込む。
      await Promise.all(SOUND_NAMES.map((name) => ensureDecoded(name)));
    },

    play(name: SoundName, dedupeKey?: string): void {
      if (disposed) {
        return;
      }
      // 二重再生防止の印は、鳴らせるかどうかに関わらず先に立てる。
      // （ミュート中や未解除の間に何度も呼ばれても、あとから鳴り直さない）
      if (dedupeKey !== undefined && !dedupe.claim(dedupeKey)) {
        return;
      }
      if (!unlocked || !context || !gain) {
        warn('not-unlocked', '効果音はまだ有効になっていません（投影開始の操作が必要です）。');
        return;
      }
      if (muted) {
        return;
      }

      void resumeIfNeeded();

      const ready = decoded.get(name);
      if (ready) {
        startSource(ready);
        return;
      }

      const requestedAt = Date.now();
      void ensureDecoded(name).then((buffer) => {
        if (!buffer || disposed || muted) {
          return;
        }
        // 取得に手間取った音は、もう場面が変わっているため鳴らさない。
        if (Date.now() - requestedAt > LATE_PLAY_WINDOW_MS) {
          return;
        }
        startSource(buffer);
      });
    },

    setMuted(nextMuted: boolean): void {
      muted = nextMuted;
      applyGain();
    },

    setVolume(nextVolume: number): void {
      volume = clampVolume(nextVolume);
      applyGain();
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      unlocked = false;

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }

      for (const source of activeSources) {
        try {
          source.stop();
        } catch {
          // 既に停止している場合は無視する。
        }
      }
      activeSources.clear();
      decoded.clear();
      encoded.clear();
      loading.clear();

      const target = context;
      context = null;
      gain = null;
      if (target) {
        void target.close().catch(() => {
          // 閉じられなくても画面遷移で解放される。
        });
      }
    },
  };
}
