import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_INPUT_MIME_TYPES,
  IMAGE_ALT_MAX_LENGTH,
  MAX_EDGE_BY_USAGE,
  MAX_UPLOAD_BYTES,
  MEDIA_USAGES,
  OUTPUT_MIME_TYPE,
  WEBP_QUALITY,
  buildObjectPath,
  isAcceptedInputMime,
  isMediaUsage,
} from '@/domain/media/image-policy';

/**
 * 画像アップロードのポリシー（仕様書 §37.1）。
 *
 * 保存パスから正解が推測できてはいけない。
 * 「正解・解説画像」であっても、パスには usage を出さない。
 */

/** 正解を推測させうる語。パスに現れてはならない。 */
const FORBIDDEN_PATH_WORDS = /correct|answer|reveal|solution|正解|解説/i;

describe('buildObjectPath', () => {
  it('<ownerId>/<quizId>/<assetId>.webp の形になる', () => {
    expect(buildObjectPath('owner-1', 'quiz-1', 'asset-1')).toBe('owner-1/quiz-1/asset-1.webp');
  });

  it('正解を推測させる語を含まない', () => {
    const path = buildObjectPath(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );

    expect(path).not.toMatch(FORBIDDEN_PATH_WORDS);
  });

  it('usage をパスへ含めない（正解画像と問題画像を区別できない）', () => {
    // 同じ owner / quiz なら、用途が違ってもパスの形は完全に同じ。
    const questionImage = buildObjectPath('owner-1', 'quiz-1', 'asset-1');
    const revealImage = buildObjectPath('owner-1', 'quiz-1', 'asset-2');

    for (const usage of MEDIA_USAGES) {
      expect(questionImage).not.toContain(usage);
      expect(revealImage).not.toContain(usage);
    }
    expect(questionImage.split('/')).toHaveLength(3);
    expect(revealImage.split('/')).toHaveLength(3);
    expect(questionImage.replace('asset-1', 'X')).toBe(revealImage.replace('asset-2', 'X'));
  });

  it('常に .webp 拡張子になる（保存形式は WebP のみ）', () => {
    expect(buildObjectPath('o', 'q', 'a').endsWith('.webp')).toBe(true);
  });
});

describe('usage ごとの長辺上限', () => {
  it('問題画像と正解画像は 1600px、選択肢画像は 1000px', () => {
    expect(MAX_EDGE_BY_USAGE.question).toBe(1600);
    expect(MAX_EDGE_BY_USAGE.reveal).toBe(1600);
    expect(MAX_EDGE_BY_USAGE.choice).toBe(1000);
  });

  it('すべての usage に上限が定義されている', () => {
    for (const usage of MEDIA_USAGES) {
      expect(MAX_EDGE_BY_USAGE[usage]).toBeGreaterThan(0);
    }
    expect(Object.keys(MAX_EDGE_BY_USAGE).sort()).toEqual([...MEDIA_USAGES].sort());
  });

  it('選択肢画像は投影で並べるため、問題画像より小さい', () => {
    expect(MAX_EDGE_BY_USAGE.choice).toBeLessThan(MAX_EDGE_BY_USAGE.question);
  });
});

describe('isMediaUsage', () => {
  it('定義済みの usage だけを受理する', () => {
    expect(isMediaUsage('question')).toBe(true);
    expect(isMediaUsage('choice')).toBe(true);
    expect(isMediaUsage('reveal')).toBe(true);
    expect(isMediaUsage('avatar')).toBe(false);
    expect(isMediaUsage('')).toBe(false);
  });
});

describe('isAcceptedInputMime', () => {
  it('JPEG / PNG / WebP を受理する', () => {
    for (const mime of ACCEPTED_INPUT_MIME_TYPES) {
      expect(isAcceptedInputMime(mime)).toBe(true);
    }
  });

  it('SVG・GIF・動画・実行形式を拒否する', () => {
    for (const mime of [
      'image/svg+xml',
      'image/gif',
      'image/avif',
      'video/mp4',
      'application/octet-stream',
      'text/html',
    ]) {
      expect(isAcceptedInputMime(mime)).toBe(false);
    }
  });
});

describe('定数', () => {
  it('アップロード上限は 8MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(8 * 1024 * 1024);
  });

  it('出力は WebP のみ', () => {
    expect(OUTPUT_MIME_TYPE).toBe('image/webp');
    expect(WEBP_QUALITY).toBeGreaterThan(0);
    expect(WEBP_QUALITY).toBeLessThanOrEqual(100);
  });

  it('代替テキストの上限が定義されている', () => {
    expect(IMAGE_ALT_MAX_LENGTH).toBe(120);
  });
});
