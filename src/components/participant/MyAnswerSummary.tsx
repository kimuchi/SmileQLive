import type { MyAnswer } from '@/domain/answer/answer-dto';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import { cn } from '@/lib/client/cn';

/**
 * 自分が送信した回答の表示。
 *
 * - 正解発表前でも本人の回答は見せてよい。ただし正誤は絶対に出さない。
 * - 数値式は「実際に入力した文字列」と「送信された正規化値」の両方を出し、
 *   全角入力などで意図と違う値が送られていないか本人が確認できるようにする。
 */
export function MyAnswerSummary({
  question,
  myAnswer,
  className,
}: {
  question: PublicQuestion;
  myAnswer: MyAnswer | null;
  className?: string;
}) {
  if (!myAnswer) {
    return (
      <div className={cn('rounded-xl border border-slate-200 bg-slate-50 p-3', className)}>
        <p className="text-sm font-bold text-slate-600">あなたの回答</p>
        <p className="mt-1 text-base font-bold text-slate-700">回答していません</p>
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border border-slate-200 bg-slate-50 p-3', className)}>
      <p className="text-sm font-bold text-slate-600">あなたの回答</p>
      {myAnswer.type === 'choice' && question.type === 'choice' ? (
        <ChoiceAnswerText question={question} choiceId={myAnswer.choiceId} />
      ) : null}
      {myAnswer.type === 'number' && question.type === 'number' ? (
        <NumberAnswerText
          raw={myAnswer.raw}
          normalizedText={myAnswer.normalizedText}
          unit={question.unit}
        />
      ) : null}
    </div>
  );
}

function ChoiceAnswerText({
  question,
  choiceId,
}: {
  question: Extract<PublicQuestion, { type: 'choice' }>;
  choiceId: string;
}) {
  const choice = question.choices.find((candidate) => candidate.id === choiceId) ?? null;

  if (!choice) {
    // 問題が切り替わった直後など。ここで正誤を推測させる表示はしない。
    return <p className="mt-1 text-base font-bold text-slate-700">送信済み</p>;
  }

  return (
    <p className="mt-1 flex items-center gap-2">
      <span className="bg-brand-600 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white">
        {choice.label}
      </span>
      <span className="min-w-0 text-base font-bold break-words text-slate-900">
        {choice.text ?? '（画像の選択肢）'}
      </span>
    </p>
  );
}

function NumberAnswerText({
  raw,
  normalizedText,
  unit,
}: {
  raw: string;
  normalizedText: string;
  unit: string | null;
}) {
  const trimmedRaw = raw.trim();
  const showRaw = trimmedRaw.length > 0 && trimmedRaw !== normalizedText;

  return (
    <div className="mt-1">
      <p className="text-xl font-bold text-slate-900 tabular-nums">
        {normalizedText}
        {unit ? <span className="ml-1 text-base font-bold text-slate-700">{unit}</span> : null}
      </p>
      {showRaw ? <p className="mt-0.5 text-xs text-slate-600">入力した内容: {trimmedRaw}</p> : null}
    </div>
  );
}
