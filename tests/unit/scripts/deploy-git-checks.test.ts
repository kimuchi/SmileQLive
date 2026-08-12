import { describe, expect, it } from 'vitest';
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
 */
describe('デプロイ設定の Git チェック', () => {
  it('既定では止めない', () => {
    const config = normalizeConfigForTest({}, 'production');
    expect(config.strictGitChecks).toBe(false);
  });

  it('strictGitChecks: true のときだけ止める', () => {
    expect(normalizeConfigForTest({ strictGitChecks: true }, 'production').strictGitChecks).toBe(
      true,
    );
    expect(normalizeConfigForTest({ strictGitChecks: false }, 'production').strictGitChecks).toBe(
      false,
    );
  });

  it('廃止した requireCleanTree では止まらない（案内だけ出す）', () => {
    const config = normalizeConfigForTest({ requireCleanTree: true }, 'production');
    expect(config.strictGitChecks).toBe(false);
    // 案内を出すために、設定されていたことだけは残す。
    expect(config.legacyRequireCleanTree).toBe(true);
  });

  it('requireCleanTree と strictGitChecks が両方あれば strictGitChecks に従う', () => {
    const config = normalizeConfigForTest(
      { requireCleanTree: false, strictGitChecks: true },
      'production',
    );
    expect(config.strictGitChecks).toBe(true);
  });
});
