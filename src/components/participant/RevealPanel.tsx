import { MyAnswerSummary } from '@/components/participant/MyAnswerSummary';
import { QuestionImage } from '@/components/participant/QuestionImage';
import type { MyAnswer, RevealInfo } from '@/domain/answer/answer-dto';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import type { ParticipantSnapshot } from '@/domain/room/snapshot';
import { cn } from '@/lib/client/cn';
import { formatCount, formatPoints, formatRank } from '@/lib/format';

/**
 * 正解発表後の表示。
 *
 * この画面は phase が answer_revealed 以降のときにだけ描画される。
 * reveal / myResult は Snapshot がそのフェーズでしか返さないため、
 * 発表前にここへ正解情報が渡ってくることはない。
 */
export function RevealPanel({
  question,
  reveal,
  myAnswer,
  myResult,
  participantCount,
}: {
  question: PublicQuestion;
  reveal: RevealInfo;
  myAnswer: MyAnswer | null;
  myResult: ParticipantSnapshot['myResult'];
  participantCount: number;
}) {
  const answered = myAnswer !== null;
  const isCorrect = answered && myResult?.isCorrect === true;

  const bannerTone = !answered ? 'muted' : isCorrect ? 'correct' : 'incorrect';
  const bannerText = !answered ? '未回答' : isCorrect ? '正解！' : '残念…';
  const bannerNote = !answered
    ? '時間内に回答がありませんでした'
    : isCorrect
      ? `${formatPoints(myResult?.pointsAwarded ?? 0)} 獲得`
      : '次の問題で取り返しましょう';

  return (
    <div className="flex flex-col gap-3">
      <section
        className={cn(
          'rounded-2xl border-2 p-4 text-center',
          bannerTone === 'correct' && 'border-emerald-500 bg-emerald-50 text-emerald-900',
          bannerTone === 'incorrect' && 'border-slate-300 bg-slate-100 text-slate-800',
          bannerTone === 'muted' && 'border-slate-200 bg-white text-slate-700',
        )}
        aria-live="polite"
      >
        <p className="text-3xl font-bold">{bannerText}</p>
        <p className="mt-1 text-sm font-bold">{bannerNote}</p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-bold text-slate-600">正解</h3>
        <CorrectAnswerText question={question} reveal={reveal} />
      </section>

      <MyAnswerSummary question={question} myAnswer={myAnswer} />

      {myResult ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-xs font-bold text-slate-500">この問題</dt>
              <dd className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">
                {formatPoints(myResult.pointsAwarded)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-slate-500">合計</dt>
              <dd className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">
                {formatPoints(myResult.totalPoints)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-slate-500">順位</dt>
              <dd className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">
                {formatRank(myResult.rank)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-center text-xs text-slate-500">
            参加者 {formatCount(participantCount)}
          </p>
        </section>
      ) : null}

      {reveal.explanation ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-bold text-slate-600">解説</h3>
          <p className="mt-1 text-base leading-relaxed break-words whitespace-pre-wrap text-slate-900">
            {reveal.explanation}
          </p>
        </section>
      ) : null}

      {reveal.revealImage ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="sr-only">解説画像</h3>
          <QuestionImage image={reveal.revealImage} />
        </section>
      ) : null}
    </div>
  );
}

function CorrectAnswerText({ question, reveal }: { question: PublicQuestion; reveal: RevealInfo }) {
  if (question.type === 'choice') {
    const correct = question.choices.find((choice) => choice.id === reveal.correctChoiceId) ?? null;

    if (!correct) {
      return <p className="mt-1 text-base font-bold text-slate-700">—</p>;
    }

    return (
      <p className="mt-1 flex items-center gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-base font-bold text-white">
          {correct.label}
        </span>
        <span className="min-w-0 text-lg font-bold break-words text-slate-900">
          {correct.text ?? '（画像の選択肢）'}
        </span>
      </p>
    );
  }

  return (
    <p className="mt-1 text-lg font-bold break-words text-slate-900">
      {reveal.answerRuleDisplay ?? '—'}
    </p>
  );
}
