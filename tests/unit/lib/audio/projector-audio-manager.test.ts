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
  finish: 'finish.wav',
};

/** 鳴った回数を数えるための最小限の AudioContext。 */
function installFakeAudioContext(): { started: () => number } {
  let started = 0;

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
    start = vi.fn(() => {
      started += 1;
    });
    stop = vi.fn();
  }

  class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    sampleRate = 44_100;
    destination = {};
    createGain = () => new FakeGainNode();
    createBufferSource = () => new FakeSourceNode();
    createBuffer = () => ({ length: 1 });
    decodeAudioData = (buffer: ArrayBuffer) =>
      Promise.resolve({ length: buffer.byteLength } as unknown as AudioBuffer);
    resume = () => Promise.resolve();
    close = () => Promise.resolve();
  }

  // 実装は window.AudioContext を見る。
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  return { started: () => started };
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
  let audio: { started: () => number };
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
