/**
 * 区切りつき文字列（貼り付け・CSV）を行と列へ解く。
 *
 * 表計算ソフトからのコピーはタブ区切り、書き出したファイルはカンマ区切りになる。
 * どちらも同じ関数で受け取り、引用符つきの項目も RFC 4180 に沿って解く。
 *
 * 名簿の取り込みと投票用紙の取り込みで同じものを使う。
 * ここは「表を読む」ことだけを知っていて、何の表かは知らない。
 *
 * ここはドメイン層。ファイル入出力も DOM も触らない。
 */

/** 区切り文字。貼り付けはタブ、CSV はカンマになる。 */
export type Delimiter = 'tab' | 'comma';

/**
 * 区切り文字を見分ける。
 *
 * 表計算ソフトからの貼り付けはタブ区切りなので、タブが 1 つでもあればタブとみなす。
 * （名前にタブが入ることは無い。カンマは名前に入りうるので、タブを優先する。）
 */
export function detectDelimiter(text: string): Delimiter {
  return text.includes('\t') ? 'tab' : 'comma';
}

/**
 * 表形式の文字列を行と列へ解く（RFC 4180 に沿う）。
 *
 * - `"` で囲まれた項目の中では、区切り文字も改行もそのままの文字として扱う
 * - 囲みの中の `""` は 1 つの `"` を表す
 * - 改行は CRLF / LF / CR のどれでも受ける
 */
export function parseDelimitedText(text: string, delimiter: Delimiter): string[][] {
  const separator = delimiter === 'tab' ? '\t' : ',';
  // 先頭の BOM は表計算ソフトの書き出しに付くことがある。項目名を壊すので落とす。
  const source = text.replace(/^﻿/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index] ?? '';

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === separator) {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      endRow();
      // CRLF はまとめて 1 つの改行として扱う。
      index += source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // 最後の行に改行が無くても取りこぼさない。
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}
