import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { mediaBucket, mediaBucketSource } = await import('@/lib/env/server-env');

/**
 * 画像の保存先バケットの決め方。
 *
 * 会場で「画像だけアップロードできない」が起きたとき、原因の切り分けに直結する。
 * 環境変数を渡し忘れると、プロジェクト ID から組み立てた**実在しない名前**へ
 * 書きに行き、「バケットが見つかりません」とだけ出て理由が分からなかった。
 * どこから決めた名前なのかを言えるようにしてある。
 */
const KEYS = [
  'MEDIA_BUCKET',
  'QUIZ_MEDIA_BUCKET',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_PROJECT_ID',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    delete process.env[key];
  }
  process.env.FIREBASE_PROJECT_ID = 'example-project';
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

describe('画像の保存先バケット', () => {
  it('MEDIA_BUCKET を最優先する', () => {
    process.env.MEDIA_BUCKET = 'my-media';
    process.env.FIREBASE_STORAGE_BUCKET = 'other';

    expect(mediaBucket()).toBe('my-media');
    expect(mediaBucketSource()).toBe('MEDIA_BUCKET');
  });

  it('旧名 QUIZ_MEDIA_BUCKET も受ける', () => {
    process.env.QUIZ_MEDIA_BUCKET = 'legacy-media';

    expect(mediaBucket()).toBe('legacy-media');
    expect(mediaBucketSource()).toBe('QUIZ_MEDIA_BUCKET');
  });

  it('無ければ FIREBASE_STORAGE_BUCKET を使う', () => {
    process.env.FIREBASE_STORAGE_BUCKET = 'fallback-media';

    expect(mediaBucket()).toBe('fallback-media');
    expect(mediaBucketSource()).toBe('FIREBASE_STORAGE_BUCKET');
  });

  it('何も無ければプロジェクト ID から組み立て、それと分かるようにする', () => {
    // この既定値は「設定を渡し忘れた」ときにだけ現れる。
    // 実在しないことが多いので、名前だけでなく出どころも言えないと直せない。
    expect(mediaBucket()).toBe('example-project.firebasestorage.app');
    expect(mediaBucketSource()).toBe('default');
  });

  it('空文字は「設定されていない」として扱う', () => {
    // Cloud Run へ空の値が渡ったときに、空のバケット名で書きに行かせない。
    process.env.MEDIA_BUCKET = '   ';

    expect(mediaBucket()).toBe('example-project.firebasestorage.app');
    expect(mediaBucketSource()).toBe('default');
  });
});
