import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createAutoNickname } from '@/lib/participant/auto-nickname';
import { nicknameSchema } from '@/lib/validation/schemas';

/**
 * 名前を聞かずに参加してもらうときの表示名。
 *
 * ここで固めたいのは 2 つ。
 *   1. ニックネームとして通る形であること（保存に失敗すると参加できない）。
 *   2. 順番に振らないこと。開場直後は全員が同時に読むので、
 *      通し番号を数える場所を作るとそこが取り合いになる。
 */

describe('割り当てる表示名', () => {
  it('ニックネームとして保存できる形', () => {
    for (let index = 0; index < 50; index += 1) {
      const nickname = createAutoNickname();
      const parsed = nicknameSchema.safeParse(nickname);
      expect(parsed.success).toBe(true);
      // 正規化で形が変わらない（保存した名前と送った名前が食い違わない）。
      expect(parsed.success && parsed.data).toBe(nickname);
    }
  });

  it('「参加者」で始まり、会場で読み上げられる長さ', () => {
    const nickname = createAutoNickname();
    expect(nickname.startsWith('参加者')).toBe(true);
    expect(nickname.length).toBeLessThanOrEqual(20);
  });

  it('紛らわしい 0・1・I・O を使わない', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(createAutoNickname().slice(3)).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    }
  });

  /**
   * 500 人の会場でどこか 1 組がぶつかる見込みは 1 万分の 1 ほど。
   * ここでは「毎回同じ」「連番」になっていないことだけを見る
   * （ぶつかったときの引き直しは join-service が受け持つ）。
   */
  it('呼ぶたびに違う', () => {
    const names = new Set(Array.from({ length: 200 }, () => createAutoNickname()));
    expect(names.size).toBe(200);
  });
});
