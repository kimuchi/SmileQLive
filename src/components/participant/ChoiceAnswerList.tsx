'use client';

import { QuestionImage } from '@/components/participant/QuestionImage';
import type { PublicChoice } from '@/domain/quiz/public-question';
import { cn } from '@/lib/client/cn';

/**
 * 選択式の回答 UI。
 *
 * 守ること:
 * - カード全体がタップ領域。縦一列に並べ、選択肢が 2 個でも 5 個でも同じ操作感にする。
 * - 最小タップ高さは 44px を下回らせない（実際には 64px 以上を確保する）。
 * - 送信中はすべてのカードを無効化して二重タップを防ぐ。
 * - correctChoiceId は正解発表後にだけ渡ってくる。それ以前は null で、
 *   正誤を推測できる装飾を一切出さない。
 * - 音・振動を鳴らさない。
 */

export type ChoiceAnswerListProps = {
  choices: readonly PublicChoice[];
  /** 回答を受け付けている（未回答・締切前）か。 */
  interactive: boolean;
  /** 送信中の選択肢 ID。送信中は全カードを無効にする。 */
  submittingChoiceId: string | null;
  /** 送信に成功した自分の選択肢 ID。 */
  answeredChoiceId: string | null;
  /** 正解発表後のみ渡す。発表前は必ず null。 */
  correctChoiceId: string | null;
  onSelect: (choiceId: string) => void;
};

type ChoiceTone = 'default' | 'chosen' | 'correct' | 'missed';

const TONE_CLASS: Record<ChoiceTone, string> = {
  default: 'border-slate-200 bg-white text-slate-900',
  chosen: 'border-brand-500 bg-brand-50 text-brand-900',
  correct: 'border-emerald-500 bg-emerald-50 text-emerald-900',
  missed: 'border-red-300 bg-red-50 text-red-900',
};

const LABEL_TONE_CLASS: Record<ChoiceTone, string> = {
  default: 'bg-slate-100 text-slate-700',
  chosen: 'bg-brand-600 text-white',
  correct: 'bg-emerald-600 text-white',
  missed: 'bg-red-500 text-white',
};

export function ChoiceAnswerList({
  choices,
  interactive,
  submittingChoiceId,
  answeredChoiceId,
  correctChoiceId,
  onSelect,
}: ChoiceAnswerListProps) {
  const submitting = submittingChoiceId !== null;
  const revealed = correctChoiceId !== null;

  return (
    <ul className="flex flex-col gap-3">
      {choices.map((choice) => {
        const isChosen = answeredChoiceId === choice.id;
        const isCorrect = revealed && correctChoiceId === choice.id;

        const tone: ChoiceTone = isCorrect
          ? 'correct'
          : revealed && isChosen
            ? 'missed'
            : isChosen
              ? 'chosen'
              : 'default';

        const disabled = !interactive || submitting;
        const isSubmittingThis = submittingChoiceId === choice.id;

        return (
          <li key={choice.id}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={isChosen}
              onClick={() => onSelect(choice.id)}
              className={cn(
                'flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left',
                'transition-colors select-none',
                'focus-visible:outline-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2',
                TONE_CLASS[tone],
                disabled && !isChosen && !isCorrect && 'opacity-70',
                disabled ? 'cursor-default' : 'cursor-pointer active:brightness-95',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-full text-base font-bold',
                  LABEL_TONE_CLASS[tone],
                )}
              >
                {choice.label}
              </span>

              <span className="flex min-w-0 flex-1 flex-col gap-2">
                {choice.text ? (
                  <span className="text-base leading-snug font-bold break-words">
                    {choice.text}
                  </span>
                ) : null}
                {choice.image ? <QuestionImage image={choice.image} className="max-h-40" /> : null}
              </span>

              <span className="shrink-0 text-xs font-bold">
                {isSubmittingThis ? (
                  <span className="text-brand-700">送信中…</span>
                ) : isCorrect ? (
                  <span className="text-emerald-700">正解</span>
                ) : isChosen ? (
                  <span className={revealed ? 'text-red-700' : 'text-brand-700'}>あなたの回答</span>
                ) : null}
              </span>

              <span className="sr-only">
                {choice.label}
                {choice.text ? ` ${choice.text}` : ''}
                {isChosen ? '（あなたの回答）' : ''}
                {isCorrect ? '（正解）' : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
