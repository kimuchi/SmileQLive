import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * アプリが実際に書きに行くバケットが、設定した MEDIA_BUCKET と一致すること。
 *
 * ここが一致していなかったために、会場で「画像だけアップロードできない」が起きた。
 * 設定ファイル・デプロイ・手順書・診断はすべて MEDIA_BUCKET を指しているのに、
 * Storage を掴む側だけが FIREBASE_STORAGE_BUCKET を見ていて、
 * 実在しない `<プロジェクトID>.firebasestorage.app` へ書きに行っていた。
 *
 * バケット名の決め方は 1 か所（server-env の mediaBucket）に集約してある。
 * ここが二重になると同じ事故が起きるので、実際に掴むバケット名で突き合わせる。
 */
const KEYS = ['MEDIA_BUCKET', 'FIREBASE_STORAGE_BUCKET', 'FIREBASE_PROJECT_ID'] as const;

let saved: Record<string, string | undefined> = {};

/** Admin SDK は本物を初期化させない。確かめたいのは「どの名前でバケットを掴むか」だけ。 */
const bucketCalls: string[] = [];

vi.mock('firebase-admin/app', () => ({
  getApps: () => [],
  initializeApp: (options: unknown) => ({ options }),
  cert: () => ({}),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({ settings: () => {} }) }));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: (name: string) => {
      bucketCalls.push(name);
      return { name };
    },
  }),
}));

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    delete process.env[key];
  }
  process.env.FIREBASE_PROJECT_ID = 'example-project';
  bucketCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

async function bucketNameUsedByApp(): Promise<string> {
  const { getMediaBucket } = await import('@/infrastructure/firebase/admin');
  return getMediaBucket().name;
}

describe('アプリが掴むバケット', () => {
  it('MEDIA_BUCKET を設定したら、そのバケットへ書きに行く', async () => {
    // これが効いていなかったのが事故の原因。
    process.env.MEDIA_BUCKET = 'idl-application-smileq-media';
    process.env.FIREBASE_STORAGE_BUCKET = 'example-project.firebasestorage.app';

    expect(await bucketNameUsedByApp()).toBe('idl-application-smileq-media');
  });

  it('設定の決め方が 1 か所であること', async () => {
    process.env.MEDIA_BUCKET = 'single-source';

    const { mediaBucket } = await import('@/lib/env/server-env');
    expect(await bucketNameUsedByApp()).toBe(mediaBucket());
  });

  it('MEDIA_BUCKET が無ければ FIREBASE_STORAGE_BUCKET を使う', async () => {
    process.env.FIREBASE_STORAGE_BUCKET = 'legacy-bucket';

    expect(await bucketNameUsedByApp()).toBe('legacy-bucket');
  });

  it('どちらも無ければ Firebase の既定名', async () => {
    expect(await bucketNameUsedByApp()).toBe('example-project.firebasestorage.app');
  });
});
