/**
 * ルーレットの項目を貼り付け・CSV から入れる。
 *
 * 候補の一覧はたいてい表計算ソフトにある。範囲をコピーして貼るか、
 * 書き出した CSV を読み込むだけで盤面を作れるようにする。
 *
 * 列の見方: 1 列目が項目名、2 列目が重み（省略時 1）。
 * 表を読む部分（区切りの判定・引用符の解釈）は `domain/text/delimited.ts` が持つ。
 *
 * **黙って一部を落とさない。** 何を飛ばし、何を切り詰めたかを数えて返す。
 * 落としたことに当日まで気づけないのがいちばん困る。
 *
 * ここはドメイン層。ファイル入出力も DOM も触らない。
 */

import { detectDelimiter, parseDelimitedText, type Delimiter } from '@/domain/text/delimited';
import {
  clampWeight,
  normalizeLabel,
  ROULETTE_ITEM_MAX_COUNT,
  trimLabel,
  type RouletteItem,
} from '@/domain/roulette/wheel';

export type RouletteImportResult = {
  items: Array<{ label: string; weight: number }>;
  delimiter: Delimiter;
  /** 見出し行と判断したもの。無ければ null。 */
  headers: string[] | null;
  /** 名前が空だったので飛ばした行数。 */
  skippedEmpty: number;
  /** 上限を超えたので取り込まなかった行数。 */
  truncated: number;
  /** 長すぎたので切り詰めた件数。 */
  shortened: number;
  /** 重みとして読めなかったので 1 にした件数。 */
  weightFallback: number;
  /** 同じ名前が複数あった件数（落とさずに数えるだけ）。 */
  duplicates: number;
};

/**
 * 見出しらしい言葉。
 *
 * **一致は完全一致で見る。** 「含む」で見ると「重み付け」のような
 * ふつうのデータ行まで見出しと誤って捨てる（投票用紙の取り込みで実際にそうなった）。
 */
const LABEL_HINTS = ['項目', '項目名', '選択肢', '名前', '氏名', '候補', '内容', 'name', 'label'];
const WEIGHT_HINTS = ['重み', '重さ', '比率', '割合', '倍率', '確率', 'ratio', 'weight'];

const HEADER_HINTS = [...LABEL_HINTS, ...WEIGHT_HINTS];

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

export type RouletteImportOptions = {
  /** 見出し行として扱うか。省略時は自動判定。 */
  hasHeader?: boolean;
};

/**
 * 貼り付け／CSV の文字列から項目を作る。
 *
 * 同じ名前は落とさずに数えるだけにする
 * （「はずれ」を何枠も置く使い方があるし、勝手に消すと気づけない）。
 */
export function parseRouletteText(
  text: string,
  options: RouletteImportOptions = {},
): RouletteImportResult {
  const delimiter = detectDelimiter(text);
  const rows = parseDelimitedText(text, delimiter).filter((row) =>
    row.some((cell) => trimLabel(cell).length > 0),
  );

  const headerDetected = options.hasHeader ?? (rows.length > 0 && isHeaderRow(rows[0] ?? []));
  const headers = headerDetected ? (rows[0] ?? []).map(trimLabel) : null;
  const body = headerDetected ? rows.slice(1) : rows;

  const labelColumn = (headers ? pickColumn(headers, LABEL_HINTS) : null) ?? 0;
  const weightColumn = (headers ? pickColumn(headers, WEIGHT_HINTS) : null) ?? 1;

  const items: Array<{ label: string; weight: number }> = [];
  const seen = new Set<string>();
  let skippedEmpty = 0;
  let truncated = 0;
  let shortened = 0;
  let weightFallback = 0;
  let duplicates = 0;

  for (const row of body) {
    const rawLabel = trimLabel(row[labelColumn] ?? '');
    if (rawLabel.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    if (items.length >= ROULETTE_ITEM_MAX_COUNT) {
      truncated += 1;
      continue;
    }

    const label = normalizeLabel(rawLabel);
    if (label.length < rawLabel.length) {
      shortened += 1;
    }
    if (seen.has(label)) {
      duplicates += 1;
    }
    seen.add(label);

    const rawWeight = trimLabel(row[weightColumn] ?? '');
    let weight = 1;
    if (rawWeight.length > 0) {
      const parsed = Number(rawWeight.normalize('NFKC'));
      if (Number.isFinite(parsed) && parsed > 0) {
        weight = clampWeight(parsed);
      } else {
        // 「多め」のような言葉が入っていることがある。落とさず 1 として入れ、数える。
        weightFallback += 1;
      }
    }

    items.push({ label, weight });
  }

  return {
    items,
    delimiter,
    headers,
    skippedEmpty,
    truncated,
    shortened,
    weightFallback,
    duplicates,
  };
}

/** 取り込んだ結果を、盤面へ入れられる形にする。 */
export function toRouletteItems(
  result: RouletteImportResult,
  makeId: () => string,
): RouletteItem[] {
  return result.items.map((item) => ({ id: makeId(), label: item.label, weight: item.weight }));
}

/**
 * 取り込みの結果を箇条書きにする。
 *
 * 1 行にまとめない。飛ばした行を文末へ埋めると読み飛ばされ、
 * 黙って落としたのと変わらなくなる。
 */
export function describeRouletteImport(result: RouletteImportResult): string[] {
  const lines: string[] = [];
  if (result.headers !== null) {
    lines.push('1行目は見出しとして飛ばしました');
  }
  if (result.skippedEmpty > 0) {
    lines.push(`項目名が空の行 ${result.skippedEmpty} 件は飛ばしました`);
  }
  if (result.weightFallback > 0) {
    lines.push(`重みとして読めなかった ${result.weightFallback} 件は 1 にしました`);
  }
  if (result.shortened > 0) {
    lines.push(`長すぎた ${result.shortened} 件は切り詰めました`);
  }
  if (result.truncated > 0) {
    lines.push(
      `上限（${ROULETTE_ITEM_MAX_COUNT}件）を超えた ${result.truncated} 件は取り込みません`,
    );
  }
  if (result.duplicates > 0) {
    lines.push(`同じ名前が ${result.duplicates} 件あります（そのまま取り込みます）`);
  }
  return lines;
}
