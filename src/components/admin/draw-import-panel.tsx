'use client';

import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { Select } from '@/components/shared/Select';
import { Spinner } from '@/components/shared/Spinner';
import { TextArea } from '@/components/shared/TextArea';
import { DRAW_ENTRY_MAX_COUNT, DRAW_LABEL_MAX_LENGTH } from '@/domain/draw/draw-list';
import { parseRosterText } from '@/domain/draw/roster-import';
import { apiPost } from '@/lib/client/api-client';
import { formatCount } from '@/lib/format';
import type {
  DrawImportSummary,
  DrawListDetailResponse,
  DrawListImportResponse,
} from '@/types/api';

/**
 * 貼り付け／CSV での取り込み。
 *
 * 主な使い方は「スプレッドシートの範囲をコピーして、そのまま貼る」。
 * GAS 版の「参加者」「当選」の 2 列をそのまま貼れることが移行の要なので、
 * 列の選び直しと見出し行の扱いを画面から変えられるようにしている。
 *
 * 取り込む前に **その場で同じ解釈を行って下見を出す**。
 * 送ってから「何件入ったか」を知らせるのでは、間違いに気づくのが遅い。
 * 解釈そのものはドメイン層 (roster-import.ts) を呼ぶだけにして、
 * 画面とサーバーで読み方がずれないようにする。
 *
 * CSV ファイルはブラウザの中だけで読む。サーバーへは送らない。
 */

/** 取り込んだあとの中身。応答の型をそのまま使い、同じ形を二度書かない。 */
type DrawListDetail = DrawListDetailResponse['list'];

/** 見出し行の扱い。auto は roster-import の自動判定に任せる。 */
type HeaderMode = 'auto' | 'header' | 'body';

/** 今ある行をどうするか。 */
type WriteMode = 'replace' | 'append';

/** 何列目まで選べるようにするか調べるとき、先頭から見る行数。 */
const COLUMN_SCAN_ROWS = 50;

/** 下見の表に出す行数。全部出すと 2000 行の表になる。 */
const PREVIEW_ROWS = 5;

/** 送れる本文の長さ（サーバー側の上限と同じ）。 */
const TEXT_MAX_LENGTH = 1_000_000;

/** 文字コードを取り違えたときに現れる文字。Shift_JIS を読み直す合図に使う。 */
const REPLACEMENT_CHARACTER = '\uFFFD';

const HEADER_OPTIONS: ReadonlyArray<{ value: HeaderMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: '自動で判断する',
    description: '1行目に「参加者」「氏名」などがあれば見出しとして飛ばします。',
  },
  {
    value: 'header',
    label: '1行目は見出しとして飛ばす',
    description: '1行目を取り込みません。',
  },
  {
    value: 'body',
    label: '1行目も中身として読む',
    description: '見出しの無い表を貼ったときに使います。',
  },
];

/**
 * 選んだファイルを文字列として読む。
 *
 * ファイルはサーバーへ送らない。ブラウザの中で読んで貼り付け欄へ入れるだけにし、
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
 * 取り込みの結果を、操作者へ伝える文にする。
 *
 * 1 行にまとめず箇条書きで返す。飛ばした行・切り詰めた行を
 * 文末に埋めてしまうと読み飛ばされ、黙って落としたのと変わらなくなる。
 */
export function describeImportSummary(summary: DrawImportSummary): string[] {
  const lines: string[] = [];
  const header = summary.headers?.[summary.labelColumnIndex];

  lines.push(
    header !== undefined && header.length > 0
      ? `${summary.labelColumnIndex + 1}列目「${header}」を名前として読みました`
      : `${summary.labelColumnIndex + 1}列目を名前として読みました`,
  );
  if (summary.skippedEmpty > 0) {
    lines.push(`空の行 ${summary.skippedEmpty} 件は飛ばしました`);
  }
  if (summary.duplicates > 0) {
    lines.push(`同じ文字が ${summary.duplicates} 件あります（そのまま取り込みました）`);
  }
  if (summary.shortened > 0) {
    lines.push(`長すぎる ${summary.shortened} 件は ${DRAW_LABEL_MAX_LENGTH} 文字で切りました`);
  }
  if (summary.truncated > 0) {
    lines.push(`上限を超えた ${summary.truncated} 件は取り込んでいません`);
  }
  return lines;
}

export type DrawImportPanelProps = {
  listId: string;
  /**
   * 重みの列も読むか（重み付きのリストだけ true）。
   *
   * 名簿・品目では重みを持たせないので、列を選ばせても意味が無い。
   * 選べてしまうと「重みを付けたつもりで付いていない」を生む。
   */
  withWeight: boolean;
  /** 今このリストに入っている件数。「今の行に足す」で上限を超えないか判断するのに使う。 */
  currentCount: number;
  /** 取り込ませたくない理由（未保存の編集があるなど）。あるときは取り込めない。 */
  blockedReason?: string;
  /** 取り込んだあとの中身。呼び出し側の表示を更新するために渡す。 */
  onImported: (list: DrawListDetail) => void;
};

export function DrawImportPanel({
  listId,
  withWeight,
  currentCount,
  blockedReason,
  onImported,
}: DrawImportPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [headerMode, setHeaderMode] = useState<HeaderMode>('auto');
  const [labelColumn, setLabelColumn] = useState('auto');
  /** 重みの列。'auto' は自動判定、'none' は読まない（全部同じ幅にする）。 */
  const [weightColumn, setWeightColumn] = useState('auto');
  const [writeMode, setWriteMode] = useState<WriteMode>('replace');
  const [readingFile, setReadingFile] = useState(false);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<unknown>(null);
  const [summary, setSummary] = useState<DrawImportSummary | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);

  /** 足す場合、上限まであと何件入るか。下見の件数をここで頭打ちにする。 */
  const maxRows =
    writeMode === 'append'
      ? Math.max(0, DRAW_ENTRY_MAX_COUNT - currentCount)
      : DRAW_ENTRY_MAX_COUNT;

  /**
   * 重みの列の指定。
   *
   * 未指定 (undefined) だと roster-import が自動で見つける。
   * 重みを持たないリストでは必ず null を渡し、勝手に重みを付けない。
   */
  const weightColumnIndex = useMemo((): number | null | undefined => {
    if (!withWeight || weightColumn === 'none') {
      return null;
    }
    return weightColumn === 'auto' ? undefined : Number.parseInt(weightColumn, 10);
  }, [weightColumn, withWeight]);

  // 取り込みと同じ関数で解釈する。画面とサーバーで読み方をずらさない。
  const preview = useMemo(
    () =>
      parseRosterText(text, {
        ...(headerMode === 'auto' ? {} : { hasHeader: headerMode === 'header' }),
        ...(labelColumn === 'auto' ? {} : { labelColumnIndex: Number.parseInt(labelColumn, 10) }),
        ...(weightColumnIndex === undefined ? {} : { weightColumnIndex }),
        maxRows,
      }),
    [headerMode, labelColumn, maxRows, text, weightColumnIndex],
  );

  const columnOptions = useMemo(() => {
    const headers = preview.headers;
    const columnCount = preview.rows
      .slice(0, COLUMN_SCAN_ROWS)
      .reduce((max, row) => Math.max(max, row.columns.length), headers?.length ?? 0);

    const options = [{ value: 'auto', label: '自動で選ぶ' }];
    for (let index = 0; index < Math.max(1, columnCount); index += 1) {
      const header = headers?.[index];
      options.push({
        value: String(index),
        label:
          header !== undefined && header.length > 0
            ? `${index + 1}列目（${header}）`
            : `${index + 1}列目`,
      });
    }
    return options;
  }, [preview]);

  /** 重みの列の選択肢。「読まない」を先頭近くに置き、いつでも同じ幅へ戻せるようにする。 */
  const weightOptions = useMemo(
    () => [
      { value: 'auto', label: '自動で選ぶ' },
      { value: 'none', label: '重みを読まない（全部同じ幅）' },
      ...columnOptions.filter((option) => option.value !== 'auto'),
    ],
    [columnOptions],
  );

  const weightColumnText = useMemo(() => {
    if (preview.weightColumnIndex === null) {
      return '読みません（全部同じ幅）';
    }
    const header = preview.headers?.[preview.weightColumnIndex];
    return header !== undefined && header.length > 0
      ? `${preview.weightColumnIndex + 1}列目（${header}）`
      : `${preview.weightColumnIndex + 1}列目`;
  }, [preview]);

  const usedHeader = preview.headers?.[preview.labelColumnIndex];
  const labelColumnText =
    usedHeader !== undefined && usedHeader.length > 0
      ? `${preview.labelColumnIndex + 1}列目（${usedHeader}）`
      : `${preview.labelColumnIndex + 1}列目`;

  const previewNotes = useMemo(() => {
    const notes: string[] = [];
    if (preview.skippedEmpty > 0) {
      notes.push(`空の行 ${preview.skippedEmpty} 件は飛ばします`);
    }
    if (preview.duplicates > 0) {
      notes.push(`同じ文字が ${preview.duplicates} 件あります（そのまま取り込みます）`);
    }
    if (preview.shortened > 0) {
      notes.push(`長すぎる ${preview.shortened} 件は ${DRAW_LABEL_MAX_LENGTH} 文字で切ります`);
    }
    if (preview.weightFallbacks > 0) {
      notes.push(`重みを読めなかった ${preview.weightFallbacks} 件は 1 にします`);
    }
    return notes;
  }, [preview]);

  const hasText = text.trim().length > 0;
  const tooLong = text.length > TEXT_MAX_LENGTH;
  /** 上限を超えるぶんが出るなら取り込ませない。半分だけ入った状態を作らないため。 */
  const overflowCount = preview.truncated;

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
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
      // UTF-8 として読むと U+FFFD へ化けるので、化けていたら読み直す（黙って文字化けさせない）。
      if (utf8.includes(REPLACEMENT_CHARACTER)) {
        const sjis = await readTextFile(file, 'shift_jis');
        if (!sjis.includes(REPLACEMENT_CHARACTER)) {
          setText(sjis);
          setFileNotice(`${file.name} を Shift_JIS として読み込みました。`);
          return;
        }
      }
      setText(utf8);
      setFileNotice(`${file.name} を読み込みました。`);
    } catch {
      setFileError(
        'ファイルを読み取れませんでした。CSV・TSV・テキストのファイルを選んでください。',
      );
    } finally {
      setReadingFile(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (importing) {
      return;
    }
    setImportError(null);
    setSummary(null);
    setImporting(true);
    try {
      const response = await apiPost<DrawListImportResponse>(
        `/api/admin/draw-lists/${listId}/import`,
        {
          text,
          ...(headerMode === 'auto' ? {} : { hasHeader: headerMode === 'header' }),
          ...(labelColumn === 'auto' ? {} : { labelColumnIndex: Number.parseInt(labelColumn, 10) }),
          ...(weightColumnIndex === undefined ? {} : { weightColumnIndex }),
          append: writeMode === 'append',
        },
      );
      setSummary(response.imported);
      setResultCount(response.list.entryCount);
      // 同じ内容を二度足してしまわないよう、取り込めた本文は消す。
      setText('');
      setFileNotice(null);
      onImported(response.list);
    } catch (caught) {
      setImportError(caught);
    } finally {
      setImporting(false);
    }
  }, [headerMode, importing, labelColumn, listId, onImported, text, weightColumnIndex, writeMode]);

  const canImport =
    blockedReason === undefined &&
    hasText &&
    !tooLong &&
    preview.rows.length > 0 &&
    overflowCount === 0 &&
    !readingFile;

  return (
    <Card
      title="貼り付け／CSV で取り込む"
      description="表計算ソフトで名簿の範囲を選んでコピーし、下の欄へそのまま貼り付けてください。"
    >
      <div className="flex flex-col gap-4">
        {blockedReason !== undefined ? (
          <Alert variant="warning" title="いまは取り込めません">
            {blockedReason}
          </Alert>
        ) : null}

        {summary !== null ? (
          <Alert
            variant={summary.truncated > 0 ? 'warning' : 'success'}
            title={`${formatCount(summary.count, '件')}を取り込みました`}
          >
            <ul className="list-disc pl-5">
              {describeImportSummary(summary).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {resultCount !== null ? (
                <li>{`このリストは ${formatCount(resultCount, '件')} になりました`}</li>
              ) : null}
            </ul>
          </Alert>
        ) : null}

        {importError !== null ? <ErrorMessage error={importError} /> : null}
        {fileError !== null ? <Alert variant="error">{fileError}</Alert> : null}

        <TextArea
          label="貼り付ける内容"
          rows={8}
          value={text}
          textAreaClassName="font-mono text-sm"
          hint="1行に1件です。「参加者」「当選」のように何列あってもかまいません（使う列は下で選べます）。"
          placeholder={
            withWeight
              ? '項目\t重み\n大当たり\t1\nあたり\t4\nはずれ\t15'
              : '参加者\t当選\n山田 太郎\n鈴木 花子'
          }
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
          {hasText ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                setFileNotice(null);
                setFileError(null);
              }}
            >
              入力を消す
            </Button>
          ) : null}
          {readingFile ? (
            <span className="inline-flex items-center gap-2 text-sm text-slate-600">
              <Spinner size="sm" decorative />
              読み込んでいます
            </span>
          ) : null}
        </div>
        <p className="text-xs text-slate-600">
          ファイルはこのブラウザの中だけで読み、上の欄へ入れます。サーバーへは送りません。
        </p>
        {fileNotice !== null ? <Alert variant="info">{fileNotice}</Alert> : null}

        {tooLong ? (
          <Alert variant="error">
            貼り付けた内容が長すぎます。件数を分けて取り込んでください。
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <RadioGroup<HeaderMode>
            name="draw-import-header"
            legend="1行目の扱い"
            options={HEADER_OPTIONS}
            value={headerMode}
            onChange={(value) => {
              setHeaderMode(value);
            }}
          />
          <div className="flex flex-col gap-4">
            <Select
              label="名前として読む列"
              options={columnOptions}
              value={labelColumn}
              hint="「参加者」の列を選びます。「当選」など別の列を読んでいたら、ここで選び直せます。"
              onChange={(event) => {
                setLabelColumn(event.currentTarget.value);
              }}
            />
            {withWeight ? (
              <Select
                label="重みとして読む列"
                options={weightOptions}
                value={weightColumn}
                hint="重みが大きいほど扇が広くなります。読まないときは全部同じ幅になります。"
                onChange={(event) => {
                  setWeightColumn(event.currentTarget.value);
                }}
              />
            ) : null}
            <RadioGroup<WriteMode>
              name="draw-import-write-mode"
              legend="今ある行をどうするか"
              options={[
                {
                  value: 'replace',
                  label: '入れ替える',
                  description: '今ある行を全部消して、貼り付けた内容だけにします。',
                },
                {
                  value: 'append',
                  label: '今の行に足す',
                  description: `今の ${formatCount(currentCount, '件')} の後ろへ追加します。`,
                },
              ]}
              value={writeMode}
              onChange={(value) => {
                setWriteMode(value);
              }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-bold text-slate-800">取り込む前の下見</h3>
          {hasText ? (
            <>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-slate-600">取り込む行数</dt>
                <dd className="font-bold text-slate-900">
                  {formatCount(preview.rows.length, '件')}
                </dd>
                <dt className="text-slate-600">名前にする列</dt>
                <dd className="font-bold text-slate-900">{labelColumnText}</dd>
                {withWeight ? (
                  <>
                    <dt className="text-slate-600">重みにする列</dt>
                    <dd className="font-bold text-slate-900">{weightColumnText}</dd>
                  </>
                ) : null}
                <dt className="text-slate-600">区切り</dt>
                <dd className="text-slate-900">
                  {preview.delimiter === 'tab'
                    ? 'タブ区切り（表計算ソフトからの貼り付け）'
                    : 'カンマ区切り（CSV）'}
                </dd>
              </dl>

              {previewNotes.length > 0 ? (
                <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
                  {previewNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}

              {preview.rows.length === 0 && overflowCount === 0 ? (
                <p className="mt-2 text-sm font-bold text-red-700">
                  読み取れる行がありません。列の選び方と1行目の扱いを確かめてください。
                </p>
              ) : null}

              {preview.rows.length > 0 ? (
                <ol className="mt-3 flex flex-col gap-1 text-sm">
                  {preview.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                    <li
                      key={`${index}-${row.label}`}
                      className="flex items-baseline gap-2 text-slate-900"
                    >
                      <span className="w-8 shrink-0 text-right text-xs text-slate-500 tabular-nums">
                        {index + 1}
                      </span>
                      <span className="font-bold">{row.label}</span>
                      {withWeight ? (
                        <span className="text-xs text-slate-600 tabular-nums">
                          重み {row.weight ?? 1}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {preview.rows.length > PREVIEW_ROWS ? (
                    <li className="text-xs text-slate-600">
                      ほか {preview.rows.length - PREVIEW_ROWS} 件
                    </li>
                  ) : null}
                </ol>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-600">
              貼り付けると、ここに「何件読めるか」「どの列を名前として読むか」が出ます。
            </p>
          )}
        </div>

        {overflowCount > 0 ? (
          <Alert variant="error" title="このままでは全部は入りません">
            {writeMode === 'append'
              ? `今の ${formatCount(currentCount, '件')} と合わせると上限の${formatCount(DRAW_ENTRY_MAX_COUNT, '件')}を超え、${formatCount(overflowCount, '件')}が入りません。「入れ替える」を選ぶか、貼り付ける件数を減らしてください。`
              : `1つのリストに入れられるのは${formatCount(DRAW_ENTRY_MAX_COUNT, '件')}までです。${formatCount(overflowCount, '件')}が入りません。リストを分けてください。`}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="lg"
            loading={importing}
            disabled={!canImport}
            onClick={() => void handleImport()}
          >
            この内容で取り込む
          </Button>
          {hasText && preview.rows.length > 0 && overflowCount === 0 ? (
            <p className="text-sm text-slate-700">
              {writeMode === 'append'
                ? `取り込むと ${formatCount(currentCount + preview.rows.length, '件')} になります。`
                : `取り込むと ${formatCount(preview.rows.length, '件')} になります。`}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
