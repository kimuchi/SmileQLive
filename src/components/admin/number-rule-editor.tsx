'use client';

import { RadioGroup } from '@/components/shared/RadioGroup';
import { TextInput } from '@/components/shared/TextInput';
import {
  numberRulePreview,
  type QuestionDraft,
  type QuestionDraftErrors,
} from '@/components/admin/question-draft';
import {
  DECIMAL_PLACES_MAX,
  DECIMAL_PLACES_MIN,
  UNIT_MAX_LENGTH,
  type NumberJudgementMode,
} from '@/domain/quiz/question';

/**
 * 数値式の判定条件。
 *
 * 数値はすべて文字列のまま扱う（JavaScript の number へ通さない）。
 * 実際の正誤判定は decimal.js と PostgreSQL numeric がサーバー側で行う。
 */

const MODE_OPTIONS: ReadonlyArray<{
  value: NumberJudgementMode;
  label: string;
  description: string;
}> = [
  { value: 'exact', label: '完全一致', description: '正解値とぴったり同じ数値だけを正解にします。' },
  {
    value: 'absolute_tolerance',
    label: '許容誤差',
    description: '正解値から指定した幅までのずれを正解にします。',
  },
  {
    value: 'range',
    label: '範囲指定',
    description: '最小値から最大値までを正解にします（両端を含む）。',
  },
];

export type NumberRuleEditorProps = {
  draft: QuestionDraft;
  errors: QuestionDraftErrors;
  disabled?: boolean;
  onPatch: (patch: Partial<QuestionDraft>) => void;
};

export function NumberRuleEditor({
  draft,
  errors,
  disabled = false,
  onPatch,
}: NumberRuleEditorProps) {
  const preview = numberRulePreview(draft);

  return (
    <div className="flex flex-col gap-4">
      <RadioGroup<NumberJudgementMode>
        name={`${draft.id}-number-mode`}
        legend="判定方法"
        options={MODE_OPTIONS}
        value={draft.numberMode}
        disabled={disabled}
        onChange={(value) => {
          onPatch({ numberMode: value });
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {draft.numberMode === 'range' ? (
          <>
            <TextInput
              label="最小値"
              inputMode="decimal"
              autoComplete="off"
              maxLength={42}
              value={draft.numberMinValue}
              disabled={disabled}
              error={errors.numberMinValue ?? undefined}
              onChange={(event) => {
                onPatch({ numberMinValue: event.currentTarget.value });
              }}
            />
            <TextInput
              label="最大値"
              inputMode="decimal"
              autoComplete="off"
              maxLength={42}
              value={draft.numberMaxValue}
              disabled={disabled}
              error={errors.numberMaxValue ?? undefined}
              onChange={(event) => {
                onPatch({ numberMaxValue: event.currentTarget.value });
              }}
            />
          </>
        ) : (
          <>
            <TextInput
              label="正解値"
              inputMode="decimal"
              autoComplete="off"
              maxLength={42}
              value={draft.numberCorrectValue}
              disabled={disabled}
              error={errors.numberCorrectValue ?? undefined}
              hint="半角・全角どちらでも入力できます（保存時に半角へそろえます）。"
              onChange={(event) => {
                onPatch({ numberCorrectValue: event.currentTarget.value });
              }}
            />
            {draft.numberMode === 'absolute_tolerance' ? (
              <TextInput
                label="許容誤差（±）"
                inputMode="decimal"
                autoComplete="off"
                maxLength={42}
                value={draft.numberTolerance}
                disabled={disabled}
                error={errors.numberTolerance ?? undefined}
                hint="0 以上の数値。正解値±この値までを正解とします。"
                onChange={(event) => {
                  onPatch({ numberTolerance: event.currentTarget.value });
                }}
              />
            ) : null}
          </>
        )}

        <TextInput
          label="単位（任意）"
          maxLength={UNIT_MAX_LENGTH}
          value={draft.unit}
          disabled={disabled}
          error={errors.unit ?? undefined}
          hint="例: 円 / kg / 人"
          onChange={(event) => {
            onPatch({ unit: event.currentTarget.value });
          }}
        />

        <TextInput
          label="表示小数桁数"
          inputMode="numeric"
          autoComplete="off"
          value={draft.decimalPlaces}
          disabled={disabled}
          error={errors.decimalPlaces ?? undefined}
          hint={`${DECIMAL_PLACES_MIN}〜${DECIMAL_PLACES_MAX}。投影・結果画面の表示にだけ使います。`}
          onChange={(event) => {
            onPatch({ decimalPlaces: event.currentTarget.value });
          }}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs font-bold text-slate-600">正解表示プレビュー</p>
        <p className="mt-1 text-base font-bold text-slate-900">
          {preview ?? '判定条件を入力すると、正解発表時の表示を確認できます'}
        </p>
      </div>
    </div>
  );
}
