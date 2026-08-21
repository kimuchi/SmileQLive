/**
 * 名簿の取り込み — 貼り付けと CSV。
 *
 * GAS 版はスプレッドシートの「参加者」列をそのまま読んでいた。
 * こちらでは、その**スプレッドシートから範囲をコピーして貼り付ける**か、
 * CSV ファイルを読み込むことで同じことをできるようにする。
 *
 * 表計算ソフトからのコピーはタブ区切り、書き出したファイルはカンマ区切りになるため、
 * どちらも同じ関数で受け取る。引用符つきの項目（"山田, 太郎" のような）も、
 * 表計算ソフトが書き出す形（RFC 4180）に沿って解く。
 *
 * ここはドメイン層。ファイル入出力も DOM も触らない。
 */

import { DRAW_ENTRY_MAX_COUNT, DRAW_LABEL_MAX_LENGTH } from '@/domain/draw/draw-list';

/** 区切り文字。貼り付けはタブ、CSV はカンマになる。 */
export type RosterDelimiter = 'tab' | 'comma';

export type RosterImportRow = {
  /** 取り込む文字（画面に出る名前）。 */
  label: string;
  /** その行の全項目。列を選び直せるように残しておく。 */
  columns: string[];
};

export type RosterImportResult = {
  rows: RosterImportRow[];
  /** 見出し行と判断したもの。無ければ null。 */
  headers: string[] | null;
  /** 何列目を名前として読んだか（0 始まり）。 */
  labelColumnIndex: number;
  delimiter: RosterDelimiter;
  /** 空だったので飛ばした行数。 */
  skippedEmpty: number;
  /** 上限を超えたので取り込まなかった行数。 */
  truncated: number;
  /** 長すぎたので切り詰めた件数。 */
  shortened: number;
  /** 同じ名前が複数あった件数（落とさずに数えるだけ）。 */
  duplicates: number;
};

export type RosterImportOptions = {
  /** 見出し行として扱うか。省略時は自動判定。 */
  hasHeader?: boolean;
  /** 何列目を名前として読むか（0 始まり）。省略時は自動判定。 */
  labelColumnIndex?: number;
  /** 取り込む件数の上限。 */
  maxRows?: number;
};

/**
 * 見出しらしい言葉。
 *
 * これが 1 行目に含まれていれば見出し行とみなす。
 * 前の方にあるものほど「名前の列」として優先する。
 */
const HEADER_HINTS = [
  '参加者',
  '氏名',
  '名前',
  'なまえ',
  'お名前',
  '会員名',
  '社員名',
  '品名',
  '景品',
  '賞品',
  'name',
  'label',
] as const;

/** 見出しではあるが、名前の列ではないもの。 */
const NON_LABEL_HEADERS = ['当選', '順位', '番号', 'no', 'no.', 'id', '備考', 'rank'] as const;

function normalizeHeaderCell(value: string): string {
  return value.trim().toLowerCase();
}

function isHeaderRow(cells: readonly string[]): boolean {
  return cells.some((cell) => {
    const normalized = normalizeHeaderCell(cell);
    if (normalized.length === 0) {
      return false;
    }
    return (
      HEADER_HINTS.some((hint) => normalized === hint.toLowerCase()) ||
      NON_LABEL_HEADERS.some((hint) => normalized === hint.toLowerCase())
    );
  });
}

/** 見出しから「名前の列」を選ぶ。見つからなければ null。 */
function pickLabelColumn(headers: readonly string[]): number | null {
  for (const hint of HEADER_HINTS) {
    const index = headers.findIndex((cell) => normalizeHeaderCell(cell) === hint.toLowerCase());
    if (index >= 0) {
      return index;
    }
  }
  // 見出しはあるが名前らしい語が無い場合、「当選」などの列は避けて最初の列を使う。
  const firstUsable = headers.findIndex(
    (cell) =>
      cell.trim().length > 0 &&
      !NON_LABEL_HEADERS.some((hint) => normalizeHeaderCell(cell) === hint.toLowerCase()),
  );
  return firstUsable >= 0 ? firstUsable : null;
}

/**
 * 区切り文字を見分ける。
 *
 * 表計算ソフトからの貼り付けはタブ区切りなので、タブが 1 つでもあればタブとみなす。
 * （名前にタブが入ることは無い。カンマは名前に入りうるので、タブを優先する。）
 */
export function detectDelimiter(text: string): RosterDelimiter {
  return text.includes('\t') ? 'tab' : 'comma';
}

/**
 * 表形式の文字列を行と列へ解く（RFC 4180 に沿う）。
 *
 * - `"` で囲まれた項目の中では、区切り文字も改行もそのままの文字として扱う
 * - 囲みの中の `""` は 1 つの `"` を表す
 * - 改行は CRLF / LF / CR のどれでも受ける
 */
export function parseDelimitedText(text: string, delimiter: RosterDelimiter): string[][] {
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

/** 前後の空白を落とす。全角空白も空白として扱う（名前の中の空白は残す）。 */
function trimCell(value: string): string {
  return value.replace(/^[\s　]+/u, '').replace(/[\s　]+$/u, '');
}

/**
 * 貼り付け／CSV の文字列から名簿を作る。
 *
 * 空行は飛ばす。重複は**落とさずに数えるだけ**にする。
 * 同姓同名は実際にありうるし、勝手に消すと「登録したのに居ない」事故になる。
 */
export function parseRosterText(
  text: string,
  options: RosterImportOptions = {},
): RosterImportResult {
  const maxRows = options.maxRows ?? DRAW_ENTRY_MAX_COUNT;
  const delimiter = detectDelimiter(text);
  const table = parseDelimitedText(text, delimiter);

  const nonEmptyTable = table.filter((cells) => cells.some((cell) => trimCell(cell).length > 0));
  if (nonEmptyTable.length === 0) {
    return {
      rows: [],
      headers: null,
      labelColumnIndex: options.labelColumnIndex ?? 0,
      delimiter,
      skippedEmpty: table.length,
      truncated: 0,
      shortened: 0,
      duplicates: 0,
    };
  }

  const firstRow = nonEmptyTable[0] ?? [];
  const headerDetected = options.hasHeader ?? isHeaderRow(firstRow);
  const headers = headerDetected ? firstRow.map(trimCell) : null;
  const body = headerDetected ? nonEmptyTable.slice(1) : nonEmptyTable;

  const labelColumnIndex =
    options.labelColumnIndex ?? (headers ? (pickLabelColumn(headers) ?? 0) : 0);

  let skippedEmpty = table.length - nonEmptyTable.length;
  let shortened = 0;
  const rows: RosterImportRow[] = [];

  for (const cells of body) {
    const columns = cells.map(trimCell);
    const raw = columns[labelColumnIndex] ?? '';
    // 指定した列が空でも、その行に何か入っていれば最初の中身を拾う
    // （列を取り違えたときに「全部空」になって戸惑わせない）。
    const label = raw.length > 0 ? raw : (columns.find((cell) => cell.length > 0) ?? '');

    if (label.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    let value = label;
    if (value.length > DRAW_LABEL_MAX_LENGTH) {
      value = value.slice(0, DRAW_LABEL_MAX_LENGTH);
      shortened += 1;
    }
    rows.push({ label: value, columns });
  }

  const truncated = Math.max(0, rows.length - maxRows);
  const kept = rows.slice(0, maxRows);

  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of kept) {
    if (seen.has(row.label)) {
      duplicates += 1;
    } else {
      seen.add(row.label);
    }
  }

  return {
    rows: kept,
    headers,
    labelColumnIndex,
    delimiter,
    skippedEmpty,
    truncated,
    shortened,
    duplicates,
  };
}

/** 取り込み結果を、操作者へ 1 行で伝える文言にする。 */
export function describeRosterImport(result: RosterImportResult): string {
  const parts = [`${result.rows.length} 件を読み取りました`];
  if (result.headers) {
    const name = result.headers[result.labelColumnIndex];
    parts.push(name ? `「${name}」の列を使いました` : '見出し行を飛ばしました');
  }
  if (result.skippedEmpty > 0) {
    parts.push(`空の行 ${result.skippedEmpty} 件は飛ばしました`);
  }
  if (result.duplicates > 0) {
    parts.push(`同じ名前が ${result.duplicates} 件あります（そのまま取り込みます）`);
  }
  if (result.shortened > 0) {
    parts.push(`長すぎる ${result.shortened} 件は ${DRAW_LABEL_MAX_LENGTH} 文字で切りました`);
  }
  if (result.truncated > 0) {
    parts.push(`上限を超えた ${result.truncated} 件は取り込めませんでした`);
  }
  return parts.join('。') + '。';
}
