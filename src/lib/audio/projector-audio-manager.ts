/**
 * 会場投影画面の効果音再生。
 *
 * このモジュールは投影画面 (src/app/present, src/components/presentation) だけが使う。
 * 参加者画面・共通レイアウトからは import しない（ESLint の no-restricted-imports で禁止済み）。
 *
 * 守っていること:
 * - AudioContext は **操作者のクリックイベント内でしか作らない / resume しない**。
 *   モジュールの読み込みや画面表示だけでは音が鳴る余地を作らない。
 * - 音源は **一覧 (manifest) を読んでから**取得する。既定は /sounds/manifest.json だが、
 *   投影画面はルームごとの一覧 (/api/rooms/{roomId}/sounds) を渡す。
 *   管理画面から差し替えた音は、そこで配信経路の URL に入れ替わっている。
 *   ファイルが無い（404）場合は警告を出すだけで、投影は止めない。
 * - 同じ出来事で二度鳴らさない。`${stateVersion}:${soundName}` のようなキーを
 *   sessionStorage へ記録し、再読込・再接続でも鳴り直さない。
 * - タブが裏へ回ると AudioContext は suspended になることがあるため、復帰時に resume する。
 */

import { createSoundDedupeStore, type SoundDedupeStore } from '@/lib/audio/sound-dedupe-store';
import { SOUND_NAMES, type SoundName } from '@/domain/sound/sound-catalog';

/*
  音の名前と用途は domain/sound/sound-catalog.ts が持つ。
  管理画面（差し替えの設定）からも同じ一覧を参照するため、
  再生の仕組みと切り離してある。ここでは再輸出だけする。
*/
export { SOUND_NAMES, isSoundName, type SoundName } from '@/domain/sound/sound-catalog';

/** 音源を用意できなかった理由。会場でそのまま読める言葉にする。 */
export type SoundFailureReason =
  /** manifest.json にその音の指定が無い。 */
  | 'not-listed'
  /** 指定されたファイルがサーバーに無い（404 など）。 */
  | 'not-found'
  /** 取得できたが、再生できる形式へ変換できなかった。 */
  | 'decode-failed';

export type SoundFailure = { name: SoundName; reason: SoundFailureReason };

/** 先読みの結果。投影準備の画面へそのまま出せる形にする。 */
export type AudioReadiness = {
  /** manifest.json 自体を読めたか。 */
  manifestOk: boolean;
  /** すぐ鳴らせる音。 */
  ready: SoundName[];
  /** 用意できなかった音と、その理由。 */
  failed: SoundFailure[];
};

/** `unlock()` の呼び出し方。 */
export type UnlockOptions = {
  /**
   * 自動で試しているだけか。
   *
   * true のとき、解除できなくても警告を出さない。
   * 読み込み直後の自動解除は**失敗して当たり前**で、
   * そこで警告を出すと会場に「音が出ない」と誤解される。
   */
  silent?: boolean;
};

export interface ProjectorAudioManager {
  /**
   * AudioContext を作り、再生を許可させる。
   *
   * ブラウザは操作なしの再生を止めるため、確実に解除したいときは
   * 操作者のクリックイベント内から呼ぶこと。
   * 読み込み直後に `{ silent: true }` で試すのは自由（許可済みの端末では通る）。
   */
  unlock(options?: UnlockOptions): Promise<void>;
  /**
   * manifest.json を読み、音源を取得・デコードする。失敗しても例外は投げない。
   * どれが鳴らせてどれが鳴らせないかを返すので、呼び出し側は必ず画面へ出すこと
   * （黙って失敗すると、会場で「音が出ない」だけが分かって原因が分からない）。
   */
  preload(): Promise<AudioReadiness>;
  /** 効果音を鳴らす。dedupeKey を渡すと同じキーでは二度鳴らさない。 */
  play(name: SoundName, dedupeKey?: string): void;
  /**
   * 鳴らし続ける（繰り返し再生）。回答時間中のタイマー音に使う。
   * すでに同じ音を鳴らし続けていれば何もしない（呼び直しても鳴り直さない）。
   */
  startLoop(name: SoundName): void;
  /** 鳴らし続けているのを止める。 */
  stopLoop(name: SoundName): void;
  /**
   * 動作確認用に 1 音鳴らし、鳴らせたかどうかを返す。
   * 進行中の合図と違って**時間に追われないため、読み込みを最後まで待つ**。
   */
  playTest(name: SoundName): Promise<{ ok: boolean; reason: string | null }>;
  /**
   * 読み込み済みの音の長さ（秒）。未読み込みなら null。
   * ドラムロールが鳴り終わったところで発表したいので、素材の実際の長さに合わせる。
   */
  durationOf(name: SoundName): number | null;
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

/**
 * 再生を始めるまでの余裕（秒）。
 *
 * `currentTime` ちょうどで start() すると、音声スレッドが今まさに書き出している
 * 区間へ割り込む形になり、**先頭が数十ミリ秒欠ける**ことがある。
 * 「デデン」のような立ち上がりの速い音ほど目立つ。
 * 会場では気づかれない程度の遅れを足して、頭から鳴らす。
 */
const START_LEAD_SECONDS = 0.06;

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

/** 失敗の理由を、会場の操作者がそのまま読める言葉にする。 */
export function describeFailure(name: SoundName, reason: SoundFailureReason | undefined): string {
  switch (reason) {
    case 'not-listed':
      return `「${name}」が manifest.json にありません`;
    case 'not-found':
      return `「${name}」の音源ファイルがサーバーにありません`;
    case 'decode-failed':
      return `「${name}」の音源をこのブラウザで再生できません`;
    default:
      return `「${name}」を用意できませんでした`;
  }
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
  /** いま鳴っている音（種類ごとに 1 つ）。次が来たら止めて重ねない。 */
  const playing = new Map<SoundName, AudioBufferSourceNode>();
  /** 鳴らし続けている音。回答時間中のタイマーなど。 */
  const looping = new Set<SoundName>();

  let manifest: Map<SoundName, string> | null = null;
  let manifestPromise: Promise<Map<SoundName, string>> | null = null;
  let manifestOk = false;

  /** 用意できなかった音とその理由。投影準備の画面へ出す。 */
  const failures = new Map<SoundName, SoundFailureReason>();

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
        manifestOk = true;
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
      failures.set(name, 'not-listed');
      warn(`missing:${name}`, `効果音「${name}」が一覧にありません。この音は鳴りません。`);
      return null;
    }
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        failures.set(name, 'not-found');
        warn(
          `fetch:${name}`,
          `効果音「${name}」のファイル (${url}) が見つかりません (${response.status})。この音は鳴りません。`,
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
      failures.set(name, 'not-found');
      warn(`fetch:${name}`, `効果音「${name}」を取得できませんでした。この音は鳴りません。`);
      return null;
    }
  };

  /**
   * 取得とデコードをまとめて行う。AudioContext が無い間はデコードできないため null を返す。
   *
   * **失敗を覚え込まないこと。** `loading` に「null を返す約束」を残したままにすると、
   * あとで音が解除されても、通信が戻っても、その音は二度と読み込まれない。
   * そのため、どの経路を通っても最後に必ず `loading` から取り除く。
   */
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
      try {
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
          failures.delete(name);
          return buffer;
        } catch {
          failures.set(name, 'decode-failed');
          warn(`decode:${name}`, `効果音「${name}」を再生できる形式に変換できませんでした。`);
          return null;
        }
      } finally {
        loading.delete(name);
      }
    })();

    loading.set(name, task);
    return task;
  };

  /** 同じ種類の音が鳴っていれば止める。残り 5,4,3,2,1,0 秒の合図が重ならないようにする。 */
  const stopPlaying = (name: SoundName): void => {
    const previous = playing.get(name);
    if (!previous) {
      return;
    }
    playing.delete(name);
    try {
      previous.stop();
    } catch {
      // すでに終わっている場合は何もしない。
    }
  };

  const startSource = (name: SoundName, buffer: AudioBuffer, loop = false): void => {
    if (!context || !gain || disposed) {
      return;
    }
    // 長い音源を使うと、次の合図が来ても前の音が鳴り続けて重なる。
    // 素材の長さに関係なく重ならないよう、同じ種類は必ず 1 つだけにする。
    stopPlaying(name);
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      // 素材が短くても、回答時間の長さに合わせて鳴り続ける。
      source.loop = loop;
      source.connect(gain);
      source.onended = () => {
        activeSources.delete(source);
        if (playing.get(name) === source) {
          playing.delete(name);
        }
      };
      activeSources.add(source);
      playing.set(name, source);
      // 先頭が欠けないよう、わずかに先の時刻を指定する。
      source.start(context.currentTime + START_LEAD_SECONDS);
    } catch {
      warn('start', '効果音を再生できませんでした。');
    }
  };

  const resumeIfNeeded = async (silent = false): Promise<void> => {
    if (!context || disposed) {
      return;
    }
    if (context.state !== 'suspended') {
      return;
    }
    try {
      await context.resume();
    } catch {
      // 操作なしでは resume できないことがある。次の操作で解除される。
      if (!silent) {
        warn('resume', '効果音の再開にはもう一度画面を操作してください。');
      }
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

    async unlock(options: UnlockOptions = {}): Promise<void> {
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

      await resumeIfNeeded(options.silent ?? false);

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

      if (!unlocked && !options.silent) {
        warn('locked', '効果音がブラウザに止められています。もう一度画面を操作してください。');
      }
    },

    async preload(): Promise<AudioReadiness> {
      if (disposed) {
        return { manifestOk: false, ready: [], failed: [] };
      }
      await loadManifest();
      // 1 つ失敗しても他は読み込む。
      const buffers = await Promise.all(SOUND_NAMES.map((name) => ensureDecoded(name)));

      const ready: SoundName[] = [];
      const failed: SoundFailure[] = [];
      SOUND_NAMES.forEach((name, index) => {
        if (buffers[index]) {
          ready.push(name);
          return;
        }
        const reason = failures.get(name);
        // AudioContext がまだ無いだけの場合は失敗として数えない
        // （投影開始の操作より前は、そもそもデコードできない）。
        if (reason) {
          failed.push({ name, reason });
        }
      });

      return { manifestOk, ready, failed };
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
        startSource(name, ready);
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
        startSource(name, buffer);
      });
    },

    startLoop(name: SoundName): void {
      if (disposed || muted || looping.has(name)) {
        return;
      }
      if (!unlocked || !context || !gain) {
        warn('not-unlocked', '効果音はまだ有効になっていません（投影開始の操作が必要です）。');
        return;
      }
      looping.add(name);
      void resumeIfNeeded();

      const ready = decoded.get(name);
      if (ready) {
        startSource(name, ready, true);
        return;
      }
      // 読み込みが間に合わなくても、回答時間はまだ続いている。
      // 進行中の合図と違って打ち切らず、読めた時点から鳴らし始める。
      void ensureDecoded(name).then((buffer) => {
        if (!buffer || disposed || muted || !looping.has(name)) {
          return;
        }
        startSource(name, buffer, true);
      });
    },

    stopLoop(name: SoundName): void {
      if (!looping.has(name)) {
        return;
      }
      looping.delete(name);
      stopPlaying(name);
    },

    async playTest(name: SoundName): Promise<{ ok: boolean; reason: string | null }> {
      if (disposed) {
        return { ok: false, reason: '画面を離れました' };
      }
      if (!unlocked || !context || !gain) {
        return { ok: false, reason: 'ブラウザが音を止めています。もう一度押してください' };
      }
      if (muted) {
        return { ok: false, reason: '消音になっています' };
      }

      await resumeIfNeeded();

      // 進行中の合図と違い、確認の音は遅れても構わない。
      // ここで打ち切ると「押しても何も起きない」になり、原因が分からなくなる。
      const buffer = await ensureDecoded(name);
      if (!buffer) {
        const reason = failures.get(name);
        return { ok: false, reason: describeFailure(name, reason) };
      }
      startSource(name, buffer);
      return { ok: true, reason: null };
    },

    durationOf(name: SoundName): number | null {
      return decoded.get(name)?.duration ?? null;
    },

    setMuted(nextMuted: boolean): void {
      muted = nextMuted;
      if (nextMuted) {
        // 鳴らし続けている音は、音量を絞るだけでなく止める
        // （消音を解除したときに途中から鳴り出すのを避ける）。
        for (const name of [...looping]) {
          looping.delete(name);
          stopPlaying(name);
        }
      }
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
      playing.clear();
      looping.clear();
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
