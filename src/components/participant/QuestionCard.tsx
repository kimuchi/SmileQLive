import { QuestionImage } from '@/components/participant/QuestionImage';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import { formatPoints } from '@/lib/format';

/**
 * 問題本文の表示。
 *
 * ここへ渡ってくるのは toPublicQuestion() を通した DTO だけ。
 * 正解選択肢・正解値・解説・解説画像は構造上そもそも含まれない。
 */
export function QuestionCard({ question }: { question: PublicQuestion }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-brand-700 text-xs font-bold">
          {question.type === 'choice' ? '選択式' : '数値入力'}
        </span>
        <span className="text-xs font-bold text-slate-500">{formatPoints(question.points)}</span>
      </div>

      {question.text ? (
        <h2 className="mt-2 text-xl leading-relaxed font-bold break-words whitespace-pre-wrap text-slate-900">
          {question.text}
        </h2>
      ) : null}

      {question.image ? (
        <div className="mt-3">
          <QuestionImage image={question.image} priority />
        </div>
      ) : null}
    </section>
  );
}
