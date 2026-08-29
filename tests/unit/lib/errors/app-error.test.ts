import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_DEFINITIONS,
  AppError,
  isAppErrorCode,
  statusForCode,
  toAppError,
  userMessageForCode,
  type AppErrorCode,
} from '@/lib/errors/app-error';

/**
 * エラー定義は「利用者に技術用語を見せない」ための唯一の窓口。
 * 仕様書 §34.1 の対応表と §21.4 のステータスに一致していることを検証する。
 */

const ALL_CODES = Object.keys(APP_ERROR_DEFINITIONS) as AppErrorCode[];

describe('エラー定義の網羅性', () => {
  it('すべてのコードに status と日本語メッセージがある', () => {
    for (const code of ALL_CODES) {
      const definition = APP_ERROR_DEFINITIONS[code];
      expect(definition.status, `${code} に status がない`).toBeGreaterThanOrEqual(400);
      expect(definition.status, `${code} の status が不正`).toBeLessThan(600);
      expect(definition.message.length, `${code} のメッセージが空`).toBeGreaterThan(0);
    }
  });

  it('メッセージが日本語で、技術用語やスタックを含まない', () => {
    const forbidden = [
      'Error:',
      'undefined',
      'null',
      'SQL',
      'Firestore',
      'Firebase',
      'PERMISSION_DENIED',
      'stack',
      'Exception',
    ];
    for (const code of ALL_CODES) {
      const { message } = APP_ERROR_DEFINITIONS[code];
      // 日本語（ひらがな・カタカナ・漢字）を含むこと
      expect(message, `${code}: 日本語になっていない`).toMatch(/[぀-ゟ゠-ヿ一-鿿]/);
      for (const word of forbidden) {
        expect(message, `${code}: 内部用語「${word}」が露出している`).not.toContain(word);
      }
      // 内部コードそのものを利用者へ見せない
      expect(message).not.toContain(code);
    }
  });

  it('§34.1 の対応表どおりのメッセージになっている', () => {
    const expected: Partial<Record<AppErrorCode, string>> = {
      JOIN_LINK_INVALID: 'この参加URLは無効です',
      JOIN_LINK_REVOKED: 'この参加URLは更新されています。会場の二次元コードを読み直してください',
      JOIN_CLOSED: 'このクイズは参加受付を終了しています',
      ROOM_FULL: '参加人数が上限に達しました',
      NICKNAME_TAKEN: '同じ名前が使われています',
      ANSWER_ALREADY_EXISTS: 'この問題には回答済みです',
      ANSWER_DEADLINE_PASSED: '回答時間が終了しました',
      INVALID_CHOICE: '選択肢を選び直してください',
      INVALID_NUMBER_FORMAT: '数値だけを入力してください',
      NUMBER_TOO_LARGE: '入力できる桁数を超えています',
      STATE_VERSION_CONFLICT: '画面を最新状態へ更新しました',
    };
    for (const [code, message] of Object.entries(expected)) {
      expect(userMessageForCode(code as AppErrorCode)).toBe(message);
    }
  });

  it('§21.4 のステータス割り当てに従う', () => {
    expect(statusForCode('UNAUTHENTICATED')).toBe(401);
    expect(statusForCode('FORBIDDEN')).toBe(403);
    expect(statusForCode('JOIN_CLOSED')).toBe(403);
    expect(statusForCode('JOIN_LINK_INVALID')).toBe(404);
    expect(statusForCode('ROOM_NOT_FOUND')).toBe(404);
    // 状態競合・重複・二重回答は 409
    expect(statusForCode('STATE_VERSION_CONFLICT')).toBe(409);
    expect(statusForCode('NICKNAME_TAKEN')).toBe(409);
    expect(statusForCode('ANSWER_ALREADY_EXISTS')).toBe(409);
    expect(statusForCode('ROOM_FULL')).toBe(409);
    // 参加URL・投影URLの失効は 410
    expect(statusForCode('JOIN_LINK_REVOKED')).toBe(410);
    expect(statusForCode('PRESENTATION_LINK_EXPIRED')).toBe(410);
    // 公開条件未達・数値形式不正は 422
    expect(statusForCode('QUIZ_PUBLISH_VALIDATION_FAILED')).toBe(422);
    expect(statusForCode('INVALID_NUMBER_FORMAT')).toBe(422);
    expect(statusForCode('NUMBER_TOO_LARGE')).toBe(422);
    // 試行回数超過は 429
    expect(statusForCode('RATE_LIMITED')).toBe(429);
  });

  it('数値正規化のエラーコードがすべて定義されている', () => {
    // number-normalizer が投げうるコードは、必ず利用者向け文言を持つこと
    for (const code of [
      'INVALID_NUMBER_FORMAT',
      'INVALID_NUMBER_LENGTH',
      'NUMBER_TOO_LARGE',
      'NUMBER_TOO_MANY_DECIMALS',
    ] as const) {
      expect(isAppErrorCode(code)).toBe(true);
      expect(userMessageForCode(code).length).toBeGreaterThan(0);
    }
  });
});

describe('isAppErrorCode', () => {
  it('定義済みのコードを判別する', () => {
    expect(isAppErrorCode('ROOM_FULL')).toBe(true);
    expect(isAppErrorCode('NOT_A_REAL_CODE')).toBe(false);
    // Object.prototype 由来のキーを誤判定しない
    expect(isAppErrorCode('toString')).toBe(false);
    expect(isAppErrorCode('constructor')).toBe(false);
    expect(isAppErrorCode('__proto__')).toBe(false);
  });
});

describe('AppError', () => {
  it('コードから status と利用者向けメッセージを導出する', () => {
    const error = new AppError('ROOM_FULL');
    expect(error.code).toBe('ROOM_FULL');
    expect(error.status).toBe(409);
    expect(error.userMessage).toBe('参加人数が上限に達しました');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
  });

  it('details と cause を保持する', () => {
    const cause = new Error('内部の原因');
    const error = new AppError('INTERNAL_ERROR', { details: { field: 'nickname' }, cause });
    expect(error.details).toEqual({ field: 'nickname' });
    expect(error.cause).toBe(cause);
  });

  it('message には内部コードが入り、利用者へは userMessage を使う', () => {
    const error = new AppError('FORBIDDEN');
    expect(error.message).toBe('FORBIDDEN');
    expect(error.userMessage).not.toBe(error.message);
  });
});

describe('toAppError', () => {
  it('AppError はそのまま返す', () => {
    const original = new AppError('JOIN_CLOSED');
    expect(toAppError(original)).toBe(original);
  });

  it('未知の例外は INTERNAL_ERROR へ畳み込み、内部情報を利用者へ出さない', () => {
    const converted = toAppError(new Error('DB connection string leaked here'));
    expect(converted.code).toBe('INTERNAL_ERROR');
    expect(converted.status).toBe(500);
    expect(converted.userMessage).not.toContain('DB connection string');
    // 原因は cause に残しておく（ログ用）
    expect(converted.cause).toBeInstanceOf(Error);
  });

  it('文字列や null も安全に変換する', () => {
    expect(toAppError('何かの文字列').code).toBe('INTERNAL_ERROR');
    expect(toAppError(null).code).toBe('INTERNAL_ERROR');
    expect(toAppError(undefined).code).toBe('INTERNAL_ERROR');
  });
});

/**
 * 索引がまだ使えないとき。
 *
 * 新しい一覧を足して索引を反映したあと、構築が終わるまで必ずここを通る。
 * 「処理に失敗しました」に丸めると、待てば直るのか壊れているのかが分からない。
 */
describe('Firestore の索引が使えないとき', () => {
  /** Firestore Admin SDK が投げる形（gRPC の code と本文）。 */
  function firestoreError(code: number | string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  it('索引が無い・構築中は待てば直ると伝える', () => {
    for (const message of [
      '9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://...',
      '9 FAILED_PRECONDITION: The query requires an index. That index is currently building and cannot be used yet.',
    ]) {
      const converted = toAppError(firestoreError(9, message));
      expect(converted.code).toBe('INDEX_NOT_READY');
      expect(converted.status).toBe(503);
      expect(converted.userMessage).toContain('数分おいて');
      // 索引の URL など内部の手掛かりは利用者へ出さない（ログには cause で残る）。
      expect(converted.userMessage).not.toContain('index');
    }
  });

  it('Web SDK の文字列コードでも同じに扱う', () => {
    const converted = toAppError(
      firestoreError('failed-precondition', 'The query requires an index.'),
    );
    expect(converted.code).toBe('INDEX_NOT_READY');
  });

  it('索引と関係ない FAILED_PRECONDITION は畳み込まない', () => {
    // 9 は他の理由でも返る。待っても直らないものを「待てば直る」と言わない。
    const converted = toAppError(
      firestoreError(9, '9 FAILED_PRECONDITION: The database does not exist'),
    );
    expect(converted.code).toBe('INTERNAL_ERROR');
  });

  it('本文が同じでも別のコードなら畳み込まない', () => {
    const converted = toAppError(firestoreError(7, 'The query requires an index.'));
    expect(converted.code).toBe('INTERNAL_ERROR');
  });
});
