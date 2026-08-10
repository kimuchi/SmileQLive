import { Badge } from '@/components/shared/Badge';
import type { AnswerBreakdown, RevealInfo } from '@/domain/answer/answer-dto';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import { choiceLabelFor } from '@/domain/quiz/question';
import { formatCount, formatInteger, percent } from '@/lib/format';

/**
 * 締切後の集計表示（司会）。
 *
 * 回答受付中はサーバーが breakdown を返さない。
 * この画面も「集計が来たときだけ描く」ことで、受付中に分布が見えないようにする。
 */

export type HostBreakdownPanelProps = {
  breakdown: AnswerBreakdown | null;
  reveal: RevealInfo | null;
  question: PublicQuestion | null;
};

export function HostBreakdownPanel({ breakdown, reveal, question }: HostBreakdownPanelProps) {
  if (breakdown === null) {
    return (
      <p className="text-sm text-slate-600">
        集計は正解発表のあとに表示されます（受付中は分布を出しません）。
      </p>
    );
  }

  if (breakdown.type === 'choice') {
    const choiceTexts = new Map<string, string>();
    if (question?.type === 'choice') {
      for (const choice of question.choices) {
        choiceTexts.set(choice.id, choice.text ?? '（画像の選択肢）');
      }
    }

    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-600">
          回答 {formatCount(breakdown.answeredCount)} / 未回答{' '}
          {formatCount(breakdown.unansweredCount)}
        </p>
        <ul className="flex flex-col gap-2">
          {[...breakdown.choices]
            .sort((a, b) => a.position - b.position)
            .map((choice) => {
              const label = choiceLabelFor(choice.position);
              const ratio = Math.max(0, Math.min(1, choice.ratio));
              return (
                <li key={choice.choiceId} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Badge variant={choice.isCorrect ? 'success' : 'neutral'} size="md">
                        {label}
                      </Badge>
                      <span className="font-bold text-slate-900">
                        {choiceTexts.get(choice.choiceId) ?? ''}
                      </span>
                      {choice.isCorrect ? <Badge variant="success">正解</Badge> : null}
                    </span>
                    <span className="text-sm font-bold text-slate-700 tabular-nums">
                      {formatCount(choice.count)}（{percent(ratio)}）
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={choice.isCorrect ? 'h-full bg-emerald-500' : 'h-full bg-slate-400'}
                      style={{ width: `${(ratio * 100).toFixed(1)}%` }}
                    />
                  </div>
                </li>
              );
            })}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-600">
        回答 {formatCount(breakdown.answeredCount)} / 未回答{' '}
        {formatCount(breakdown.unansweredCount)}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label="正解" value={formatCount(breakdown.correctCount)} tone="correct" />
        <Stat label="不正解" value={formatCount(breakdown.incorrectCount)} />
        <Stat label="正答率" value={percent(breakdown.correctRate)} />
      </div>
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
        <span className="font-bold text-slate-600">正解条件: </span>
        <span className="font-bold text-slate-900">
          {reveal?.answerRuleDisplay ?? breakdown.answerRuleDisplay}
        </span>
      </p>
      {breakdown.frequentValues.length > 0 ? (
        <div>
          <p className="text-sm font-bold text-slate-700">多かった回答</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {breakdown.frequentValues.map((entry) => (
              <li
                key={entry.value}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm"
              >
                <span className="font-bold text-slate-900">{entry.value}</span>
                <span className="ml-2 text-slate-600 tabular-nums">
                  {formatInteger(entry.count)}件
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'correct' }) {
  return (
    <p className="rounded-xl border border-slate-200 px-3 py-2">
      <span className="block text-xs font-bold text-slate-600">{label}</span>
      <span
        className={
          tone === 'correct'
            ? 'block text-lg font-bold text-emerald-700 tabular-nums'
            : 'block text-lg font-bold text-slate-900 tabular-nums'
        }
      >
        {value}
      </span>
    </p>
  );
}
