/**
 * 名簿の取り込み — 貼り付けと CSV。
 *
 * GAS 版はスプレッドシートの「参加者」列をそのまま読んでいた。
 * こちらでは、その**スプレッドシートから範囲をコピーして貼り付ける**か、
 * CSV ファイルを読み込むことで同じことをできるようにする。
 *
 * 表を読む部分（区切りの判定・引用符の解釈）は domain/text/delimited.ts が持つ。
 * ここは読んだ表を「名簿」として解釈することだけを受け持つ。
 *
 * ここはドメイン層。ファイル入出力も DOM も触らない。
 */

import { detectDelimiter, parseDelimitedText, type Delimiter } from '@/domain/text/delimited';
import {
  DRAW_ENTRY_MAX_COUNT,
  DRAW_LABEL_MAX_LENGTH,
  DRAW_WEIGHT_MAX,
  DRAW_WEIGHT_MIN,
} from '@/domain/draw/draw-list';

export type RosterImportRow = {
  /** 取り込む文字（画面に出る名前）。 */
  label: string;
  /**
   * ルーレットの扇の広さ。重みの列を指定したときだけ入る。
   * 読み取れなかった行は 1 として扱う（その行だけ落とすと名簿が欠ける）。
   */
  weight?: number;
  /** その行の全項目。列を選び直せるように残しておく。 */
  columns: string[];
};

export type RosterImportResult = {
  rows: RosterImportRow[];
  /** 見出し行と判断したもの。無ければ null。 */
  headers: string[] | null;
  /** 何列目を名前として読んだか（0 始まり）。 */
  labelColumnIndex: number;
  /** 何列目を重みとして読んだか（0 始まり）。読まなかったときは null。 */
  weightColumnIndex: number | null;
  /** 重みとして読めなかった件数（1 として扱った）。 */
  weightFallbacks: number;
  delimiter: Delimiter;
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
  /**
   * 何列目を重みとして読むか（0 始まり）。
   * ルーレット用。省略すると重みを読まない（すべて同じ幅になる）。
   */
  weightColumnIndex?: number | null;
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
  // ルーレットの貼り付けでよく使われる見出し。
  '項目',
  '項目名',
  'name',
  'label',
  'item',
] as const;

/** 見出しに使われがちな「重み」の語。 */
const WEIGHT_HINTS = [
  '重み',
  'ウエイト',
  'ウェイト',
  '重さ',
  '確率',
  '割合',
  '比率',
  'weight',
  'ratio',
  'rate',
];

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
      NON_LABEL_HEADERS.some((hint) => normalized === hint.toLowerCase()) ||
      // 「重み」だけが手がかりのこともある（項目名<TAB>重み の見出し行）。
      WEIGHT_HINTS.some((hint) => normalized === hint.toLowerCase())
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
/**
 * 重みとして読む列を推測する。
 *
 * 見出しに「重み」などがあればその列。
 * 見出しが無くても、2 列だけで 2 列目がすべて数字なら「項目名＋重み」とみなす
 * （ルーレット用に貼り付けるときは、この形がいちばん多い）。
 * 迷ったら読まない。勝手に重みを付けるより、同じ幅で出すほうが驚かせない。
 */
function detectWeightColumn(body: string[][], headers: string[] | null): number | null {
  if (headers) {
    const index = headers.findIndex((header) => {
      const normalized = header.normalize('NFKC').toLowerCase();
      return WEIGHT_HINTS.some((hint) => normalized.includes(hint.toLowerCase()));
    });
    if (index >= 0) {
      return index;
    }
  }

  const rows = body.filter((cells) => cells.length >= 2);
  if (rows.length === 0 || rows.some((cells) => cells.length !== 2)) {
    return null;
  }
  const allNumeric = rows.every((cells) => parseWeight(trimCell(cells[1] ?? '')) !== null);
  return allNumeric ? 1 : null;
}

/**
 * 重みとして読む。
 *
 * 全角数字・小数も受け取り、整数へ丸める（扇の幅なので小数に意味は無い）。
 * 0 以下は「絶対に当たらない扇」になってしまうので受け付けない。
 */
function parseWeight(value: string): number | null {
  const normalized = value.normalize('NFKC').trim().replace(/,/g, '');
  if (normalized.length === 0) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < DRAW_WEIGHT_MIN) {
    return null;
  }
  return Math.min(DRAW_WEIGHT_MAX, Math.round(parsed));
}

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
      weightColumnIndex: options.weightColumnIndex ?? null,
      weightFallbacks: 0,
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

  /*
    重みの列。
    指定が無くても、2 列だけで 2 列目がすべて数字なら「項目名＋重み」とみなす。
    ルーレット用に貼り付けるときは、この形がいちばん多い。
  */
  const weightColumnIndex =
    options.weightColumnIndex === undefined
      ? detectWeightColumn(body, headers)
      : options.weightColumnIndex;

  let skippedEmpty = table.length - nonEmptyTable.length;
  let shortened = 0;
  let weightFallbacks = 0;
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

    if (weightColumnIndex === null) {
      rows.push({ label: value, columns });
      continue;
    }

    const weight = parseWeight(columns[weightColumnIndex] ?? '');
    if (weight === null) {
      // 重みが読めない行を落とすと名簿が欠ける。1（いちばん狭い扇）として通す。
      weightFallbacks += 1;
    }
    rows.push({ label: value, weight: weight ?? DRAW_WEIGHT_MIN, columns });
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
    weightColumnIndex,
    weightFallbacks,
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
  if (result.weightColumnIndex !== null) {
    const name = result.headers?.[result.weightColumnIndex];
    parts.push(name ? `「${name}」の列を重みにしました` : '2列目を重みにしました');
  }
  if (result.weightFallbacks > 0) {
    parts.push(`重みを読めなかった ${result.weightFallbacks} 件は 1 にしました`);
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
