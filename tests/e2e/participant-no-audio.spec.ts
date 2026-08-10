import { expect, test, type Page } from '@playwright/test';

/**
 * 参加者画面は音・振動を一切扱わない（仕様書 §37.3 / §32.4）。
 *
 * 効果音は**投影画面だけ**の責務。
 * 会場で数百台の端末が一斉に鳴る・震えるのを防ぐため、参加者画面からは
 * `src/lib/audio/**` を import できないよう ESLint でも禁止しているが、
 * ここでは **実際にブラウザで開いて音が鳴らないこと**を確かめる。
 *
 * この spec は Firebase を必要としない。
 * 参加登録できなくても（API が失敗しても）音が鳴らないことは変わらないため。
 */

/** ブラウザ側に仕込む検出フラグ。 */
type AudioProbe = {
  /** AudioContext / webkitAudioContext が new された。 */
  audioContext: boolean;
  /** HTMLAudioElement / HTMLMediaElement の play() が呼ばれた。 */
  audioPlay: boolean;
  /** navigator.vibrate() が呼ばれた。 */
  vibrate: boolean;
};

const PROBE_KEY = '__smileqAudioProbe';

/** 音声ファイルとみなす拡張子。 */
const AUDIO_FILE_PATTERN = /\.(mp3|wav|ogg|oga|m4a|aac|flac|weba)(\?|#|$)/i;

/** 効果音の置き場所（投影画面だけが読む）。 */
const SOUNDS_PATH_PATTERN = /\/sounds\//i;

/** 形式は正しいが実在しない参加トークン。 */
const JOIN_PATH = '/j/aaaaaaaaaaaaaaaaaaaaaa';
/** 形式が正しいルーム ID（実在しなくてよい。画面がエラー表示になるだけ）。 */
const PLAY_PATH = '/play/00000000-0000-4000-8000-000000000000';

/** 画面が落ち着くまでの待ち時間。「起きないこと」を確かめるので少し余裕を持たせる。 */
const SETTLE_MS = 2500;

/**
 * 音・振動の呼び出しを検出するフックを、ページ読み込み前に仕込む。
 *
 * 実装が無いブラウザ（webkitAudioContext を持たない Chromium など）でも
 * 「呼ばれたら分かる」ようにするため、存在の有無にかかわらず差し替える。
 */
async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = {
      audioContext: false,
      audioPlay: false,
      vibrate: false,
    };

    const win = window as unknown as Record<string, unknown>;
    win.__smileqAudioProbe = probe;

    // AudioContext / webkitAudioContext
    for (const key of ['AudioContext', 'webkitAudioContext']) {
      win[key] = class ProbeAudioContext {
        constructor() {
          probe.audioContext = true;
        }
      };
    }

    // <audio>.play() / <video>.play()
    // HTMLAudioElement は play() を HTMLMediaElement から継承するため両方を差し替える。
    const markPlay = function markPlay(): Promise<void> {
      probe.audioPlay = true;
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.play = markPlay;
    HTMLAudioElement.prototype.play = markPlay;

    // navigator.vibrate（実装が無い端末でも定義して検出できるようにする）
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      writable: true,
      value: () => {
        probe.vibrate = true;
        return true;
      },
    });
  });
}

/** 仕込んだフラグを読み出す。 */
async function readAudioProbe(page: Page): Promise<AudioProbe | undefined> {
  return page.evaluate(
    () => (window as unknown as Record<string, AudioProbe | undefined>).__smileqAudioProbe,
  );
}

/** 音声ファイルへのリクエストを記録する。 */
function trackAudioRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (AUDIO_FILE_PATTERN.test(url) || SOUNDS_PATH_PATTERN.test(url)) {
      requested.push(url);
    }
  });
  return requested;
}

test.describe('参加者画面は音・振動を扱わない', () => {
  test('/j/<token> を開いても音・振動が発生しない', async ({ page }) => {
    await installAudioProbe(page);
    const audioRequests = trackAudioRequests(page);

    await page.goto(JOIN_PATH);
    await page.waitForTimeout(SETTLE_MS);

    const probe = await readAudioProbe(page);
    expect(probe, 'フックが仕込まれていない（テストが空振りしている）').toBeDefined();
    expect(probe?.audioContext, 'AudioContext が生成された').toBe(false);
    expect(probe?.audioPlay, 'audio.play() が呼ばれた').toBe(false);
    expect(probe?.vibrate, 'navigator.vibrate() が呼ばれた').toBe(false);

    expect(audioRequests, '音声ファイルを取得している').toEqual([]);
    await expect(page.locator('audio, video')).toHaveCount(0);
  });

  test('/play/<roomId> を開いても音・振動が発生しない', async ({ page }) => {
    await installAudioProbe(page);
    const audioRequests = trackAudioRequests(page);

    await page.goto(PLAY_PATH);
    await page.waitForTimeout(SETTLE_MS);

    const probe = await readAudioProbe(page);
    expect(probe, 'フックが仕込まれていない（テストが空振りしている）').toBeDefined();
    expect(probe?.audioContext, 'AudioContext が生成された').toBe(false);
    expect(probe?.audioPlay, 'audio.play() が呼ばれた').toBe(false);
    expect(probe?.vibrate, 'navigator.vibrate() が呼ばれた').toBe(false);

    expect(audioRequests, '音声ファイルを取得している').toEqual([]);
    await expect(page.locator('audio, video')).toHaveCount(0);
  });

  test('参加者画面を続けて遷移しても音声ファイルを取りに行かない', async ({ page }) => {
    await installAudioProbe(page);
    const audioRequests = trackAudioRequests(page);

    await page.goto(JOIN_PATH);
    await page.waitForTimeout(SETTLE_MS);
    await page.goto(PLAY_PATH);
    await page.waitForTimeout(SETTLE_MS);

    expect(audioRequests, '音声ファイルを取得している').toEqual([]);

    const probe = await readAudioProbe(page);
    expect(probe?.audioContext).toBe(false);
    expect(probe?.audioPlay).toBe(false);
    expect(probe?.vibrate).toBe(false);
  });

  test('フック自体が機能している（このテストが空振りしていないことの確認）', async ({ page }) => {
    // フックが壊れていると、上の 3 件は「常に false」で無条件に通ってしまう。
    // わざと呼び出して、確かに検出できることを確かめる。
    await installAudioProbe(page);
    await page.goto(JOIN_PATH);

    const detected = await page.evaluate((probeKey) => {
      const win = window as unknown as Record<string, unknown>;
      const AudioContextCtor = win.AudioContext as new () => unknown;
      new AudioContextCtor();
      void new Audio().play();
      navigator.vibrate?.(10);
      return win[probeKey] as AudioProbe;
    }, PROBE_KEY);

    expect(detected.audioContext).toBe(true);
    expect(detected.audioPlay).toBe(true);
    expect(detected.vibrate).toBe(true);
  });
});
