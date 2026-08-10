import { describe, expect, it } from 'vitest';

// デプロイスクリプトは素の .mjs。判定ロジックは回帰しやすいのでここでテストする
// （tsconfig の allowJs により型は JSDoc から推論される）。
import { cliJson, extractJsonObject } from '../../../scripts/lib/cli-json.mjs';

/**
 * 実際に起きた不具合の回帰テスト。
 *
 * firebase CLI が完全な sdkConfig を出力しながら 0 以外で終了し、
 * 「公開設定を取得できませんでした」と誤って中断していた。
 * 判定は終了コードではなく出力内容で行う。
 */
const SDK_CONFIG_STDOUT = JSON.stringify({
  status: 'success',
  result: {
    sdkConfig: {
      projectId: 'idl-application',
      appId: '1:461269261166:web:65d25c8f22a5b18fa7bf7f',
      storageBucket: 'idl-application.firebasestorage.app',
      apiKey: 'AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE',
      authDomain: 'idl-application.firebaseapp.com',
      messagingSenderId: '461269261166',
    },
  },
});

describe('extractJsonObject', () => {
  it('前後に混ざった npm の出力を無視して JSON を取り出す', () => {
    const noisy = [
      'npm warn exec The following package was not found and will be installed: firebase-tools@15',
      '(node:12345) [DEP0190] DeprecationWarning: ...',
      SDK_CONFIG_STDOUT,
      'npm notice done',
    ].join('\n');

    expect(extractJsonObject(noisy)).toEqual(JSON.parse(SDK_CONFIG_STDOUT));
  });

  it('文字列リテラル内の波括弧で切り出しを誤らない', () => {
    const text = '{"error":"unexpected } brace","status":"error"}';
    expect(extractJsonObject(text)).toEqual({ error: 'unexpected } brace', status: 'error' });
  });

  it('エスケープされた引用符をまたいでも対応が取れる', () => {
    const text = String.raw`{"message":"say \"hi\" {now}"}`;
    expect(extractJsonObject(text)).toEqual({ message: 'say "hi" {now}' });
  });

  it('JSON が無ければ null を返す', () => {
    expect(extractJsonObject('Error: something went wrong')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject(undefined)).toBeNull();
  });

  it('壊れた候補を飛ばして後続の正しい JSON を拾う', () => {
    const text = '{ not json at all , } \n {"status":"success","result":{"appId":"abc"}}';
    expect(extractJsonObject(text)).toEqual({ status: 'success', result: { appId: 'abc' } });
  });
});

describe('cliJson', () => {
  it('終了コードが 0 以外でも、成功した JSON なら結果を返す', () => {
    const parsed = cliJson({ ok: false, status: 1, stdout: SDK_CONFIG_STDOUT });

    expect(parsed.ok).toBe(true);
    expect(parsed.result.sdkConfig.apiKey).toBe('AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE');
    expect(parsed.result.sdkConfig.projectId).toBe('idl-application');
  });

  it('終了コードが 0 でも、status: error なら失敗として扱う', () => {
    const parsed = cliJson({
      ok: true,
      status: 0,
      stdout: JSON.stringify({ status: 'error', error: 'HTTP Error: 403, PERMISSION_DENIED' }),
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('PERMISSION_DENIED');
  });

  it('エラー本文がオブジェクトでも文字列にして返す', () => {
    const parsed = cliJson({
      stdout: JSON.stringify({ status: 'error', error: { code: 403, message: 'denied' } }),
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('denied');
  });

  it('JSON が無ければ失敗として扱う', () => {
    expect(cliJson({ ok: true, status: 0, stdout: '' }).ok).toBe(false);
    expect(cliJson({}).ok).toBe(false);
  });

  it('result が無い形（payload 自身が設定）でも受け取れる', () => {
    const parsed = cliJson({ stdout: JSON.stringify({ projectId: 'p', apiKey: 'k' }) });

    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual({ projectId: 'p', apiKey: 'k' });
  });
});
