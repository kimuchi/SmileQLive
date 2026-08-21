// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectorAudioManager,
  SOUND_NAMES,
} from '@/lib/audio/projector-audio-manager';

/**
 * 投影画面の効果音。
 *
 * ここで守りたいこと:
 * - **一度の失敗を覚え込まない。** 通信が戻ったり、あとから音源を置いたりしたら鳴ること。
 *   （読み込み中の約束を残したままにすると、その音は二度と読み込まれなくなる）
 * - 何が鳴らせて何が鳴らせないかを呼び出し側へ返すこと。黙って無音にしない。
 * - 動作確認の音は、読み込みが遅くても打ち切らずに鳴らすこと。
 *
 * なお、このテストは**何も出力してはいけない**。
 * `npm run deploy` は途中で検証を回すため、ここでの警告は
 * 運用者の画面に「本物の警告」として混ざってしまう。
 * 警告は onWarning で受け取り、内容を検査する。
 */

/** 警告を console へ流さず、内容を確かめられるように受け取る。 */
function collectWarnings() {
  const messages: string[] = [];
  return { messages, onWarning: (message: string) => messages.push(message) };
}

const MANIFEST = {
  'question-start': 'question-start.wav',
  tick: 'tick.wav',
  'answer-lock': 'answer-lock.wav',
  'answer-reveal': 'answer-reveal.wav',
  ranking: 'ranking.wav',
  fanfare: 'fanfare.wav',
  finish: 'finish.wav',
  'draw-spin': 'draw-spin.wav',
  'draw-win': 'draw-win.wav',
};

/** 鳴った回数を数えるための最小限の AudioContext。 */
function installFakeAudioContext(): {
  started: () => number;
  startTimes: () => number[];
  stopped: () => number;
  currentTime: () => number;
  /** 繰り返し再生で鳴らし始めたもの（回答時間中のタイマー音）。 */
  loopingSources: () => { stopped: boolean }[];
} {
  let started = 0;
  let stopped = 0;
  const startTimes: number[] = [];
  const loopingSources: { stopped: boolean }[] = [];
  const CURRENT_TIME = 12.5;

  class FakeGainNode {
    gain = {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setTargetAtTime: vi.fn(),
    };
    connect = vi.fn();
  }

  class FakeSourceNode {
    buffer: unknown = null;
    loop = false;
    onended: (() => void) | null = null;
    /** 繰り返し再生として記録した控え。stop されたら印を付ける。 */
    private record: { stopped: boolean } | null = null;
    connect = vi.fn();
    start = vi.fn((when?: number) => {
      // 解除用の無音（1 サンプル）は数えない。
      const length = (this.buffer as { length?: number } | null)?.length ?? 0;
      if (length <= 1) {
        return;
      }
      started += 1;
      startTimes.push(when ?? 0);
      if (this.loop) {
        this.record = { stopped: false };
        loopingSources.push(this.record);
      }
    });
    stop = vi.fn(() => {
      stopped += 1;
      if (this.record) {
        this.record.stopped = true;
      }
    });
  }

  class FakeAudioContext {
    state = 'running';
    currentTime = CURRENT_TIME;
    sampleRate = 44_100;
    destination = {};
    createGain = () => new FakeGainNode();
    createBufferSource = () => new FakeSourceNode();
    createBuffer = () => ({ length: 1 });
    decodeAudioData = (buffer: ArrayBuffer) =>
      Promise.resolve({
        length: buffer.byteLength,
        duration: buffer.byteLength / 44_100,
      } as unknown as AudioBuffer);
    resume = () => Promise.resolve();
    close = () => Promise.resolve();
  }

  // 実装は window.AudioContext を見る。
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  return {
    started: () => started,
    startTimes: () => [...startTimes],
    stopped: () => stopped,
    currentTime: () => CURRENT_TIME,
    loopingSources: () => [...loopingSources],
  };
}

function audioResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
  } as unknown as Response;
}

/** 長さを決めた音源を返す。上の偽の復号器は 44,100 バイトを 1 秒として扱う。 */
function audioResponseOfSeconds(seconds: number): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(Math.round(seconds * 44_100))),
  } as unknown as Response;
}

function manifestResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(MANIFEST),
  } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, status: 404 } as unknown as Response;
}

describe('投影画面の効果音', () => {
  let audio: ReturnType<typeof installFakeAudioContext>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    audio = installFakeAudioContext();
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // 警告は onWarning へ渡っているはず。console へ漏らさない。
    expect(consoleWarn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('すべて用意できたら ready で返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : audioResponse()),
    );

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-1',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    const readiness = await manager.preload();

    expect(readiness.manifestOk).toBe(true);
    expect(readiness.ready).toHaveLength(SOUND_NAMES.length);
    expect(readiness.failed).toHaveLength(0);
    // すべて揃っているときは何も言わない。
    expect(warnings.messages).toEqual([]);
    manager.dispose();
  });

  it('見つからない音は理由つきで返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return Promise.resolve(manifestResponse());
      if (url.endsWith('finish.wav')) return Promise.resolve(notFound());
      return Promise.resolve(audioResponse());
    });

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-2',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    const readiness = await manager.preload();

    expect(readiness.ready).toHaveLength(SOUND_NAMES.length - 1);
    expect(readiness.failed).toEqual([{ name: 'finish', reason: 'not-found' }]);
    // 会場の操作者へ届く文言。どのファイルが無いのかまで伝わること。
    expect(warnings.messages).toHaveLength(1);
    expect(warnings.messages[0]).toContain('finish');
    expect(warnings.messages[0]).toContain('見つかりません');
    manager.dispose();
  });

  it('一度失敗しても、次に成功すれば鳴る（失敗を覚え込まない）', async () => {
    let failNext = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return Promise.resolve(manifestResponse());
      if (url.endsWith('finish.wav') && failNext) {
        failNext = false;
        return Promise.resolve(notFound());
      }
      return Promise.resolve(audioResponse());
    });

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-3',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();

    const first = await manager.preload();
    expect(first.failed).toEqual([{ name: 'finish', reason: 'not-found' }]);

    // 通信が戻った / 音源を置き直した、という状況。
    const second = await manager.preload();
    expect(second.failed).toHaveLength(0);
    expect(second.ready).toContain('finish');

    const before = audio.started();
    const result = await manager.playTest('finish');
    expect(result.ok).toBe(true);
    expect(audio.started()).toBe(before + 1);
    manager.dispose();
  });

  it('投影開始より前に先読みしても、開始後に鳴らせる', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : audioResponse()),
    );

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-4',
      onWarning: warnings.onWarning,
    });

    // まだクリックしていない = AudioContext が無い。ここでの先読みは失敗扱いにしない。
    const before = await manager.preload();
    expect(before.ready).toHaveLength(0);
    expect(before.failed).toHaveLength(0);

    await manager.unlock();
    const after = await manager.preload();
    expect(after.ready).toHaveLength(SOUND_NAMES.length);
    manager.dispose();
  });

  it('音声テストは読み込みを待って結果を返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return Promise.resolve(manifestResponse());
      // 進行中の合図なら打ち切られる遅さ（1.5 秒超）でも、テストは待つ。
      return new Promise((resolve) => setTimeout(() => resolve(audioResponse()), 1_800));
    });

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-5',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();

    const before = audio.started();
    const result = await manager.playTest('question-start');
    expect(result.ok).toBe(true);
    expect(audio.started()).toBe(before + 1);
    manager.dispose();
  }, 15_000);

  it('音声テストが鳴らせないときは理由を返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : notFound()),
    );

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-6',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();

    const result = await manager.playTest('question-start');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('サーバーにありません');
    manager.dispose();
  });

  it('同じ出来事では二度鳴らさない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : audioResponse()),
    );

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'room-7',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    const before = audio.started();
    manager.play('answer-reveal', '5:answer-reveal');
    manager.play('answer-reveal', '5:answer-reveal');
    expect(audio.started()).toBe(before + 1);
    manager.dispose();
  });
});

describe('鳴らし方', () => {
  let audio: ReturnType<typeof installFakeAudioContext>;

  beforeEach(() => {
    audio = installFakeAudioContext();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : audioResponse()),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('頭が欠けないよう、少し先の時刻から鳴らす', async () => {
    // currentTime ちょうどで start すると先頭が数十ミリ秒切れることがある。
    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'lead',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    manager.play('question-start');

    const [when] = audio.startTimes();
    expect(when).toBeGreaterThan(audio.currentTime());
    // 会場で気づかれない程度（0.2 秒以内）に収めること。
    expect(when).toBeLessThanOrEqual(audio.currentTime() + 0.2);
    manager.dispose();
  });

  it('同じ音が続けて鳴るとき、前の音を止めて重ねない', async () => {
    // 素材が長くても、同じ種類の音が積み重なって濁らないこと。
    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'tick',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    for (const second of [5, 4, 3, 2, 1, 0]) {
      manager.play('tick', `1:tick:${second}`);
    }

    expect(audio.started()).toBe(6);
    // 2 回目以降は、前の音を止めてから鳴らす。
    expect(audio.stopped()).toBe(5);
    manager.dispose();
  });

  it('種類が違えば止めない（締切音と正解音は重なってよい）', async () => {
    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'mixed',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    manager.play('ranking');
    manager.play('fanfare');

    expect(audio.started()).toBe(2);
    expect(audio.stopped()).toBe(0);
    manager.dispose();
  });

  /**
   * 回答受付中のタイマー音。
   *
   * 一度きりの再生にすると、素材の長さのぶんしか鳴らず（既定の素材は 1 秒）、
   * 会場では「最初だけ鳴ってすぐ止まった」ように聞こえる。実際にそうなった。
   */
  describe('回答受付中のタイマー音', () => {
    it('繰り返し再生で鳴らし始める', async () => {
      const warnings = collectWarnings();
      const manager = createProjectorAudioManager({
        dedupeNamespace: 'loop-start',
        onWarning: warnings.onWarning,
      });
      await manager.unlock();
      await manager.preload();

      manager.startLoop('tick');

      expect(audio.loopingSources()).toHaveLength(1);
      manager.dispose();
    });

    it('二度呼んでも鳴らし直さない（延長で鳴り直すと不自然）', async () => {
      const warnings = collectWarnings();
      const manager = createProjectorAudioManager({
        dedupeNamespace: 'loop-twice',
        onWarning: warnings.onWarning,
      });
      await manager.unlock();
      await manager.preload();

      manager.startLoop('tick');
      manager.startLoop('tick');

      expect(audio.loopingSources()).toHaveLength(1);
      expect(audio.stopped()).toBe(0);
      manager.dispose();
    });

    it('止めると鳴りやみ、そのあと鳴らし直せる', async () => {
      const warnings = collectWarnings();
      const manager = createProjectorAudioManager({
        dedupeNamespace: 'loop-stop',
        onWarning: warnings.onWarning,
      });
      await manager.unlock();
      await manager.preload();

      manager.startLoop('tick');
      manager.stopLoop('tick');
      expect(audio.loopingSources()[0]?.stopped).toBe(true);

      // 締切から受付へ戻したときに、もう一度鳴らせること。
      manager.startLoop('tick');
      expect(audio.loopingSources()).toHaveLength(2);
      expect(audio.loopingSources()[1]?.stopped).toBe(false);
      manager.dispose();
    });

    it('消音にすると鳴りやむ', async () => {
      const warnings = collectWarnings();
      const manager = createProjectorAudioManager({
        dedupeNamespace: 'loop-mute',
        onWarning: warnings.onWarning,
      });
      await manager.unlock();
      await manager.preload();

      manager.startLoop('tick');
      manager.setMuted(true);

      expect(audio.loopingSources()[0]?.stopped).toBe(true);
      manager.dispose();
    });
  });

  it('音の長さを返す（ためる時間を素材に合わせるため）', async () => {
    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'duration',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    expect(manager.durationOf('ranking')).toBeGreaterThan(0);
    manager.dispose();
  });
});

/**
 * 抽選会・ビンゴで鳴らす 2 音。
 *
 * draw-spin はルーレットを回している間ずっと繰り返し鳴らす。
 * そのため**素材の長さがそのまま継ぎ目の間隔になる**ので、1 秒ちょうどに固定する
 * （ずれると会場で「回っている音が途切れた」ように聞こえる）。
 */
describe('抽選・ビンゴの効果音', () => {
  let audio: ReturnType<typeof installFakeAudioContext>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    audio = installFakeAudioContext();
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // 警告は onWarning へ渡っているはず。console へ漏らさない。
    expect(consoleWarn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('ルーレット音と当選音を読み込める', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : audioResponse()),
    );

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'draw-preload',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    const readiness = await manager.preload();

    expect(readiness.ready).toContain('draw-spin');
    expect(readiness.ready).toContain('draw-win');
    expect(readiness.failed).toHaveLength(0);
    expect(warnings.messages).toEqual([]);
    manager.dispose();
  });

  it('ルーレット音は繰り返し再生で鳴らす（回している間ずっと）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(String(input).endsWith('manifest.json') ? manifestResponse() : audioResponse()),
    );

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'draw-spin',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    manager.startLoop('draw-spin');
    expect(audio.loopingSources()).toHaveLength(1);

    // 引いたものが決まったら止めて、当選音へ渡す。
    manager.stopLoop('draw-spin');
    expect(audio.loopingSources()[0]?.stopped).toBe(true);

    const before = audio.started();
    manager.play('draw-win');
    expect(audio.started()).toBe(before + 1);
    manager.dispose();
  });

  it('ルーレット音の長さをそのまま返す（繰り返しの間隔になる）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return Promise.resolve(manifestResponse());
      if (url.endsWith('draw-spin.wav')) return Promise.resolve(audioResponseOfSeconds(1));
      return Promise.resolve(audioResponse());
    });

    const warnings = collectWarnings();
    const manager = createProjectorAudioManager({
      dedupeNamespace: 'draw-duration',
      onWarning: warnings.onWarning,
    });
    await manager.unlock();
    await manager.preload();

    expect(manager.durationOf('draw-spin')).toBe(1);
    manager.dispose();
  });
});

/**
 * 同梱音（public/sounds/default/）そのものの長さ。
 *
 * 上の durationOf は「素材の長さをそのまま返す」ことしか確かめられない。
 * 実際に繰り返して不自然にならないかは**生成物の長さ**で決まるため、
 * npm run sounds:generate の出力をここで固定する。
 */
describe('同梱音の長さ', () => {
  /** WAV の見出しから長さ（秒）を読む。generate-sounds.mjs が書く 44 バイトの標準形が前提。 */
  function bundledDurationSeconds(fileName: string): number {
    // jsdom 環境では import.meta.url が http: になるためファイルとして辿れない。
    // vitest はリポジトリ直下で動くので、そこからの相対で開く。
    const buffer = readFileSync(join(process.cwd(), 'public', 'sounds', 'default', fileName));
    const bytesPerSecond = buffer.readUInt32LE(28);
    const dataSize = buffer.readUInt32LE(40);
    return dataSize / bytesPerSecond;
  }

  it('draw-spin はちょうど 1 秒（繰り返しの継ぎ目で拍が崩れない）', () => {
    expect(bundledDurationSeconds('draw-spin.wav')).toBe(1);
  });

  it('draw-win は当選の余韻が残る長さ', () => {
    const seconds = bundledDurationSeconds('draw-win.wav');
    expect(seconds).toBeGreaterThanOrEqual(1.5);
    expect(seconds).toBeLessThanOrEqual(2);
  });
});
