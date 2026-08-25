import { describe, expect, it } from 'vitest';
import { fitFontSize, textWidthRatio } from '@/domain/draw/fit-text';

/**
 * 名前を切らずに収める。
 *
 * 会場で聞かれるのは「誰が当たったか」。一覧で「山田…」と切れていては
 * 出す意味がない。入らないぶんは字を小さくして、最後まで見せる。
 */
describe('収まる文字の大きさ', () => {
  it('全角は半角より幅を取る', () => {
    expect(textWidthRatio('山田太郎')).toBeGreaterThan(textWidthRatio('yamada'));
  });

  it('短い名前は設定どおりの大きさのまま', () => {
    expect(fitFontSize('田中', { maxWidth: 400, maxFontSize: 96 })).toBe(96);
  });

  it('長い名前は、幅に収まるまで小さくする', () => {
    const wide = 300;
    const label = '営業推進部 山田 太郎';
    const size = fitFontSize(label, { maxWidth: wide, maxFontSize: 96 });

    expect(size).toBeLessThan(96);
    // 見積もった幅が枠を超えない（超えると切れる）。
    expect(textWidthRatio(label) * size).toBeLessThanOrEqual(wide + 0.001);
  });

  it('小さくしすぎない。下限まで下げても入らないときは下限で止める', () => {
    // ここまで来たら、縮めるより折り返させたほうが読める。
    const size = fitFontSize('と'.repeat(200), { maxWidth: 300, maxFontSize: 96 });
    expect(size).toBe(28);
  });

  it('設定が下限より小さいときは、設定のほうを尊重する', () => {
    // 利用者が小さい字を選んでいるなら、勝手に大きくしない。
    expect(fitFontSize('あ'.repeat(50), { maxWidth: 100, maxFontSize: 20 })).toBe(20);
  });

  it('幅が取れないときは設定どおりに返す（描画側の折り返しに任せる）', () => {
    expect(fitFontSize('山田', { maxWidth: 0, maxFontSize: 96 })).toBe(96);
  });
});
