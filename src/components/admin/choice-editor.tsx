'use client';

import { useCallback } from 'react';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { FieldError } from '@/components/shared/FieldLabel';
import { TextInput } from '@/components/shared/TextInput';
import { ImageField } from '@/components/admin/image-field';
import {
  CHOICE_TEXT_MAX_LENGTH,
  labelForIndex,
  type ChoiceDraft,
} from '@/components/admin/question-draft';
import { CHOICE_MAX_COUNT, CHOICE_MIN_COUNT } from '@/domain/quiz/question';
import type { AdminMediaRef } from '@/types/api';

/**
 * 選択式の選択肢編集。
 *
 * - 表示ラベル A〜E は並び順から導出する。DB へ保存しない。
 * - 正解はラジオで 1 つだけ選ぶ。
 * - 3 個以上あるときだけ削除できる（最低 2 個）。
 */

export type ChoiceEditorProps = {
  quizId: string;
  questionId: string;
  choices: ChoiceDraft[];
  disabled?: boolean;
  busy?: boolean;
  error?: string | undefined;
  onChoicesChange: (choices: ChoiceDraft[]) => void;
  onAddChoice: () => void;
  onDeleteChoice: (choiceId: string) => void;
  onUploadingChange?: (uploading: boolean) => void;
};

export function ChoiceEditor({
  quizId,
  questionId,
  choices,
  disabled = false,
  busy = false,
  error,
  onChoicesChange,
  onAddChoice,
  onDeleteChoice,
  onUploadingChange,
}: ChoiceEditorProps) {
  const updateChoice = useCallback(
    (choiceId: string, patch: Partial<ChoiceDraft>) => {
      onChoicesChange(
        choices.map((choice) => (choice.id === choiceId ? { ...choice, ...patch } : choice)),
      );
    },
    [choices, onChoicesChange],
  );

  const selectCorrect = useCallback(
    (choiceId: string) => {
      onChoicesChange(choices.map((choice) => ({ ...choice, isCorrect: choice.id === choiceId })));
    },
    [choices, onChoicesChange],
  );

  const move = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= choices.length) {
        return;
      }
      const next = [...choices];
      const current = next[index];
      const swapped = next[target];
      if (!current || !swapped) {
        return;
      }
      next[index] = swapped;
      next[target] = current;
      onChoicesChange(next);
    },
    [choices, onChoicesChange],
  );

  const canDelete = choices.length > CHOICE_MIN_COUNT;
  const canAdd = choices.length < CHOICE_MAX_COUNT;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-bold text-slate-800">選択肢と正解</legend>
      <p className="text-xs text-slate-600">
        正解はひとつだけ選びます。選択肢は{CHOICE_MIN_COUNT}〜{CHOICE_MAX_COUNT}個です。
      </p>

      {error !== undefined ? (
        <FieldError id={`${questionId}-choices-error`}>{error}</FieldError>
      ) : null}

      <ul className="flex flex-col gap-3">
        {choices.map((choice, index) => {
          const label = labelForIndex(index);
          const radioId = `${questionId}-correct-${choice.id}`;
          return (
            <li
              key={choice.id}
              className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 sm:p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Badge variant="brand" size="md">
                    {label}
                  </Badge>
                  <label
                    htmlFor={radioId}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold text-slate-800"
                  >
                    <input
                      id={radioId}
                      type="radio"
                      name={`${questionId}-correct`}
                      className="accent-brand-600 focus-visible:outline-brand-600 size-5 focus-visible:outline-2 focus-visible:outline-offset-2"
                      checked={choice.isCorrect}
                      disabled={disabled}
                      onChange={() => {
                        selectCorrect(choice.id);
                      }}
                    />
                    この選択肢を正解にする
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || index === 0}
                    aria-label={`選択肢${label}を上へ移動`}
                    onClick={() => {
                      move(index, -1);
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || index === choices.length - 1}
                    aria-label={`選択肢${label}を下へ移動`}
                    onClick={() => {
                      move(index, 1);
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || busy || !canDelete}
                    title={canDelete ? undefined : `選択肢は最低${CHOICE_MIN_COUNT}個必要です`}
                    onClick={() => {
                      onDeleteChoice(choice.id);
                    }}
                  >
                    削除
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-3">
                <TextInput
                  label={`選択肢${label}の文章`}
                  maxLength={CHOICE_TEXT_MAX_LENGTH}
                  value={choice.text}
                  disabled={disabled}
                  onChange={(event) => {
                    updateChoice(choice.id, { text: event.currentTarget.value });
                  }}
                />
                <ImageField
                  label={`選択肢${label}の画像（任意）`}
                  scope={{ kind: 'quiz', quizId }}
                  usage="choice"
                  image={choice.image}
                  alt={choice.imageAlt}
                  disabled={disabled}
                  hint="画像だけの選択肢にする場合は、代替テキストを必ず入れてください。"
                  onImageChange={(image: AdminMediaRef | null) => {
                    updateChoice(choice.id, { image });
                  }}
                  onAltChange={(value) => {
                    updateChoice(choice.id, { imageAlt: value });
                  }}
                  {...(onUploadingChange !== undefined
                    ? { onUploadingChange: onUploadingChange }
                    : {})}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || busy || !canAdd}
          title={canAdd ? undefined : `選択肢は最大${CHOICE_MAX_COUNT}個までです`}
          onClick={onAddChoice}
        >
          選択肢を追加
        </Button>
      </div>
    </fieldset>
  );
}
