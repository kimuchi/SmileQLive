import { describe, expect, it } from 'vitest';

// デプロイスクリプトは素の .mjs（tsconfig の allowJs により型は JSDoc から推論される）。
import {
  classifyApiError,
  extractApiError,
  relevantLogLines,
} from '../../../scripts/lib/firebase-debug.mjs';

/**
 * firebase CLI のデバッグログは形が一定でない。
 * 1 つの形だけを見ていると 403 の理由を取りこぼし、案内が的外れになる。
 */
const ONE_LINE_BODY = [
  '[debug] [2026-08-11T02:00:00.000Z] >>> [apiv2][query] GET https://firebase.googleapis.com/v1beta1/projects',
  '[error] HTTP Error: 403, The caller does not have permission',
  '{"error":{"code":403,"message":"denied","status":"PERMISSION_DENIED"}}',
].join('\n');

const PRETTY_BODY = [
  '[debug] <<< [apiv2][status] GET https://firebase.googleapis.com/v1beta1/projects 403',
  '[debug] <<< [apiv2][body] GET https://firebase.googleapis.com/v1beta1/projects {',
  '  "error": {',
  '    "code": 403,',
  '    "message": "Firebase Management API has not been used in project 461269261166 before or it is disabled.",',
  '    "status": "PERMISSION_DENIED"',
  '  }',
  '}',
].join('\n');

const STATUS_ONLY = [
  '[debug] <<< [apiv2][status] GET https://firebase.googleapis.com/v1beta1/projects 403',
  '[error] Error: Failed with unexpected condition',
].join('\n');

describe('extractApiError', () => {
  it('1 行の error 本文を取り出す', () => {
    const { status, body } = extractApiError(ONE_LINE_BODY);

    expect(status).toBe('403');
    expect(JSON.parse(body).error.status).toBe('PERMISSION_DENIED');
  });

  it('改行を含む整形済みの error 本文も取り出す', () => {
    const { status, body } = extractApiError(PRETTY_BODY);

    expect(status).toBe('403');
    expect(JSON.parse(body).error.message).toContain('has not been used in project');
  });

  it('ステータス行しか無くても HTTP ステータスは取れる', () => {
    const { status, body } = extractApiError(STATUS_ONLY);

    expect(status).toBe('403');
    expect(body).toBe('');
  });

  it('直近（最後）のエラーを採る', () => {
    const text = [
      '{"error":{"code":404,"message":"old"}}',
      '[error] HTTP Error: 404, old',
      '{"error":{"code":403,"message":"new"}}',
      '[error] HTTP Error: 403, new',
    ].join('\n');
    const { status, body } = extractApiError(text);

    expect(status).toBe('403');
    expect(JSON.parse(body).error.message).toBe('new');
  });

  it('ログが空でも壊れない', () => {
    expect(extractApiError('')).toMatchObject({ status: '', body: '' });
    expect(extractApiError(undefined)).toMatchObject({ status: '', body: '' });
  });
});

describe('classifyApiError', () => {
  it('API 無効を権限不足と取り違えない', () => {
    // どちらも 403 で返るが対処が違う。優先順位は呼び出し側で決める。
    const kind = classifyApiError(PRETTY_BODY);

    expect(kind.serviceDisabled).toBe(true);
    expect(kind.permissionDenied).toBe(true);
  });

  it('ステータス行だけの 403 も権限不足として拾う', () => {
    const kind = classifyApiError(STATUS_ONLY);

    expect(kind.permissionDenied).toBe(true);
    expect(kind.serviceDisabled).toBe(false);
  });

  it('スコープ不足を見分ける', () => {
    const kind = classifyApiError('Request had insufficient authentication scopes.');

    expect(kind.insufficientScopes).toBe(true);
  });

  it('認証切れを見分ける', () => {
    const kind = classifyApiError('[debug] <<< [apiv2][status] GET https://example.com 401');

    expect(kind.unauthenticated).toBe(true);
  });

  it('404 を notFound として拾う', () => {
    expect(classifyApiError('HTTP Error: 404, Firebase project 123 not found').notFound).toBe(true);
  });

  it('正常なログでは何も立たない', () => {
    const kind = classifyApiError('[debug] <<< [apiv2][status] GET https://example.com 200');

    expect(kind.permissionDenied).toBe(false);
    expect(kind.serviceDisabled).toBe(false);
    expect(kind.unauthenticated).toBe(false);
    expect(kind.notFound).toBe(false);
  });
});

describe('relevantLogLines', () => {
  it('原因に関係しそうな行だけを末尾から返す', () => {
    const lines = relevantLogLines(STATUS_ONLY);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('403');
  });

  it('関係する行が無ければ空を返す', () => {
    expect(relevantLogLines('[debug] starting\n[debug] done')).toEqual([]);
  });
});
