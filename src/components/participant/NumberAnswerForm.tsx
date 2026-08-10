'use client';

import { useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/shared/Button';
import {
  tryNormalizeNumberAnswer,
  type NumberNormalizationErrorCode,
} from '@/domain/answer/number-normalizer';
import { cn } from '@/lib/client/cn';

/**
 * 数値式の回答 UI。
 *
 * 守ること:
 * - 全角数字・桁区切りのカンマ・空白を受け付け、送信前に tryNormalizeNumberAnswer() で正規化する。
 * - 空欄・指数表記 (1e3)・単位付き (12kg) は送信せず、その場で理由を伝える。
 * - 単位は入力欄の「外側」に置く（入力値へ単位が混ざらないようにする）。
 * - Enter でも送信できる（form の submit）。
 * - 正誤は一切表示しない。判定はサーバー / DB の numeric が唯一の正。
 * - 音・振動を鳴らさない。
 */

const ERROR_MESSAGES: Record<NumberNormalizationErrorCode, string> = {
  INVALID_NUMBER_LENGTH: '数値を入力してください',
  INVALID_NUMBER_FORMAT: '数字だけを入力してください（単位や記号、1e3 のような表記は使えません）',
  NUMBER_TOO_LARGE: '入力できる桁数を超えています',
  NUMBER_TOO_MANY_DECIMALS: '小数点以下は10桁までです',
};

export type NumberAnswerFormProps = {
  unit: string | null;
  decimalPlaces: number;
  /** 回答を受け付けている（未回答・締切前）か。 */
  interactive: boolean;
  submitting: boolean;
  onSubmit: (input: { raw: string; normalizedText: string }) => void;
};

export function NumberAnswerForm({
  unit,
  decimalPlaces,
  interactive,
  submitting,
  onSubmit,
}: NumberAnswerFormProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const previewId = `${inputId}-preview`;

  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 全角数字などが混ざっていたとき、実際に送られる値を見せて不安を減らす。
  const normalizedPreview = useMemo(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const result = tryNormalizeNumberAnswer(trimmed);
    if (!result.ok || result.value.normalizedText === trimmed) {
      return null;
    }
    return result.value.normalizedText;
  }, [value]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!interactive || submitting) {
      return;
    }

    const result = tryNormalizeNumberAnswer(value);
    if (!result.ok) {
      setError(ERROR_MESSAGES[result.code]);
      return;
    }

    setError(null);
    onSubmit({ raw: value, normalizedText: result.value.normalizedText });
  };

  const describedBy = cn(
    hintId,
    normalizedPreview !== null && previewId,
    error !== null && errorId,
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <p id={hintId} className="text-sm font-bold text-slate-700">
        数値を入力してください
        {decimalPlaces > 0 ? `（小数点以下${decimalPlaces}桁まで）` : ''}
      </p>

      <div className="flex items-center gap-3">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="send"
          aria-label="数値回答"
          aria-invalid={error !== null || undefined}
          aria-describedby={describedBy}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={!interactive || submitting}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="例: 12.5"
          maxLength={64}
          className={cn(
            'min-h-14 w-full min-w-0 flex-1 rounded-xl border-2 bg-white px-4 py-3',
            'text-2xl font-bold text-slate-900 tabular-nums',
            'placeholder:text-lg placeholder:font-normal placeholder:text-slate-400',
            'focus-visible:outline-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2',
            'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500',
            error !== null ? 'border-red-400' : 'border-slate-300',
          )}
        />
        {/* 単位は入力欄の外側。入力値へ混ぜない。 */}
        {unit ? (
          <span className="shrink-0 text-lg font-bold whitespace-nowrap text-slate-700">
            {unit}
          </span>
        ) : null}
      </div>

      {normalizedPreview !== null ? (
        <p id={previewId} className="text-sm text-slate-600">
          送信する値: <span className="font-bold tabular-nums">{normalizedPreview}</span>
          {unit ? ` ${unit}` : ''}
        </p>
      ) : null}

      {error !== null ? (
        <p id={errorId} role="alert" className="text-sm font-bold text-red-700">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" fullWidth loading={submitting} disabled={!interactive}>
        回答する
      </Button>
    </form>
  );
}
