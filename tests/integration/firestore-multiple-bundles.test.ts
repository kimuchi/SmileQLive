// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * 司会画面（Server Component）と API（Route Handler）で
 * `getDb()` が両方から呼ばれても落ちないこと。
 *
 * Next.js は `src/infrastructure/firebase/admin.ts` を**層ごとに別々のモジュール実体**
 * として読み込む。そのためモジュール変数のキャッシュは層をまたいで共有されず、
 * 後から読み込まれた層は「まだ生成していない」と判断して `getDb()` の本体を実行する。
 * 一方 firebase-admin の `getFirestore(app, databaseId)` は**同じインスタンス**を返すので、
 * そこで `settings()` が二度目に呼ばれ
 *   「Firestore has already been initialized.」
 * で落ちていた。API は動くのに司会画面だけが「このルームを開けません」になる原因。
 *
 * `resetFirebaseAdmin()` は「キャッシュが空のもう 1 つのモジュール実体」と同じ状態を作る。
 * ここで 2 回目の `getDb()` が落ちなければ、層をまたいでも安全。
 *
 * エミュレータが無ければスキップする（npm test を壊さないため）。
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

async function emulatorReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://${EMULATOR}/`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const available = await emulatorReachable();

describe.skipIf(!available)('バンドルが分かれても Firestore を取得できる', () => {
  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = 'smileq-live-emulator';
    process.env.FIRESTORE_DATABASE_ID = 'smileq-live';
    process.env.FIREBASE_API_KEY = 'x';
    process.env.FIREBASE_AUTH_DOMAIN = 'x';
  });

  it('キャッシュが空の状態から呼び直しても落ちない', { timeout: 20000 }, async () => {
    const { getDb, resetFirebaseAdmin } = await import('@/infrastructure/firebase/admin');

    const first = getDb();
    // 実際に読み書きさせて settings を確定させる（本番の 1 リクエスト目に相当）。
    await first.collection('bundle-check').doc('a').get();

    // ここから先が「もう 1 つのモジュール実体」。
    resetFirebaseAdmin();

    expect(() => getDb()).not.toThrow();
    await expect(getDb().collection('bundle-check').doc('a').get()).resolves.toBeDefined();
  });

  it('省略した項目を undefined のまま書き込める（settings が効いている）', { timeout: 20000 }, async () => {
    const { getDb, resetFirebaseAdmin } = await import('@/infrastructure/firebase/admin');

    resetFirebaseAdmin();
    const db = getDb();
    const ref = db.collection('bundle-check').doc('ignore-undefined');

    // ignoreUndefinedProperties が無ければ、この書き込みは例外になる。
    await ref.set({ kept: 'ok', dropped: undefined });

    const snapshot = await ref.get();
    expect(snapshot.data()).toEqual({ kept: 'ok' });
  });
});
