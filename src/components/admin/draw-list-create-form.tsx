'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { Button } from '@/components/shared/Button';
import { Card } from '@/components/shared/Card';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { RadioGroup } from '@/components/shared/RadioGroup';
import { TextInput } from '@/components/shared/TextInput';
import {
  DRAW_ENTRY_MAX_COUNT,
  DRAW_LIST_KINDS,
  DRAW_LIST_KIND_DESCRIPTIONS,
  DRAW_LIST_KIND_LABELS,
  DRAW_NUMBER_MAX,
  DRAW_NUMBER_MIN,
  type DrawListKind,
} from '@/domain/draw/draw-list';
import { apiPost } from '@/lib/client/api-client';
import { formatCount } from '@/lib/format';
import type { DrawListDetailResponse } from '@/types/api';

/** 抽選リストの新規作成。作成後はそのまま中身の編集画面へ進む。 */

const TITLE_MAX_LENGTH = 100;

/** ビンゴでよく使う範囲。迷わせないために最初から入れておく。 */
const DEFAULT_NUMBER_MIN = '1';
const DEFAULT_NUMBER_MAX = '75';

const KIND_OPTIONS = DRAW_LIST_KINDS.map((kind) => ({
  value: kind,
  label: DRAW_LIST_KIND_LABELS[kind],
  description: DRAW_LIST_KIND_DESCRIPTIONS[kind],
}));

/** 全角で入力された数字も受け取る（会場の PC は日本語入力のままのことが多い）。 */
function parsePositiveInteger(value: string): number | null {
  const normalized = value.normalize('NFKC').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function DrawListCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DrawListKind>('name');
  const [numberMin, setNumberMin] = useState(DEFAULT_NUMBER_MIN);
  const [numberMax, setNumberMax] = useState(DEFAULT_NUMBER_MAX);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const min = parsePositiveInteger(numberMin);
  const max = parsePositiveInteger(numberMax);
  const rangeCount = min !== null && max !== null && min <= max ? max - min + 1 : null;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }
      const trimmedTitle = title.trim();
      if (trimmedTitle.length === 0) {
        setTitleError('抽選リストの名前を入力してください');
        return;
      }
      setTitleError(null);

      // 数字モードは範囲だけを保存し、使うときに 1 件ずつへ展開する。
      // ここで弾いておかないと、作れたのに中身が空のリストができてしまう。
      let range: { numberMin: number; numberMax: number } | null = null;
      if (kind === 'number') {
        if (min === null || max === null) {
          setRangeError('範囲を数字で入力してください');
          return;
        }
        if (min < DRAW_NUMBER_MIN || max > DRAW_NUMBER_MAX) {
          setRangeError(`${DRAW_NUMBER_MIN}〜${DRAW_NUMBER_MAX}の範囲で入力してください`);
          return;
        }
        if (min > max) {
          setRangeError('小さい方の数字を左に入力してください');
          return;
        }
        if (max - min + 1 > DRAW_ENTRY_MAX_COUNT) {
          setRangeError(
            `1つのリストに入れられるのは${formatCount(DRAW_ENTRY_MAX_COUNT, '件')}までです`,
          );
          return;
        }
        range = { numberMin: min, numberMax: max };
      }
      setRangeError(null);
      setError(null);
      setSubmitting(true);
      try {
        const response = await apiPost<DrawListDetailResponse>('/api/admin/draw-lists', {
          title: trimmedTitle,
          kind,
          ...(range ?? {}),
        });
        router.push(`/admin/draw-lists/${response.list.id}/edit`);
      } catch (caught) {
        setError(caught);
        setSubmitting(false);
      }
    },
    [kind, max, min, router, submitting, title],
  );

  return (
    <Card title="抽選リストの基本情報">
      <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
        {error !== null ? <ErrorMessage error={error} /> : null}

        <TextInput
          label="抽選リストの名前"
          required
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          error={titleError ?? undefined}
          hint="運営用の名前です。投影画面の見出しにも使います（例: 2026年 新年会 抽選）。"
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            if (titleError !== null) {
              setTitleError(null);
            }
          }}
        />

        <RadioGroup<DrawListKind>
          name="draw-list-kind"
          legend="引くものの種類"
          required
          options={KIND_OPTIONS}
          value={kind}
          hint="あとから種類は変えられません。中身の入れ方が変わるためです。"
          onChange={(value) => {
            setKind(value);
            setRangeError(null);
          }}
        />

        {kind === 'number' ? (
          <div className="flex flex-col gap-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput
                label="いくつから"
                inputMode="numeric"
                autoComplete="off"
                value={numberMin}
                onChange={(event) => {
                  setNumberMin(event.currentTarget.value);
                  if (rangeError !== null) {
                    setRangeError(null);
                  }
                }}
              />
              <TextInput
                label="いくつまで"
                inputMode="numeric"
                autoComplete="off"
                value={numberMax}
                onChange={(event) => {
                  setNumberMax(event.currentTarget.value);
                  if (rangeError !== null) {
                    setRangeError(null);
                  }
                }}
              />
            </div>
            <p className="text-sm text-slate-700">
              {rangeCount !== null
                ? `この範囲だと ${formatCount(rangeCount, '件')} を引けます。`
                : '範囲を数字で入力してください。'}
            </p>
            {rangeError !== null ? (
              <p role="alert" className="text-sm font-bold text-red-700">
                {rangeError}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            中身は次の画面で入れます。表計算ソフトから範囲をコピーして貼り付けられます。
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" loading={submitting}>
            作成して中身を編集する
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => {
              router.push('/admin/draw-lists');
            }}
          >
            一覧へ戻る
          </Button>
        </div>
      </form>
    </Card>
  );
}
