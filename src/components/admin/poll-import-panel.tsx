'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { TextArea } from '@/components/shared/TextArea';
import {
  BALLOT_GROUP_MAX_COUNT,
  BALLOT_OPTION_MAX_COUNT,
  type BallotStructure,
} from '@/domain/poll/ballot';
import { parseBallotText, type BallotImportResult } from '@/domain/poll/ballot-import';
import { formatCount } from '@/lib/format';

/**
 * 区分と選択肢の取り込み — 貼り付けと CSV。
 *
 * 出し物の一覧はたいてい表計算ソフトにある。範囲をコピーして貼るか、
 * 書き出した CSV を読み込むだけで入れられるようにする。
 *
 * **ファイルはサーバーへ送らない。** ブラウザの中で読んで下見を出し、
 * 「取り込む」で編集中の一覧へ入れるだけ。サーバーへ渡るのは、
 * そのあと利用者が「区分と選択肢を保存する」を押したときだけになる。
 * 取り違えたまま保存されるのを防ぐためで、編集画面のほかの操作とも揃う。
 */

/** 下見に出す行数。 */
const PREVIEW_ROWS = 5;

/** 読み込める本文の長さ。 */
const TEXT_MAX_LENGTH = 1_000_000;

/** 文字コードを取り違えたときに現れる文字。Shift_JIS を読み直す合図に使う。 */
const REPLACEMENT_CHARACTER = '�';

type HeaderMode = 'auto' | 'header' | 'body';

const HEADER_OPTIONS: ReadonlyArray<{ value: HeaderMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: '自動で判断する',
    description: '1行目が「区分」「選択肢」などだけなら、見出しとして飛ばします。',
  },
  { value: 'header', label: '1行目は見出しとして飛ばす', description: '1行目を取り込みません。' },
  {
    value: 'body',
    label: '1行目も中身として読む',
    description: '見出しの無い表を貼ったときに使います。',
  },
];

type MergeMode = 'replace' | 'append';

const MERGE_OPTIONS: ReadonlyArray<{ value: MergeMode; label: string; description: string }> = [
  {
    value: 'replace',
    label: 'いまの内容と入れ替える',
    description: '編集中の区分と選択肢を捨てて、読み込んだ内容にします。',
  },
  {
    value: 'append',
    label: 'いまの内容に足す',
    description: '編集中の一覧の後ろへ追加します。',
  },
];

/**
 * 選んだファイルを文字列として読む。
 *
 * サーバーへは送らない。ブラウザの中で読んで貼り付け欄へ入れるだけにし、
 * 取り込む前に必ず下見を通す。
 */
function readTextFile(file: File, encoding: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error('FILE_READ_FAILED'));
    };
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsText(file, encoding);
  });
}

/**
 * 取り込みの結果を箇条書きにする。
 *
 * 1 行にまとめない。飛ばした行を文末へ埋めると読み飛ばされ、
 * 黙って落としたのと変わらなくなる。
 */
export function describeBallotImportLines(
  result: BallotImportResult,
  structure: BallotStructure,
): string[] {
  const lines: string[] = [];
  const columnName = (index: number | null): string => {
    if (index === null) {
      return '';
    }
    const header = result.headers?.[index];
    return header !== undefined && header.length > 0
      ? `${index + 1}列目「${header}」`
      : `${index + 1}列目`;
  };

  if (structure === 'nested') {
    lines.push(`${columnName(result.groupColumnIndex)}を区分として読みました`);
  }
  lines.push(`${columnName(result.labelColumnIndex)}を選択肢として読みました`);

  if (result.skippedEmpty > 0) {
    lines.push(`選択肢が空の行 ${result.skippedEmpty} 件は飛ばしました`);
  }
  if (result.skippedNoGroup > 0) {
    lines.push(
      `区分が空の行 ${result.skippedNoGroup} 件は飛ばしました（区分に属さない選択肢は選べません）`,
    );
  }
  if (result.truncated > 0) {
    lines.push(
      `上限（${formatCount(BALLOT_OPTION_MAX_COUNT, '件')}）を超えた ${result.truncated} 件は取り込みません`,
    );
  }
  if (result.truncatedGroups > 0) {
    lines.push(
      `区分の上限（${formatCount(BALLOT_GROUP_MAX_COUNT, '件')}）を超えた ${result.truncatedGroups} 件があります`,
    );
  }
  if (result.shortened > 0) {
    lines.push(`長すぎた ${result.shortened} 件は切り詰めました`);
  }
  if (result.duplicates > 0) {
    lines.push(`同じ名前が ${result.duplicates} 件あります（そのまま取り込みます）`);
  }
  return lines;
}

export type PollImportPanelProps = {
  structure: BallotStructure;
  /** いま編集中の件数。入れ替えると何件消えるかを見せるために使う。 */
  currentOptionCount: number;
  /** 読み込んだ内容を編集中の一覧へ入れる。 */
  onImport: (result: BallotImportResult, mode: MergeMode) => void;
};

export function PollImportPanel({ structure, currentOptionCount, onImport }: PollImportPanelProps) {
  const [text, setText] = useState('');
  const [headerMode, setHeaderMode] = useState<HeaderMode>('auto');
  const [mergeMode, setMergeMode] = useState<MergeMode>('replace');
  const [readingFile, setReadingFile] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const nested = structure === 'nested';

  /** 下見。打つたびに解き直す（サーバーへは行かないので手元だけで完結する）。 */
  const preview = useMemo<BallotImportResult | null>(() => {
    if (text.trim().length === 0) {
      return null;
    }
    return parseBallotText(text, {
      structure,
      ...(headerMode === 'auto' ? {} : { hasHeader: headerMode === 'header' }),
    });
  }, [headerMode, structure, text]);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // 同じファイルを選び直せるよう、値は毎回空にする。
    event.currentTarget.value = '';
    if (!file) {
      return;
    }

    setFileError(null);
    setFileNotice(null);
    setReadingFile(true);
    try {
      const utf8 = await readTextFile(file, 'utf-8');
      // 表計算ソフトが書き出した CSV は Shift_JIS のことがある。
      // UTF-8 として読むと U+FFFD へ化けるので、化けていたら読み直す。
      if (utf8.includes(REPLACEMENT_CHARACTER)) {
        const sjis = await readTextFile(file, 'shift_jis');
        if (!sjis.includes(REPLACEMENT_CHARACTER)) {
          setText(sjis.slice(0, TEXT_MAX_LENGTH));
          setFileNotice(`${file.name} を Shift_JIS として読み込みました。`);
          return;
        }
      }
      setText(utf8.slice(0, TEXT_MAX_LENGTH));
      setFileNotice(`${file.name} を読み込みました。`);
    } catch {
      setFileError(
        'ファイルを読み取れませんでした。CSV・TSV・テキストのファイルを選んでください。',
      );
    } finally {
      setReadingFile(false);
    }
  }, []);

  const handleImport = useCallback(() => {
    if (!preview || preview.options.length === 0) {
      return;
    }
    onImport(preview, mergeMode);
    setText('');
    setFileNotice(null);
  }, [mergeMode, onImport, preview]);

  const placeholder = nested
    ? '区分,選択肢,補足\n本社,営業部 ダンス,出演12名\n本社,開発部 コント,\n大阪支店,大阪営業所 漫才,'
    : '選択肢,補足\n営業部 ダンス,出演12名\n開発部 コント,\n総務部 合唱,';

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">
        表計算ソフトから範囲をコピーして貼り付けるか、CSVファイルを読み込めます。
        {nested
          ? '左から「区分」「選択肢」「補足」の順に読みます。'
          : '左から「選択肢」「補足」の順に読みます。'}
        <br />
        読み込んだ内容は編集中の一覧に入るだけです。
        <strong className="font-bold">「区分と選択肢を保存する」を押すまで反映されません。</strong>
      </p>

      <TextArea
        label="貼り付け"
        rows={8}
        value={text}
        maxLength={TEXT_MAX_LENGTH}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setFileNotice(null);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          className="sr-only"
          onChange={(event) => void handleFileChange(event)}
        />
        <Button
          variant="secondary"
          size="sm"
          loading={readingFile}
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          CSVファイルから読み込む
        </Button>
        {text.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText('');
              setFileNotice(null);
            }}
          >
            消す
          </Button>
        ) : null}
      </div>

      {fileNotice !== null ? <Alert variant="info">{fileNotice}</Alert> : null}
      {fileError !== null ? <Alert variant="error">{fileError}</Alert> : null}

      <RadioGroup<HeaderMode>
        name="poll-import-header"
        legend="1行目の扱い"
        options={HEADER_OPTIONS}
        value={headerMode}
        onChange={setHeaderMode}
      />

      <RadioGroup<MergeMode>
        name="poll-import-merge"
        legend="取り込み方"
        options={MERGE_OPTIONS}
        value={mergeMode}
        onChange={setMergeMode}
      />

      {preview !== null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-bold text-slate-900">
            {formatCount(preview.options.length, '件')}を読み込みます
            {nested ? `（区分 ${formatCount(preview.groups.length, '件')}）` : ''}
          </p>

          <ul className="flex flex-col gap-0.5 text-xs text-slate-700">
            {describeBallotImportLines(preview, structure).map((line) => (
              <li key={line}>・{line}</li>
            ))}
          </ul>

          {preview.options.length > 0 ? (
            <ol className="mt-1 flex flex-col gap-0.5 text-sm text-slate-800">
              {preview.options.slice(0, PREVIEW_ROWS).map((option, index) => (
                <li key={`${option.groupLabel ?? ''}-${option.label}-${String(index)}`}>
                  {option.groupLabel !== null ? (
                    <span className="mr-2 text-xs text-slate-600">{option.groupLabel}</span>
                  ) : null}
                  <span className="font-bold">{option.label}</span>
                  {option.note !== null ? (
                    <span className="ml-2 text-xs text-slate-600">{option.note}</span>
                  ) : null}
                </li>
              ))}
              {preview.options.length > PREVIEW_ROWS ? (
                <li className="text-xs text-slate-600">
                  ほか {preview.options.length - PREVIEW_ROWS} 件
                </li>
              ) : null}
            </ol>
          ) : (
            <p className="text-sm font-bold text-amber-700">
              読み込める行がありません。列の順番と1行目の扱いをご確認ください。
            </p>
          )}

          {mergeMode === 'replace' && currentOptionCount > 0 ? (
            <p className="text-xs font-bold text-amber-700">
              いま編集中の{formatCount(currentOptionCount, '件')}は消えます。
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <Button disabled={preview === null || preview.options.length === 0} onClick={handleImport}>
          この内容で取り込む
        </Button>
      </div>
    </div>
  );
}
