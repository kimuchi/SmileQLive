import { describe, expect, it } from 'vitest';
import {
  describeRosterImport,
  detectDelimiter,
  parseDelimitedText,
  parseRosterText,
} from '@/domain/draw/roster-import';
import { DRAW_LABEL_MAX_LENGTH } from '@/domain/draw/draw-list';

/**
 * 名簿の取り込み。
 *
 * GAS 版はスプレッドシートの「参加者」列をそのまま読んでいた。
 * 移行する人は、その同じシートから範囲をコピーして貼り付ける。
 * つまり **タブ区切り・見出し行つき・「当選」列が混ざっている** 文字列が来る。
 * ここが取りこぼすと「登録したのに抽選に出てこない」事故になるので、
 * 実際に来る形をそのまま並べて確かめる。
 */

describe('区切り文字の判別', () => {
  it('表計算からの貼り付け（タブがある）はタブ区切り', () => {
    expect(detectDelimiter('参加者\t当選\n山田\t')).toBe('tab');
  });

  it('タブが無ければカンマ区切り', () => {
    expect(detectDelimiter('山田,1\n田中,')).toBe('comma');
  });

  it('名前にカンマが入っていても、タブがあればタブを優先する', () => {
    // 「山田, 太郎」のような表記があると、カンマ区切りと誤ると 2 列に割れてしまう。
    expect(detectDelimiter('山田, 太郎\t1')).toBe('tab');
  });
});

describe('表形式の解釈', () => {
  it('引用符の中の区切り文字は文字として扱う', () => {
    expect(parseDelimitedText('"山田, 太郎",1', 'comma')).toEqual([['山田, 太郎', '1']]);
  });

  it('引用符の中の改行は行を分けない', () => {
    expect(parseDelimitedText('"1行目\n2行目",x', 'comma')).toEqual([['1行目\n2行目', 'x']]);
  });

  it('引用符の中の "" は 1 つの " になる', () => {
    expect(parseDelimitedText('"あだ名は""たろう""",1', 'comma')).toEqual([
      ['あだ名は"たろう"', '1'],
    ]);
  });

  it('CRLF・CR・LF のどれでも行が分かれる', () => {
    expect(parseDelimitedText('a\r\nb\rc\nd', 'comma')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('最後の行に改行が無くても取りこぼさない', () => {
    expect(parseDelimitedText('a\nb', 'comma')).toEqual([['a'], ['b']]);
  });

  it('先頭の BOM を落とす', () => {
    // Excel が書き出した CSV には BOM が付く。残すと 1 件目の名前が壊れる。
    expect(parseDelimitedText('﻿山田,1', 'comma')).toEqual([['山田', '1']]);
  });
});

describe('名簿の取り込み', () => {
  it('GAS 版のシートを貼り付けた形をそのまま読める', () => {
    // 「参加者」「当選」の 2 列。当選済みの行も候補として取り込む
    // （当選のリセットはこちらのルームで管理するため）。
    const pasted = ['参加者\t当選', '山田太郎\t1', '田中花子\t', '佐藤次郎\t'].join('\n');

    const result = parseRosterText(pasted);

    expect(result.delimiter).toBe('tab');
    expect(result.headers).toEqual(['参加者', '当選']);
    expect(result.labelColumnIndex).toBe(0);
    expect(result.rows.map((row) => row.label)).toEqual(['山田太郎', '田中花子', '佐藤次郎']);
  });

  it('見出しが無ければ 1 行目も名前として読む', () => {
    const result = parseRosterText('山田太郎\n田中花子');

    expect(result.headers).toBeNull();
    expect(result.rows.map((row) => row.label)).toEqual(['山田太郎', '田中花子']);
  });

  it('「当選」だけの見出しでも、名前の列を取り違えない', () => {
    // 見出しはあるが名前らしい語が無い場合。「当選」を名前として読んではいけない。
    const result = parseRosterText('当選\tメンバー\n1\t山田太郎\n\t田中花子');

    expect(result.headers).toEqual(['当選', 'メンバー']);
    expect(result.labelColumnIndex).toBe(1);
    expect(result.rows.map((row) => row.label)).toEqual(['山田太郎', '田中花子']);
  });

  it('列を指定して読める', () => {
    const result = parseRosterText('部署\t氏名\n営業\t山田太郎', { labelColumnIndex: 0 });

    expect(result.rows.map((row) => row.label)).toEqual(['営業']);
  });

  it('指定した列が空の行は、その行の他の中身を拾う', () => {
    // 列を取り違えたときに「全部空」になって戸惑わせない。
    const result = parseRosterText('氏名\t備考\n\t山田太郎', { labelColumnIndex: 0 });

    expect(result.rows.map((row) => row.label)).toEqual(['山田太郎']);
  });

  it('空行は飛ばして数える', () => {
    const result = parseRosterText('山田\n\n\n田中\n   \n');

    expect(result.rows.map((row) => row.label)).toEqual(['山田', '田中']);
    expect(result.skippedEmpty).toBeGreaterThan(0);
  });

  it('前後の空白は落とし、名前の中の空白は残す', () => {
    const result = parseRosterText('  山田　太郎  \n　田中 花子　');

    expect(result.rows.map((row) => row.label)).toEqual(['山田　太郎', '田中 花子']);
  });

  it('同じ名前は落とさずに数える', () => {
    // 同姓同名は実際にある。勝手に消すと「登録したのに居ない」事故になる。
    const result = parseRosterText('山田\n山田\n田中');

    expect(result.rows.map((row) => row.label)).toEqual(['山田', '山田', '田中']);
    expect(result.duplicates).toBe(1);
  });

  it('長すぎる名前は切り詰めて数える', () => {
    const long = 'あ'.repeat(DRAW_LABEL_MAX_LENGTH + 10);
    const result = parseRosterText(long);

    expect(result.rows[0]?.label).toHaveLength(DRAW_LABEL_MAX_LENGTH);
    expect(result.shortened).toBe(1);
  });

  it('上限を超えた行は取り込まず、件数を返す', () => {
    const text = Array.from({ length: 10 }, (_, index) => `参加者${index}`).join('\n');
    const result = parseRosterText(text, { maxRows: 4 });

    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBe(6);
  });

  it('空の入力でも壊れない', () => {
    const result = parseRosterText('');

    expect(result.rows).toEqual([]);
    expect(result.headers).toBeNull();
  });

  it('見出し行だけなら 0 件になる', () => {
    const result = parseRosterText('参加者\t当選');

    expect(result.rows).toEqual([]);
    expect(result.headers).toEqual(['参加者', '当選']);
  });

  it('見出しとして扱うかを指定できる', () => {
    // 「名前」という名前の人が 1 行目に居ることもありうる。
    const result = parseRosterText('名前\n山田', { hasHeader: false });

    expect(result.rows.map((row) => row.label)).toEqual(['名前', '山田']);
  });
});

describe('取り込み結果の説明', () => {
  it('何が起きたかを日本語で 1 行にまとめる', () => {
    const result = parseRosterText('参加者\t当選\n山田\t\n山田\t\n\t');
    const message = describeRosterImport(result);

    expect(message).toContain('2 件');
    expect(message).toContain('参加者');
    expect(message).toContain('同じ名前');
  });
});
