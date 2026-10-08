/**
 * 投票用紙の取り込み — 貼り付けと CSV。
 *
 * 出し物コンテストの一覧は、たいてい表計算ソフトで作られている。
 * その範囲をコピーして貼るか、書き出した CSV を読み込むだけで
 * 区分と選択肢を入れられるようにする。
 *
 * 表を読む部分（区切りの判定・引用符の解釈）は domain/text/delimited.ts が持つ。
 * ここは読んだ表を「投票用紙」として解釈することだけを受け持つ。
 *
 * 列の見方:
 *   一覧から選ぶ（flat）   … 選択肢 / 補足
 *   2段階で選ぶ（nested）  … 区分 / 選択肢 / 補足
 *
 * **黙って一部を落とさない。** 何を飛ばし、何を切り詰めたかを数えて返す。
 * 落としたことに当日まで気づけないのがいちばん困る。
 *
 * ここはドメイン層。ファイル入出力も DOM も触らない。
 */

import {
  BALLOT_GROUP_MAX_COUNT,
  BALLOT_LABEL_MAX_LENGTH,
  BALLOT_OPTION_MAX_COUNT,
  type BallotStructure,
} from '@/domain/poll/ballot';
import { detectDelimiter, parseDelimitedText, type Delimiter } from '@/domain/text/delimited';

/** 取り込んだ 1 行。ID はまだ振らない（画面が振る）。 */
export type BallotImportOption = {
  label: string;
  note: string | null;
  /** 属する区分の名前。flat では null。 */
  groupLabel: string | null;
};

export type BallotImportResult = {
  /** 出てきた順の区分名。flat では空。 */
  groups: string[];
  options: BallotImportOption[];
  /** 見出し行と判断したもの。無ければ null。 */
  headers: string[] | null;
  /** 何列目をどう読んだか（0 始まり）。使わなかった列は null。 */
  groupColumnIndex: number | null;
  labelColumnIndex: number;
  noteColumnIndex: number | null;
  delimiter: Delimiter;
  /** 選択肢名が空だったので飛ばした行数。 */
  skippedEmpty: number;
  /** 2段階なのに区分が空だったので飛ばした行数。 */
  skippedNoGroup: number;
  /** 上限を超えたので取り込まなかった行数。 */
  truncated: number;
  /** 上限を超えたので取り込まなかった区分の数。 */
  truncatedGroups: number;
  /** 長すぎたので切り詰めた件数。 */
  shortened: number;
  /** 同じ選択肢名が複数あった件数（落とさずに数えるだけ）。 */
  duplicates: number;
};

export type BallotImportOptions = {
  structure: BallotStructure;
  /** 見出し行として扱うか。省略時は自動判定。 */
  hasHeader?: boolean;
  /** 何列目を区分として読むか（0 始まり）。省略時は自動判定。 */
  groupColumnIndex?: number | null;
  /** 何列目を選択肢名として読むか（0 始まり）。省略時は自動判定。 */
  labelColumnIndex?: number;
  /** 何列目を補足として読むか（0 始まり）。省略時は自動判定。 */
  noteColumnIndex?: number | null;
};

/**
 * 見出しらしい言葉。前の方にあるものほど優先して選ぶ。
 *
 * **一致は完全一致で見る。** 「含む」で見ると、
 * 「出演12名」が「出演」に、「項目3」が「項目」に当たってしまい、
 * ふつうのデータ行を見出しと誤って捨てる（実際にそうなった）。
 * そのぶん言い回しの揺れは、この一覧へ並べて吸収する。
 */
const GROUP_HINTS = [
  '区分',
  'グループ',
  '部署',
  '部署名',
  'チーム',
  'チーム名',
  '所属',
  '分類',
  'カテゴリ',
  'カテゴリー',
  '部門',
  'group',
];
const LABEL_HINTS = [
  '選択肢',
  '項目',
  '項目名',
  '出し物',
  '演目',
  '候補',
  '名前',
  '氏名',
  '題名',
  'タイトル',
  'name',
  'title',
];
const NOTE_HINTS = ['補足', 'メモ', '備考', '説明', '発表者', '発表者名', '出演', '注記', 'note'];

/** 見出し行かどうかの判定に使う（どれか 1 つと完全に一致すれば見出し）。 */
const HEADER_HINTS = [...GROUP_HINTS, ...LABEL_HINTS, ...NOTE_HINTS];

function normalizeHeaderCell(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s　]/gu, '')
    .toLowerCase();
}

function matchesHint(cell: string, hint: string): boolean {
  return normalizeHeaderCell(cell) === normalizeHeaderCell(hint);
}

function isHeaderRow(cells: readonly string[]): boolean {
  return cells.some(
    (cell) =>
      normalizeHeaderCell(cell).length > 0 && HEADER_HINTS.some((hint) => matchesHint(cell, hint)),
  );
}

/** 見出しから、その用途に合う列を選ぶ。無ければ null。 */
function pickColumn(headers: readonly string[], hints: readonly string[]): number | null {
  for (const hint of hints) {
    const index = headers.findIndex((cell) => matchesHint(cell, hint));
    if (index >= 0) {
      return index;
    }
  }
  return null;
}

/** 前後の空白を落とす。全角空白も空白として扱う（中の空白は残す）。 */
function trimCell(value: string): string {
  return value.replace(/^[\s　]+/u, '').replace(/[\s　]+$/u, '');
}

function cellAt(row: readonly string[], index: number | null): string {
  if (index === null) {
    return '';
  }
  return trimCell(row[index] ?? '');
}

/**
 * どの列を何として読むかを決める。
 *
 * 見出しがあればそれに従う。無ければ**列の並び順**で決める。
 *   flat   … 1 列目が選択肢、2 列目が補足
 *   nested … 1 列目が区分、2 列目が選択肢、3 列目が補足
 *
 * 1 列しか無い 2段階の表は、区分が無いので取り込めない（呼び出し側が空で返る）。
 */
function resolveColumns(
  structure: BallotStructure,
  headers: string[] | null,
  options: BallotImportOptions,
): { group: number | null; label: number; note: number | null } {
  const nested = structure === 'nested';

  const group =
    options.groupColumnIndex !== undefined
      ? options.groupColumnIndex
      : nested
        ? ((headers ? pickColumn(headers, GROUP_HINTS) : null) ?? 0)
        : null;

  const fallbackLabel = nested ? (group === 0 ? 1 : 0) : 0;
  const label =
    options.labelColumnIndex ??
    (headers ? pickColumn(headers, LABEL_HINTS) : null) ??
    fallbackLabel;

  const note =
    options.noteColumnIndex !== undefined
      ? options.noteColumnIndex
      : ((headers ? pickColumn(headers, NOTE_HINTS) : null) ??
        // 見出しが無いときは「区分・選択肢の次の列」を補足とみなす。
        (nested ? 2 : 1));

  return { group, label, note };
}

/**
 * 貼り付け／CSV の文字列から区分と選択肢を作る。
 *
 * 区分は**出てきた順**に並べ、同じ名前は 1 つにまとめる。
 * 選択肢の重複は落とさずに数えるだけにする
 * （同じ名前の出し物が本当に 2 つあることはあるし、勝手に消すと気づけない）。
 */
export function parseBallotText(text: string, options: BallotImportOptions): BallotImportResult {
  const delimiter = detectDelimiter(text);
  const rows = parseDelimitedText(text, delimiter).filter((row) =>
    row.some((cell) => trimCell(cell).length > 0),
  );

  const headerDetected = options.hasHeader ?? (rows.length > 0 && isHeaderRow(rows[0] ?? []));
  const headers = headerDetected ? (rows[0] ?? []).map(trimCell) : null;
  const body = headerDetected ? rows.slice(1) : rows;

  const columns = resolveColumns(options.structure, headers, options);
  const nested = options.structure === 'nested';

  const groups: string[] = [];
  const groupSeen = new Set<string>();
  const parsed: BallotImportOption[] = [];
  const labelSeen = new Set<string>();

  let skippedEmpty = 0;
  let skippedNoGroup = 0;
  let truncated = 0;
  let truncatedGroups = 0;
  let shortened = 0;
  let duplicates = 0;

  for (const row of body) {
    const rawLabel = cellAt(row, columns.label);
    if (rawLabel.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    const rawGroup = nested ? cellAt(row, columns.group) : '';
    if (nested && rawGroup.length === 0) {
      // 区分に属していない選択肢は参加者が選べない。取り込まずに数える。
      skippedNoGroup += 1;
      continue;
    }

    if (parsed.length >= BALLOT_OPTION_MAX_COUNT) {
      truncated += 1;
      continue;
    }

    const label = rawLabel.slice(0, BALLOT_LABEL_MAX_LENGTH);
    if (label.length < rawLabel.length) {
      shortened += 1;
    }
    if (labelSeen.has(label)) {
      duplicates += 1;
    }
    labelSeen.add(label);

    let groupLabel: string | null = null;
    if (nested) {
      const trimmedGroup = rawGroup.slice(0, BALLOT_LABEL_MAX_LENGTH);
      if (trimmedGroup.length < rawGroup.length) {
        shortened += 1;
      }
      if (!groupSeen.has(trimmedGroup)) {
        if (groups.length >= BALLOT_GROUP_MAX_COUNT) {
          // 区分が上限を超えた。その区分の選択肢は選べないので取り込まない。
          truncatedGroups += 1;
          truncated += 1;
          continue;
        }
        groupSeen.add(trimmedGroup);
        groups.push(trimmedGroup);
      }
      groupLabel = trimmedGroup;
    }

    const rawNote = cellAt(row, columns.note);
    const note = rawNote.length > 0 ? rawNote.slice(0, BALLOT_LABEL_MAX_LENGTH) : null;
    if (note !== null && note.length < rawNote.length) {
      shortened += 1;
    }

    parsed.push({ label, note, groupLabel });
  }

  return {
    groups,
    options: parsed,
    headers,
    groupColumnIndex: nested ? columns.group : null,
    labelColumnIndex: columns.label,
    noteColumnIndex: columns.note,
    delimiter,
    skippedEmpty,
    skippedNoGroup,
    truncated,
    truncatedGroups,
    shortened,
    duplicates,
  };
}

/**
 * 取り込みの結果を 1 行で説明する。
 *
 * 「何件入ったか」だけでなく「何を飛ばしたか」も必ず出す。
 */
export function describeBallotImport(result: BallotImportResult): string {
  const parts = [`${result.options.length}件を読み込みました`];
  if (result.groups.length > 0) {
    parts.push(`区分${result.groups.length}件`);
  }
  if (result.skippedEmpty > 0) {
    parts.push(`空の行 ${result.skippedEmpty}件を飛ばしました`);
  }
  if (result.skippedNoGroup > 0) {
    parts.push(`区分が空の行 ${result.skippedNoGroup}件を飛ばしました`);
  }
  if (result.truncated > 0) {
    parts.push(`上限を超えた ${result.truncated}件を取り込みませんでした`);
  }
  if (result.truncatedGroups > 0) {
    parts.push(`区分の上限を超えた ${result.truncatedGroups}件があります`);
  }
  if (result.shortened > 0) {
    parts.push(`長すぎた ${result.shortened}件を切り詰めました`);
  }
  if (result.duplicates > 0) {
    parts.push(`同じ名前が ${result.duplicates}件あります`);
  }
  return parts.join('／');
}
