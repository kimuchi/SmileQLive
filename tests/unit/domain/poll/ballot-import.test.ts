import { describe, expect, it } from 'vitest';
import { describeBallotImport, parseBallotText } from '@/domain/poll/ballot-import';
import { BALLOT_LABEL_MAX_LENGTH, BALLOT_OPTION_MAX_COUNT } from '@/domain/poll/ballot';

/**
 * 投票用紙の取り込み。
 *
 * 出し物の一覧はたいてい表計算ソフトにある。範囲をコピーして貼るだけ、
 * 書き出した CSV を読むだけで入れられることが要。
 *
 * いちばん大事なのは **黙って一部を落とさない**こと。
 * 落としたことに当日まで気づけないのがいちばん困る。
 */

describe('一覧から選ぶ（flat）', () => {
  it('1列だけ貼れば選択肢になる', () => {
    const result = parseBallotText('営業部 ダンス\n開発部 コント\n総務部 合唱', {
      structure: 'flat',
    });
    expect(result.options.map((option) => option.label)).toEqual([
      '営業部 ダンス',
      '開発部 コント',
      '総務部 合唱',
    ]);
    expect(result.groups).toEqual([]);
    expect(result.options.every((option) => option.groupLabel === null)).toBe(true);
  });

  it('2列目は補足として読む', () => {
    const result = parseBallotText('営業部 ダンス\t出演12名\n開発部 コント\t', {
      structure: 'flat',
    });
    expect(result.options[0]?.note).toBe('出演12名');
    // 空欄は null。空文字を入れない。
    expect(result.options[1]?.note).toBeNull();
  });

  it('見出しがあれば列を見出しで選ぶ', () => {
    const result = parseBallotText('補足,選択肢\n出演12名,営業部 ダンス', { structure: 'flat' });
    expect(result.headers).toEqual(['補足', '選択肢']);
    expect(result.options).toEqual([
      { label: '営業部 ダンス', note: '出演12名', groupLabel: null },
    ]);
  });
});

describe('2段階で選ぶ（nested）', () => {
  it('1列目を区分、2列目を選択肢として読む', () => {
    const result = parseBallotText(
      '本社,営業部 ダンス,出演12名\n本社,開発部 コント,\n大阪支店,大阪営業所 漫才,',
      { structure: 'nested' },
    );
    expect(result.groups).toEqual(['本社', '大阪支店']);
    expect(result.options.map((option) => [option.groupLabel, option.label])).toEqual([
      ['本社', '営業部 ダンス'],
      ['本社', '開発部 コント'],
      ['大阪支店', '大阪営業所 漫才'],
    ]);
  });

  it('区分は出てきた順に並び、同じ名前は 1 つにまとまる', () => {
    const result = parseBallotText('B,ろ\nA,い\nB,は', { structure: 'nested' });
    expect(result.groups).toEqual(['B', 'A']);
  });

  it('区分が空の行は取り込まず、数えて返す', () => {
    // 区分に属していない選択肢は参加者が選べない。当日に気づくのでは遅い。
    const result = parseBallotText('本社,営業部 ダンス\n,宙に浮いた出し物', {
      structure: 'nested',
    });
    expect(result.options).toHaveLength(1);
    expect(result.skippedNoGroup).toBe(1);
    expect(describeBallotImport(result)).toContain('区分が空の行 1件');
  });

  it('見出しがあれば区分・選択肢・補足を見出しで選ぶ', () => {
    const result = parseBallotText('選択肢,発表者,部署\n営業部 ダンス,山田,本社', {
      structure: 'nested',
    });
    expect(result.groups).toEqual(['本社']);
    expect(result.options[0]).toEqual({
      label: '営業部 ダンス',
      note: '山田',
      groupLabel: '本社',
    });
  });
});

describe('黙って落とさない', () => {
  it('空の行は飛ばして数える', () => {
    const result = parseBallotText('あ\n\n  \nい', { structure: 'flat' });
    expect(result.options).toHaveLength(2);
    // 完全な空行は行そのものを捨てるので skippedEmpty には入らない。
    expect(result.options.map((option) => option.label)).toEqual(['あ', 'い']);
  });

  it('長すぎる名前は切り詰めて数える', () => {
    const long = 'あ'.repeat(BALLOT_LABEL_MAX_LENGTH + 10);
    const result = parseBallotText(long, { structure: 'flat' });
    expect(result.options[0]?.label).toHaveLength(BALLOT_LABEL_MAX_LENGTH);
    expect(result.shortened).toBe(1);
    expect(describeBallotImport(result)).toContain('切り詰めました');
  });

  it('上限を超えた行は取り込まずに数える', () => {
    const text = Array.from({ length: BALLOT_OPTION_MAX_COUNT + 5 }, (_, i) => `項目${i}`).join(
      '\n',
    );
    const result = parseBallotText(text, { structure: 'flat' });
    expect(result.options).toHaveLength(BALLOT_OPTION_MAX_COUNT);
    expect(result.truncated).toBe(5);
    expect(describeBallotImport(result)).toContain('取り込みませんでした');
  });

  it('同じ名前は落とさずに数えるだけ', () => {
    // 同じ名前の出し物が本当に 2 つあることはある。勝手に消すと気づけない。
    const result = parseBallotText('合唱\n合唱', { structure: 'flat' });
    expect(result.options).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(describeBallotImport(result)).toContain('同じ名前が 1件');
  });
});

describe('表計算ソフトからの貼り付け', () => {
  it('タブ区切りを受け取る', () => {
    const result = parseBallotText('本社\t営業部 ダンス', { structure: 'nested' });
    expect(result.delimiter).toBe('tab');
    expect(result.options[0]?.label).toBe('営業部 ダンス');
  });

  it('引用符の中のカンマは区切りにしない', () => {
    const result = parseBallotText('"山田, 太郎",出演者です', { structure: 'flat' });
    expect(result.options[0]?.label).toBe('山田, 太郎');
    expect(result.options[0]?.note).toBe('出演者です');
  });
});

describe('列を明示して読む', () => {
  it('指定した列だけを読む', () => {
    const result = parseBallotText('無視,本社,営業部 ダンス', {
      structure: 'nested',
      hasHeader: false,
      groupColumnIndex: 1,
      labelColumnIndex: 2,
      noteColumnIndex: null,
    });
    expect(result.options[0]).toEqual({
      label: '営業部 ダンス',
      groupLabel: '本社',
      note: null,
    });
  });
});
