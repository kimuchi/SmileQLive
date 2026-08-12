import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfigForTest } from '@/../scripts/lib/config.mjs';

/**
 * デプロイ時の Git チェック。
 *
 * 既定では**止めない**。配信されるのは作業ツリーそのもの（`--source .`）なので、
 * 未コミットの変更があること自体は誤りではない。
 * `npm run sounds:install` で取り込んだ音源のように、
 * コミットできないが配信したいファイルもあるため、ここで止めると手順が踏めなくなる。
 *
 * 止めたい場合だけ "strictGitChecks": true を設定する。
 *
 * なお、このテストは**何も出力してはいけない**。
 * `npm run deploy` は途中で検証を回すため、ここでの出力は
 * 運用者の画面に「本物の警告」として混ざってしまう。
 */

/** 警告が出ない、実運用に近い最小の設定。 */
function baseConfig() {
  return {
    projectId: 'example-project',
    region: 'asia-northeast1',
    serviceName: 'smileq-live',
    serviceAccount: 'runtime@example-project.iam.gserviceaccount.com',
    firebaseProjectId: 'example-project',
    firebaseApiKey: 'AIzaSyExampleKeyValue0123456789',
    firebaseAuthDomain: 'example-project.firebaseapp.com',
    mediaBucket: 'example-project-smileq-media',
    appBaseUrl: 'https://quiz.example.com',
  };
}

describe('デプロイ設定の Git チェック', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // 設定を読み込んだだけで運用者へ向けた文言が出ていないこと。
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('既定では止めない', () => {
    const config = normalizeConfigForTest(baseConfig(), 'production');
    expect(config.strictGitChecks).toBe(false);
  });

  it('strictGitChecks: true のときだけ止める', () => {
    expect(
      normalizeConfigForTest({ ...baseConfig(), strictGitChecks: true }, 'production')
        .strictGitChecks,
    ).toBe(true);
    expect(
      normalizeConfigForTest({ ...baseConfig(), strictGitChecks: false }, 'production')
        .strictGitChecks,
    ).toBe(false);
  });

  it('廃止した requireCleanTree では止まらない（案内だけ出す）', () => {
    const config = normalizeConfigForTest({ ...baseConfig(), requireCleanTree: true }, 'production');
    expect(config.strictGitChecks).toBe(false);
    // 案内を出すために、設定されていたことだけは残す。
    expect(config.legacyRequireCleanTree).toBe(true);
  });

  it('requireCleanTree と strictGitChecks が両方あれば strictGitChecks に従う', () => {
    const config = normalizeConfigForTest(
      { ...baseConfig(), requireCleanTree: false, strictGitChecks: true },
      'production',
    );
    expect(config.strictGitChecks).toBe(true);
  });

  it('appBaseUrl が本当に未設定なら警告する（この警告自体は正しい）', () => {
    const { appBaseUrl: _omitted, ...withoutBaseUrl } = baseConfig();
    normalizeConfigForTest(withoutBaseUrl, 'production');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('appBaseUrl');

    // ここは意図した警告なので、afterEach の検査からは外す。
    warnSpy.mockClear();
  });
});
