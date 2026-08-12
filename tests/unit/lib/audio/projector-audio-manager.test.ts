// @vitest-environment jsdom
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
};

/** 鳴った回数を数えるための最小限の AudioContext。 */
function installFakeAudioContext(): {
  started: () => number;
  startTimes: () => number[];
  stopped: () => number;
  currentTime: () => number;
} {
  let started = 0;
  let stopped = 0;
  const startTimes: number[] = [];
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
    onended: (() => void) | null = null;
    connect = vi.fn();
    start = vi.fn((when?: number) => {
      // 解除用の無音（1 サンプル）は数えない。
      const length = (this.buffer as { length?: number } | null)?.length ?? 0;
      if (length <= 1) {
        return;
      }
      started += 1;
      startTimes.push(when ?? 0);
    });
    stop = vi.fn(() => {
      stopped += 1;
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
  };
}

function audioResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
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
    // 残り 5,4,3,2,1,0 秒の合図。素材が長くても重ならないこと。
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
