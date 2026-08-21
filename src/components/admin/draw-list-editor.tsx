'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/shared/Alert';
import { Badge, type BadgeVariant } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { SaveStatus, type SaveState } from '@/components/shared/SaveStatus';
import { Spinner } from '@/components/shared/Spinner';
import { TextInput } from '@/components/shared/TextInput';
import { DrawImportPanel } from '@/components/admin/draw-import-panel';
import { ImageField } from '@/components/admin/image-field';
import { useAutosave } from '@/components/admin/use-autosave';
import {
  DRAW_ENTRY_MAX_COUNT,
  DRAW_FONT_SIZE_MAX,
  DRAW_FONT_SIZE_MIN,
  DRAW_LABEL_MAX_LENGTH,
  DRAW_LAYOUT_HINTS,
  DRAW_LAYOUT_LABELS,
  DRAW_LAYOUTS,
  DRAW_LIST_KIND_LABELS,
  DRAW_NUMBER_MAX,
  DRAW_NUMBER_MIN,
  SPIN_DURATION_MAX_MS,
  SPIN_DURATION_MIN_MS,
  SPIN_INTERVAL_MAX_MS,
  SPIN_INTERVAL_MIN_MS,
  STOP_DURATION_MAX_MS,
  STOP_DURATION_MIN_MS,
  drawLayoutOf,
  isDrawKindAllowedForMode,
  type DrawLayout,
  type DrawListKind,
} from '@/domain/draw/draw-list';
import { ROOM_MODE_LABELS } from '@/domain/room/room-mode';
import { apiGet, apiPatch, apiPut } from '@/lib/client/api-client';
import { toUserErrorMessage } from '@/lib/client/error-text';
import { formatClockTime, formatCount } from '@/lib/format';
import type { AdminMediaRef, DrawListDetailResponse } from '@/types/api';

/**
 * 抽選リストの中身の編集。
 *
 * 保存の仕方を 2 つに分けている。
 * - 名前・数字の範囲・演出の設定 … 1 つの書き込みで済むので**自動保存**する。
 * - 行の一覧 … 保存は「今の全行を送って丸ごと入れ替える」ため、
 *   打鍵のたびに送ると 1 回で数千件の書き換えになる。**押したときだけ**送る。
 *   代わりに、未保存のまま画面を離れないよう状態を常に見せる。
 *
 * 並べ替え・削除・追加もすべて手元の一覧を組み替えるだけにし、
 * 「保存する」で初めてサーバーへ渡す（途中の状態をサーバーへ残さない）。
 *
 * 画像（品目の写真・投影の背景）はクイズと同じ画像アップロード API へ送る。
 * ただし今の画像 API は**クイズの ID でしか所有者を確かめられない**ため、
 * 抽選リストの ID を渡すと「クイズが見つかりません」で拒まれる。
 * 画像 API が抽選リストの ID を受け付けるようになれば、この画面はそのまま動く。
 */

/** 中身。応答の型をそのまま使い、同じ形を二度書かない。 */
type DrawListDetail = DrawListDetailResponse['list'];

/** 引く対象を選べるモード。リストの種類によって使える方が変わる。 */
const DRAW_MODES = ['lottery', 'bingo'] as const;

const KIND_VARIANT: Record<DrawListKind, BadgeVariant> = {
  name: 'info',
  number: 'brand',
  item: 'success',
  weighted: 'warning',
};

const TITLE_MAX_LENGTH = 100;

/**
 * 一度に描く行数。
 *
 * 2000 行ぶんの入力欄を一度に置くとブラウザが数秒固まる。
 * 名簿の頭を直したいだけの人を待たせないよう、続きは押されたときに出す。
 */
const VISIBLE_ROWS_STEP = 100;

/** 行の識別子。画面の中だけで使い、保存するとサーバー側の id に置き換わる。 */
let entryKeySeed = 0;
function createEntryKey(): string {
  entryKeySeed += 1;
  return `new-${entryKeySeed}`;
}

type EntryDraft = {
  key: string;
  label: string;
  image: AdminMediaRef | null;
  imageAlt: string;
  /** ルーレットの扇の広さ。文字で持つのは、入力中の「1」→「」→「10」を壊さないため。 */
  weight: string;
};

type SettingsDraft = {
  title: string;
  numberMin: string;
  numberMax: string;
  spinIntervalMs: string;
  spinDurationMs: string;
  stopDurationMs: string;
  resultFontSize: string;
  historyFontSize: string;
  layout: DrawLayout;
  backgroundAssetId: string | null;
  openingVideoUrl: string;
};

type SettingsErrors = {
  title?: string;
  range?: string;
  spinIntervalMs?: string;
  spinDurationMs?: string;
  stopDurationMs?: string;
  resultFontSize?: string;
  historyFontSize?: string;
  openingVideoUrl?: string;
};

/** PATCH /api/admin/draw-lists/[listId] の本文。 */
type UpdateDrawListBody = {
  title: string;
  numberMin?: number;
  numberMax?: number;
  settings: {
    spinIntervalMs: number;
    spinDurationMs: number;
    stopDurationMs: number;
    resultFontSize: number;
    historyFontSize: number;
    layout: DrawLayout;
    backgroundAssetId: string | null;
    openingVideoUrl: string | null;
  };
};

/**
 * その扇の当たりやすさ。
 *
 * 重みは相対値なので、数字だけ見ても当たりやすさが分からない。
 * 合計に対する割合を添えて、「10 と入れたら何 % か」をその場で見せる。
 */
function weightShare(value: string, entries: ReadonlyArray<{ weight: string }>): string {
  const weight = parseIntegerInput(value) ?? 1;
  const total = entries.reduce((sum, entry) => sum + (parseIntegerInput(entry.weight) ?? 1), 0);
  if (total <= 0) {
    return '';
  }
  return `${Math.round((weight / total) * 1000) / 10}%`;
}

function toEntryDrafts(list: DrawListDetail): EntryDraft[] {
  return list.entries.map((entry) => ({
    key: entry.id,
    label: entry.label,
    image: entry.image,
    imageAlt: entry.image?.alt ?? '',
    weight: String(entry.weight ?? 1),
  }));
}

function toSettingsDraft(list: DrawListDetail): SettingsDraft {
  return {
    title: list.title,
    numberMin: String(list.numberMin ?? DRAW_NUMBER_MIN),
    numberMax: String(list.numberMax ?? 75),
    spinIntervalMs: String(list.settings.spinIntervalMs),
    spinDurationMs: String(list.settings.spinDurationMs),
    stopDurationMs: String(list.settings.stopDurationMs ?? 4000),
    resultFontSize: String(list.settings.resultFontSize),
    historyFontSize: String(list.settings.historyFontSize),
    layout: drawLayoutOf(list.settings),
    backgroundAssetId: list.settings.backgroundAssetId,
    openingVideoUrl: list.settings.openingVideoUrl ?? '',
  };
}

/** 全角で入力された数字も受け取る（会場の PC は日本語入力のままのことが多い）。 */
function parseIntegerInput(value: string): number | null {
  const normalized = value.normalize('NFKC').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 範囲に収まる整数だけを受け取る。外れていれば、どう直せばよいかを返す。 */
function readBoundedInteger(
  value: string,
  bounds: { min: number; max: number },
): { value: number } | { error: string } {
  const parsed = parseIntegerInput(value);
  if (parsed === null) {
    return { error: '数字で入力してください' };
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    return { error: `${bounds.min}〜${bounds.max}の範囲で入力してください` };
  }
  return { value: parsed };
}

/**
 * オープニング動画の URL。
 *
 * 動画そのものは受け取らない（このアプリは画像しかアップロードを許していない）。
 * すでにどこかに置いてある mp4 などを指してもらう。
 */
function readVideoUrl(value: string): { value: string | null } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { value: null };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { error: 'https:// から始まる URL を入力してください' };
    }
    return { value: trimmed };
  } catch {
    return { error: 'https:// から始まる URL を入力してください' };
  }
}

/** 下書きを保存できる形へ直す。直せないところは errors に理由を入れる。 */
function validateSettings(
  draft: SettingsDraft,
  kind: DrawListKind,
): { errors: SettingsErrors; body: UpdateDrawListBody | null } {
  const errors: SettingsErrors = {};

  const title = draft.title.trim();
  if (title.length === 0) {
    errors.title = '名前を入力してください';
  }

  const spinIntervalMs = readBoundedInteger(draft.spinIntervalMs, {
    min: SPIN_INTERVAL_MIN_MS,
    max: SPIN_INTERVAL_MAX_MS,
  });
  if ('error' in spinIntervalMs) {
    errors.spinIntervalMs = spinIntervalMs.error;
  }

  const spinDurationMs = readBoundedInteger(draft.spinDurationMs, {
    min: SPIN_DURATION_MIN_MS,
    max: SPIN_DURATION_MAX_MS,
  });
  if ('error' in spinDurationMs) {
    errors.spinDurationMs = spinDurationMs.error;
  }

  const stopDurationMs = readBoundedInteger(draft.stopDurationMs, {
    min: STOP_DURATION_MIN_MS,
    max: STOP_DURATION_MAX_MS,
  });
  if ('error' in stopDurationMs) {
    errors.stopDurationMs = stopDurationMs.error;
  }

  const resultFontSize = readBoundedInteger(draft.resultFontSize, {
    min: DRAW_FONT_SIZE_MIN,
    max: DRAW_FONT_SIZE_MAX,
  });
  if ('error' in resultFontSize) {
    errors.resultFontSize = resultFontSize.error;
  }

  const historyFontSize = readBoundedInteger(draft.historyFontSize, {
    min: DRAW_FONT_SIZE_MIN,
    max: DRAW_FONT_SIZE_MAX,
  });
  if ('error' in historyFontSize) {
    errors.historyFontSize = historyFontSize.error;
  }

  const openingVideoUrl = readVideoUrl(draft.openingVideoUrl);
  if ('error' in openingVideoUrl) {
    errors.openingVideoUrl = openingVideoUrl.error;
  }

  // 数字モードだけ範囲を送る。ほかの種類へ範囲を送るとサーバー側で弾かれる。
  let range: { numberMin: number; numberMax: number } | null = null;
  if (kind === 'number') {
    const min = parseIntegerInput(draft.numberMin);
    const max = parseIntegerInput(draft.numberMax);
    if (min === null || max === null) {
      errors.range = '範囲を数字で入力してください';
    } else if (min < DRAW_NUMBER_MIN || max > DRAW_NUMBER_MAX) {
      errors.range = `${DRAW_NUMBER_MIN}〜${DRAW_NUMBER_MAX}の範囲で入力してください`;
    } else if (min > max) {
      errors.range = '小さい方の数字を左に入力してください';
    } else if (max - min + 1 > DRAW_ENTRY_MAX_COUNT) {
      errors.range = `1つのリストに入れられるのは${formatCount(DRAW_ENTRY_MAX_COUNT, '件')}までです`;
    } else {
      range = { numberMin: min, numberMax: max };
    }
  }

  if (
    Object.keys(errors).length > 0 ||
    'error' in spinIntervalMs ||
    'error' in spinDurationMs ||
    'error' in stopDurationMs ||
    'error' in resultFontSize ||
    'error' in historyFontSize ||
    'error' in openingVideoUrl
  ) {
    return { errors, body: null };
  }

  return {
    errors,
    body: {
      title,
      ...(range ?? {}),
      settings: {
        spinIntervalMs: spinIntervalMs.value,
        spinDurationMs: spinDurationMs.value,
        stopDurationMs: stopDurationMs.value,
        resultFontSize: resultFontSize.value,
        historyFontSize: historyFontSize.value,
        layout: draft.layout,
        backgroundAssetId: draft.backgroundAssetId,
        openingVideoUrl: openingVideoUrl.value,
      },
    },
  };
}

export type DrawListEditorProps = {
  listId: string;
};

export function DrawListEditor({ listId }: DrawListEditorProps) {
  const [list, setList] = useState<DrawListDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [entries, setEntries] = useState<EntryDraft[]>([]);
  const [entriesDirty, setEntriesDirty] = useState(false);
  const [entriesStatus, setEntriesStatus] = useState<SaveState>('idle');
  const [entriesSavedAt, setEntriesSavedAt] = useState<string | undefined>(undefined);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [uploadingKeys, setUploadingKeys] = useState<readonly string[]>([]);
  const [visibleRows, setVisibleRows] = useState(VISIBLE_ROWS_STEP);
  /** 背景画像。取得したリストの解決済み URL で初期化する（開き直しても絵が出る）。 */
  const [backgroundImage, setBackgroundImage] = useState<AdminMediaRef | null>(null);
  /** 背景の代替テキスト。画像を選び直したときに一緒に送るため手元へ持つ。 */
  const [backgroundAlt, setBackgroundAlt] = useState('');

  // 同期的な setState を含めない（effect から呼ぶため）。
  const load = useCallback(async () => {
    try {
      const response = await apiGet<DrawListDetailResponse>(`/api/admin/draw-lists/${listId}`);
      setList(response.list);
      // 入力中の下書きは上書きしない（再取得で打った文字を消さない）。
      setSettings((previous) => previous ?? toSettingsDraft(response.list));
      setEntries((previous) => (previous.length > 0 ? previous : toEntryDrafts(response.list)));
      // 選び直した直後の絵は消さない（保存前の状態を上書きしないため）。
      setBackgroundImage((previous) => previous ?? response.list.background);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, [listId]);

  useEffect(() => {
    // マウント時（およびリスト切り替え時）の初回取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- クライアント側での初回取得のため
    void load();
  }, [load]);

  // ---------------------------------------------------------------------
  // 名前・範囲・演出の自動保存
  // ---------------------------------------------------------------------

  const saveSettings = useCallback(async () => {
    if (!settings || !list) {
      return;
    }
    const { body } = validateSettings(settings, list.kind);
    if (body === null) {
      // 直し方は各欄のエラーに出している。直るまで送らない。
      throw new Error('DRAW_LIST_DRAFT_INVALID');
    }
    const response = await apiPatch<DrawListDetailResponse>(
      `/api/admin/draw-lists/${listId}`,
      body,
    );
    setList(response.list);
  }, [list, listId, settings]);

  const {
    schedule: scheduleSettings,
    status: settingsStatus,
    savedAtLabel,
  } = useAutosave(saveSettings);

  const patchSettings = useCallback(
    (patch: Partial<SettingsDraft>) => {
      setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
      scheduleSettings();
    },
    [scheduleSettings],
  );

  // ---------------------------------------------------------------------
  // 行の編集（保存は押したときだけ）
  // ---------------------------------------------------------------------

  const patchEntry = useCallback((key: string, patch: Partial<EntryDraft>) => {
    setEntries((previous) =>
      previous.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
    setEntriesDirty(true);
    setEntriesStatus('idle');
  }, []);

  const moveEntry = useCallback((index: number, direction: -1 | 1) => {
    setEntries((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.length) {
        return previous;
      }
      const next = [...previous];
      const current = next[index];
      const swapped = next[target];
      if (!current || !swapped) {
        return previous;
      }
      next[index] = swapped;
      next[target] = current;
      return next;
    });
    setEntriesDirty(true);
    setEntriesStatus('idle');
  }, []);

  const removeEntry = useCallback((key: string) => {
    setEntries((previous) => previous.filter((entry) => entry.key !== key));
    setEntriesDirty(true);
    setEntriesStatus('idle');
  }, []);

  const addEntry = useCallback(() => {
    setEntries((previous) => [
      ...previous,
      { key: createEntryKey(), label: '', image: null, imageAlt: '', weight: '1' },
    ]);
    setEntriesDirty(true);
    setEntriesStatus('idle');
    // 追加した行が隠れたままにならないよう、末尾まで出す
    // （途中までしか描いていないときに「追加したのに出てこない」と見える）。
    setVisibleRows((previous) => Math.max(previous, entries.length + 1));
  }, [entries.length]);

  const handleUploadingChange = useCallback((key: string, uploading: boolean) => {
    setUploadingKeys((previous) => {
      const has = previous.includes(key);
      if (uploading && !has) {
        return [...previous, key];
      }
      if (!uploading && has) {
        return previous.filter((item) => item !== key);
      }
      return previous;
    });
  }, []);

  const handleSaveEntries = useCallback(async () => {
    const emptyIndex = entries.findIndex((entry) => entry.label.trim().length === 0);
    if (emptyIndex >= 0) {
      // 空の行を黙って落とすと「入れたのに出てこない」事故になる。
      setEntriesError(`${emptyIndex + 1}行目が空です。文字を入れるか、その行を削除してください。`);
      setEntriesStatus('error');
      return;
    }
    if (entries.length > DRAW_ENTRY_MAX_COUNT) {
      setEntriesError(
        `1つのリストに入れられるのは${formatCount(DRAW_ENTRY_MAX_COUNT, '件')}までです。`,
      );
      setEntriesStatus('error');
      return;
    }

    setEntriesError(null);
    setEntriesStatus('saving');
    try {
      const response = await apiPut<DrawListDetailResponse>(
        `/api/admin/draw-lists/${listId}/entries`,
        {
          entries: entries.map((entry) => ({
            label: entry.label.trim(),
            imageAssetId: entry.image?.assetId ?? null,
            imageAlt: entry.imageAlt.trim().length > 0 ? entry.imageAlt.trim() : null,
            // 空欄や読めない値は 1（いちばん狭い扇）。入力中に保存されても壊れない。
            ...(list?.kind === 'weighted' ? { weight: parseIntegerInput(entry.weight) ?? 1 } : {}),
          })),
        },
      );
      setList(response.list);
      setEntries(toEntryDrafts(response.list));
      setEntriesDirty(false);
      setEntriesSavedAt(formatClockTime(new Date(), { withSeconds: false }));
      setEntriesStatus('saved');
    } catch (caught) {
      setEntriesError(toUserErrorMessage(caught));
      setEntriesStatus('error');
    }
  }, [entries, list?.kind, listId]);

  const handleImported = useCallback((imported: DrawListDetail) => {
    setList(imported);
    setEntries(toEntryDrafts(imported));
    setEntriesDirty(false);
    setEntriesStatus('idle');
    setEntriesError(null);
  }, []);

  if (list === null || settings === null) {
    return (
      <Card>
        {loadError !== null ? (
          <ErrorMessage error={loadError} onRetry={() => void load()} />
        ) : (
          <div className="flex items-center gap-3 text-slate-600">
            <Spinner />
            <span>読み込んでいます</span>
          </div>
        )}
      </Card>
    );
  }

  const { errors } = validateSettings(settings, list.kind);
  const isNumberKind = list.kind === 'number';
  const hasImages = list.kind === 'item';
  const hasWeights = list.kind === 'weighted';
  const uploading = uploadingKeys.length > 0;
  const rangeMin = parseIntegerInput(settings.numberMin);
  const rangeMax = parseIntegerInput(settings.numberMax);
  const rangeCount =
    rangeMin !== null && rangeMax !== null && rangeMin <= rangeMax ? rangeMax - rangeMin + 1 : null;
  const usableModes = DRAW_MODES.filter((mode) => isDrawKindAllowedForMode(list.kind, mode));

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-0 z-30 -mx-4 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={KIND_VARIANT[list.kind]} size="md">
              {DRAW_LIST_KIND_LABELS[list.kind]}
            </Badge>
            <span className="text-sm text-slate-600">
              保存済み {formatCount(list.entryCount, '件')}
            </span>
            <SaveStatus status={settingsStatus} savedAtLabel={savedAtLabel} />
          </div>
          {isNumberKind ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <SaveStatus status={entriesStatus} savedAtLabel={entriesSavedAt} />
              <Button
                size="md"
                loading={entriesStatus === 'saving'}
                disabled={!entriesDirty || uploading}
                title={uploading ? '画像のアップロードが終わるまで保存できません' : undefined}
                onClick={() => void handleSaveEntries()}
              >
                行を保存する
              </Button>
            </div>
          )}
        </div>
        {entriesDirty ? (
          <p className="mt-2 text-xs font-bold text-amber-700">
            保存していない編集があります。「行を保存する」を押すまでサーバーへは反映されません。
          </p>
        ) : null}
      </div>

      {loadError !== null ? <ErrorMessage error={loadError} onRetry={() => void load()} /> : null}
      {entriesError !== null ? <Alert variant="error">{entriesError}</Alert> : null}

      <Card title="抽選リストの設定" description="ここでの変更は自動で保存されます。">
        <div className="flex flex-col gap-4">
          <TextInput
            label="抽選リストの名前"
            required
            maxLength={TITLE_MAX_LENGTH}
            value={settings.title}
            error={errors.title ?? undefined}
            hint="投影画面の見出しにも使います。"
            onChange={(event) => {
              patchSettings({ title: event.currentTarget.value });
            }}
          />

          {isNumberKind ? (
            <div className="flex flex-col gap-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextInput
                  label="いくつから"
                  inputMode="numeric"
                  autoComplete="off"
                  value={settings.numberMin}
                  onChange={(event) => {
                    patchSettings({ numberMin: event.currentTarget.value });
                  }}
                />
                <TextInput
                  label="いくつまで"
                  inputMode="numeric"
                  autoComplete="off"
                  value={settings.numberMax}
                  onChange={(event) => {
                    patchSettings({ numberMax: event.currentTarget.value });
                  }}
                />
              </div>
              <p className="text-sm text-slate-700">
                {rangeCount !== null
                  ? `この範囲だと ${formatCount(rangeCount, '件')} を引けます。`
                  : '範囲を数字で入力してください。'}
              </p>
              {errors.range !== undefined ? (
                <p role="alert" className="text-sm font-bold text-red-700">
                  {errors.range}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      {isNumberKind ? (
        <Card title="引く数字">
          <p className="text-sm text-slate-700">
            数字は上の範囲から自動で作られます。1件ずつの編集はありません。
          </p>
        </Card>
      ) : (
        <>
          <Card
            title={`引くものの一覧（${formatCount(entries.length, '件')}）`}
            description="上から順に並びます。並び順は当選順ではありません（引く順番は毎回ばらばらです）。"
            actions={
              <Button variant="secondary" size="sm" onClick={addEntry}>
                行を追加
              </Button>
            }
          >
            {entries.length === 0 ? (
              <p className="text-sm text-slate-700">
                まだ 1 件もありません。下の「貼り付け／CSV
                で取り込む」から名簿をまとめて入れられます。
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {entries.slice(0, visibleRows).map((entry, index) => (
                  <li
                    key={entry.key}
                    className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:p-4"
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <span className="mt-3 w-10 shrink-0 text-right text-sm font-bold text-slate-500 tabular-nums">
                        {index + 1}
                      </span>
                      <TextInput
                        label={`${index + 1}行目の文字`}
                        className="min-w-0 flex-1"
                        maxLength={DRAW_LABEL_MAX_LENGTH}
                        value={entry.label}
                        onChange={(event) => {
                          patchEntry(entry.key, { label: event.currentTarget.value });
                        }}
                      />
                      {hasWeights ? (
                        <TextInput
                          label="重み"
                          className="w-24 shrink-0"
                          inputMode="numeric"
                          value={entry.weight}
                          hint={weightShare(entry.weight, entries)}
                          onChange={(event) => {
                            patchEntry(entry.key, { weight: event.currentTarget.value });
                          }}
                        />
                      ) : null}
                      <div className="mt-6 flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === 0}
                          aria-label={`${index + 1}行目を上へ移動`}
                          onClick={() => {
                            moveEntry(index, -1);
                          }}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === entries.length - 1}
                          aria-label={`${index + 1}行目を下へ移動`}
                          onClick={() => {
                            moveEntry(index, 1);
                          }}
                        >
                          ↓
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${index + 1}行目を削除`}
                          onClick={() => {
                            removeEntry(entry.key);
                          }}
                        >
                          削除
                        </Button>
                      </div>
                    </div>

                    {hasImages ? (
                      <ImageField
                        className="mt-3"
                        label={`${index + 1}行目の画像（任意）`}
                        scope={{ kind: 'drawList', listId }}
                        usage="drawItem"
                        image={entry.image}
                        alt={entry.imageAlt}
                        hint="景品の写真など。投影画面で文字と一緒に出ます。"
                        onImageChange={(image) => {
                          patchEntry(entry.key, { image });
                        }}
                        onAltChange={(value) => {
                          patchEntry(entry.key, { imageAlt: value });
                        }}
                        onUploadingChange={(value) => {
                          handleUploadingChange(entry.key, value);
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {entries.length > visibleRows ? (
              <div className="mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setVisibleRows((previous) => previous + VISIBLE_ROWS_STEP);
                  }}
                >
                  残り{formatCount(entries.length - visibleRows, '件')}のうち
                  {VISIBLE_ROWS_STEP}件を表示
                </Button>
                <p className="mt-2 text-xs text-slate-600">
                  表示していない行も「行を保存する」で一緒に保存されます。
                </p>
              </div>
            ) : null}
          </Card>

          <DrawImportPanel
            listId={listId}
            withWeight={hasWeights}
            currentCount={list.entryCount}
            onImported={handleImported}
            {...(entriesDirty
              ? {
                  blockedReason:
                    '保存していない編集があります。取り込むと上書きされて消えるため、先に「行を保存する」を押してください。',
                }
              : {})}
          />
        </>
      )}

      <Card
        title="投影の演出"
        description="ここでの変更は自動で保存され、次に作るルームから使われます。"
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              label="回す速さ（ミリ秒）"
              inputMode="numeric"
              autoComplete="off"
              value={settings.spinIntervalMs}
              error={errors.spinIntervalMs ?? undefined}
              hint={`候補を1つ映す長さです。小さいほど速く回ります（${SPIN_INTERVAL_MIN_MS}〜${SPIN_INTERVAL_MAX_MS}）。`}
              onChange={(event) => {
                patchSettings({ spinIntervalMs: event.currentTarget.value });
              }}
            />
            <TextInput
              label="回す時間（ミリ秒）"
              inputMode="numeric"
              autoComplete="off"
              value={settings.spinDurationMs}
              error={errors.spinDurationMs ?? undefined}
              hint={`回し始めてから止まるまでの長さです。長いほど焦らせます（${SPIN_DURATION_MIN_MS}〜${SPIN_DURATION_MAX_MS}）。`}
              onChange={(event) => {
                patchSettings({ spinDurationMs: event.currentTarget.value });
              }}
            />
            <TextInput
              label="ストップしてから止まるまで（ミリ秒）"
              inputMode="numeric"
              autoComplete="off"
              value={settings.stopDurationMs}
              error={errors.stopDurationMs ?? undefined}
              hint={`ルーレットで使います。「ストップ」を押してから円盤が止まるまでの長さです（${STOP_DURATION_MIN_MS}〜${STOP_DURATION_MAX_MS}）。`}
              onChange={(event) => {
                patchSettings({ stopDurationMs: event.currentTarget.value });
              }}
            />
            <TextInput
              label="結果の文字の大きさ"
              inputMode="numeric"
              autoComplete="off"
              value={settings.resultFontSize}
              error={errors.resultFontSize ?? undefined}
              hint={`引いたものを出す文字の大きさです（${DRAW_FONT_SIZE_MIN}〜${DRAW_FONT_SIZE_MAX}）。長い名前が多いなら小さくします。`}
              onChange={(event) => {
                patchSettings({ resultFontSize: event.currentTarget.value });
              }}
            />
            <TextInput
              label="履歴の文字の大きさ"
              inputMode="numeric"
              autoComplete="off"
              value={settings.historyFontSize}
              error={errors.historyFontSize ?? undefined}
              hint={`これまでに出たものを並べる文字の大きさです（${DRAW_FONT_SIZE_MIN}〜${DRAW_FONT_SIZE_MAX}）。`}
              onChange={(event) => {
                patchSettings({ historyFontSize: event.currentTarget.value });
              }}
            />
          </div>

          <RadioGroup
            name="draw-layout"
            legend="投影の見せ方"
            value={settings.layout}
            options={DRAW_LAYOUTS.map((layout) => ({
              value: layout,
              label: DRAW_LAYOUT_LABELS[layout],
              description: DRAW_LAYOUT_HINTS[layout],
            }))}
            onChange={(layout) => {
              patchSettings({ layout });
            }}
          />

          <div className="flex flex-col gap-2">
            <ImageField
              label="背景画像（任意）"
              scope={{ kind: 'drawList', listId }}
              usage="stageBackground"
              image={backgroundImage}
              alt={backgroundAlt}
              hint="投影画面の背景に敷きます。指定しなければ既定の背景を使います。"
              onImageChange={(image) => {
                setBackgroundImage(image);
                patchSettings({ backgroundAssetId: image?.assetId ?? null });
              }}
              onAltChange={setBackgroundAlt}
            />
            {settings.backgroundAssetId !== null && backgroundImage === null ? (
              <Alert variant="warning">
                設定されている背景画像が見つかりません（消された可能性があります）。選び直すか、外してください。
                <span className="mt-2 block">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      patchSettings({ backgroundAssetId: null });
                    }}
                  >
                    背景画像を外す
                  </Button>
                </span>
              </Alert>
            ) : null}
          </div>

          <TextInput
            label="オープニング動画の URL（任意）"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={settings.openingVideoUrl}
            error={errors.openingVideoUrl ?? undefined}
            hint="始める前に流す動画です。動画そのものはここへ入れられません。すでに置いてある mp4 などの URL を入れてください。"
            onChange={(event) => {
              patchSettings({ openingVideoUrl: event.currentTarget.value });
            }}
          />
        </div>
      </Card>

      <Card title="このリストで開く">
        <div className="flex flex-wrap items-center gap-3">
          {usableModes.map((mode) => (
            <Link
              key={mode}
              href={`/admin/rooms/new?mode=${mode}`}
              className="border-brand-300 text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-600 inline-flex min-h-12 items-center rounded-xl border bg-white px-5 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {ROOM_MODE_LABELS[mode]}のルームを作る
            </Link>
          ))}
          <Link href="/admin/draw-lists" className="text-brand-700 font-bold hover:underline">
            抽選リスト一覧へ戻る
          </Link>
        </div>
        <p className="mt-3 text-sm text-slate-600">
          ルームには、作った時点の中身が写し取られます。当日このリストを直しても、開催中のルームは変わりません。
        </p>
      </Card>
    </div>
  );
}
