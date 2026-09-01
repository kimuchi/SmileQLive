'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { TextArea } from '@/components/shared/TextArea';
import {
  describeRouletteImport,
  parseRouletteText,
  type RouletteImportResult,
} from '@/domain/roulette/roulette-import';
import { formatCount } from '@/lib/format';

/**
 * ルーレットの項目を貼り付け・CSV で入れる欄。
 *
 * 候補の一覧はたいてい表計算ソフトにある。範囲をコピーして貼るか、
 * 書き出した CSV を読み込むだけで盤面を作れるようにする。
 *
 * **ファイルはサーバーへ送らない。** ブラウザの中で読んで下見を出し、
 * 「取り込む」で盤面へ入れるだけ。そもそもこの画面はサーバーへ何も保存しない。
 */

/** 下見に出す行数。 */
const PREVIEW_ROWS = 5;

/** 読み込める本文の長さ。 */
const TEXT_MAX_LENGTH = 200_000;

/** 文字コードを取り違えたときに現れる文字。Shift_JIS を読み直す合図に使う。 */
const REPLACEMENT_CHARACTER = '�';

type MergeMode = 'replace' | 'append';

const MERGE_OPTIONS: ReadonlyArray<{ value: MergeMode; label: string; description: string }> = [
  {
    value: 'replace',
    label: 'いまの内容と入れ替える',
    description: 'いまの項目を捨てて、読み込んだ内容にします。',
  },
  { value: 'append', label: 'いまの内容に足す', description: 'いまの一覧の後ろへ追加します。' },
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

export function RouletteImportPanel({
  currentItemCount,
  onImport,
}: {
  /** いまの項目数。入れ替えると何件消えるかを見せるために使う。 */
  currentItemCount: number;
  onImport: (result: RouletteImportResult, mode: MergeMode) => void;
}) {
  const [text, setText] = useState('');
  const [mergeMode, setMergeMode] = useState<MergeMode>('replace');
  const [readingFile, setReadingFile] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** 下見。打つたびに解き直す（サーバーへは行かないので手元だけで完結する）。 */
  const preview = useMemo<RouletteImportResult | null>(() => {
    if (text.trim().length === 0) {
      return null;
    }
    return parseRouletteText(text);
  }, [text]);

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
    if (!preview || preview.items.length === 0) {
      return;
    }
    onImport(preview, mergeMode);
    setText('');
    setFileNotice(null);
  }, [mergeMode, onImport, preview]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-slate-600">
        表計算ソフトから範囲をコピーして貼り付けるか、CSVファイルを読み込めます。
        左から「項目名」「重み」の順に読みます（重みを書かなければ 1）。
      </p>

      <TextArea
        label="貼り付け"
        rows={6}
        value={text}
        maxLength={TEXT_MAX_LENGTH}
        placeholder={'項目,重み\n山田,1\n田中,3\n佐藤,1'}
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

      <RadioGroup<MergeMode>
        name="roulette-import-merge"
        legend="取り込み方"
        options={MERGE_OPTIONS}
        value={mergeMode}
        onChange={setMergeMode}
      />

      {preview !== null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-bold text-slate-900">
            {formatCount(preview.items.length, '件')}を読み込みます
          </p>

          <ul className="flex flex-col gap-0.5 text-xs text-slate-700">
            {describeRouletteImport(preview).map((line) => (
              <li key={line}>・{line}</li>
            ))}
          </ul>

          {preview.items.length > 0 ? (
            <ol className="mt-1 flex flex-col gap-0.5 text-sm text-slate-800">
              {preview.items.slice(0, PREVIEW_ROWS).map((item, index) => (
                <li key={`${item.label}-${String(index)}`}>
                  <span className="font-bold">{item.label}</span>
                  <span className="ml-2 text-xs text-slate-600">重み {item.weight}</span>
                </li>
              ))}
              {preview.items.length > PREVIEW_ROWS ? (
                <li className="text-xs text-slate-600">
                  ほか {preview.items.length - PREVIEW_ROWS} 件
                </li>
              ) : null}
            </ol>
          ) : (
            <p className="text-sm font-bold text-amber-700">
              読み込める行がありません。列の順番をご確認ください。
            </p>
          )}

          {mergeMode === 'replace' && currentItemCount > 0 ? (
            <p className="text-xs font-bold text-amber-700">
              いまの{formatCount(currentItemCount, '件')}は消えます。
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <Button
          size="sm"
          disabled={preview === null || preview.items.length === 0}
          onClick={handleImport}
        >
          この内容で取り込む
        </Button>
      </div>
    </div>
  );
}
