import { describe, expect, it } from 'vitest';
import { pollSettingsOf, type PollSnapshot } from '@/domain/poll/ballot';
import { pollResultOf, pollStageOf, pollTallyRowsOf } from '@/domain/poll/poll-stage';
import { rankOptions, tallyVotes } from '@/domain/poll/tally';

/**
 * 画面へ渡す形。
 *
 * いちばん大事なのは「**まだ出していない順位を渡さない**」こと。
 * 画面で隠す作りにすると、投影の HTML から先に読めてしまう。
 */

const OPTION_IDS = ['a', 'b', 'c'];

const snapshot: PollSnapshot = {
  ballotId: 'ballot-1',
  title: '出し物コンテスト',
  structure: 'nested',
  groups: [
    { id: 'g1', position: 1, label: '本社' },
    { id: 'g2', position: 2, label: '大阪支店' },
  ],
  options: [
    { id: 'a', position: 1, label: '営業部 ダンス', groupId: 'g1', note: '3分' },
    { id: 'b', position: 2, label: '開発部 コント', groupId: 'g1', note: null },
    { id: 'c', position: 3, label: '大阪 漫才', groupId: 'g2', note: null },
  ],
  settings: pollSettingsOf({ rankDepth: 1, points: [1], revealDepth: 3 }),
};

/** a=3票 / b=2票 / c=1票 → 1位a, 2位b, 3位c。 */
function ranked() {
  const tally = tallyVotes(OPTION_IDS, 1, [['a'], ['a'], ['a'], ['b'], ['b'], ['c']]);
  return { tally, ranked: rankOptions(tally, OPTION_IDS, snapshot.settings) };
}

describe('参加者・投影が見る投票そのもの', () => {
  it('選択肢と人数だけを渡す', () => {
    const stage = pollStageOf(snapshot, { voteCount: 12, participantCount: 20 });
    expect(stage.title).toBe('出し物コンテスト');
    expect(stage.options).toHaveLength(3);
    expect(stage.groups).toHaveLength(2);
    expect(stage.voteCount).toBe(12);
    expect(stage.participantCount).toBe(20);
  });

  it('票数も順位も入っていない', () => {
    // 投票中に途中経過が見えると、あとの人の投票が引っぱられる。
    const stage = pollStageOf(snapshot, { voteCount: 12, participantCount: 20 });
    const text = JSON.stringify(stage);
    expect(text).not.toContain('counts');
    expect(text).not.toContain('score');
    expect(text).not.toContain('rank"');
  });
});

describe('発表用の結果', () => {
  it('まだ 1 つも出していなければ空', () => {
    const result = pollResultOf(snapshot, ranked().ranked, 0);
    expect(result.entries).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('1 回押すと 3 位だけを渡す', () => {
    const result = pollResultOf(snapshot, ranked().ranked, 1);
    expect(result.entries.map((entry) => entry.rank)).toEqual([3]);
    // 1 位・2 位の名前はどこにも入っていない。
    const text = JSON.stringify(result);
    expect(text).not.toContain('営業部 ダンス');
    expect(text).not.toContain('開発部 コント');
  });

  it('押すたびに 1 つずつ増え、下の順位から並ぶ', () => {
    const { ranked: rows } = ranked();
    expect(pollResultOf(snapshot, rows, 2).entries.map((entry) => entry.rank)).toEqual([3, 2]);
    expect(pollResultOf(snapshot, rows, 3).entries.map((entry) => entry.rank)).toEqual([3, 2, 1]);
  });

  it('出しきったら complete', () => {
    expect(pollResultOf(snapshot, ranked().ranked, 3).complete).toBe(true);
  });

  it('1 位だけ発表する会では 1 位しか出さない', () => {
    const onlyFirst: PollSnapshot = {
      ...snapshot,
      settings: pollSettingsOf({ ...snapshot.settings, revealDepth: 1 }),
    };
    const rows = rankOptions(ranked().tally, OPTION_IDS, onlyFirst.settings);
    const result = pollResultOf(onlyFirst, rows, 1);
    expect(result.entries.map((entry) => entry.rank)).toEqual([1]);
    expect(result.complete).toBe(true);
  });

  it('名前・補足・1 階層目の名前を添える', () => {
    const first = pollResultOf(snapshot, ranked().ranked, 3).entries.at(-1);
    expect(first?.label).toBe('営業部 ダンス');
    expect(first?.note).toBe('3分');
    expect(first?.groupLabel).toBe('本社');
    expect(first?.totalVotes).toBe(3);
  });

  it('用紙から消えた選択肢でも落ちない', () => {
    // 集計だけ残って用紙から消えた、という状態でも発表は続けられる。
    const rows = rankOptions(
      { voterCount: 1, entries: [{ optionId: 'gone', counts: [1] }] },
      ['gone'],
      snapshot.settings,
    );
    const entry = pollResultOf(snapshot, rows, 3).entries[0];
    expect(entry?.label).toBe('（削除された選択肢）');
  });
});

describe('選択肢より多い順位は発表しない', () => {
  it('2 件しか無い用紙で「3位まで」と決めても 2 位から出る', () => {
    // そのまま 3 位から出すと、司会が押したのに投影へ何も出ない。
    const twoOptions: PollSnapshot = {
      ...snapshot,
      options: snapshot.options.slice(0, 2),
    };
    const ids = twoOptions.options.map((option) => option.id);
    const rows = rankOptions(tallyVotes(ids, 1, [['a'], ['a'], ['b']]), ids, twoOptions.settings);

    const first = pollResultOf(twoOptions, rows, 1);
    expect(first.revealDepth).toBe(2);
    expect(first.entries.map((entry) => entry.rank)).toEqual([2]);

    const second = pollResultOf(twoOptions, rows, 2);
    expect(second.entries.map((entry) => entry.rank)).toEqual([2, 1]);
    expect(second.complete).toBe(true);
  });
});

describe('司会が確かめる表', () => {
  it('全順位ぶん、点数の高い順に並ぶ', () => {
    const rows = pollTallyRowsOf(snapshot, ranked().ranked);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.label)).toEqual(['営業部 ダンス', '開発部 コント', '大阪 漫才']);
    expect(rows.map((row) => row.totalVotes)).toEqual([3, 2, 1]);
  });
});
