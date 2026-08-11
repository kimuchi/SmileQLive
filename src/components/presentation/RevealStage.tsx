'use client';

import { ChoiceGrid } from '@/components/presentation/ChoiceGrid';
import { StageImage } from '@/components/presentation/StageImage';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import type { AnswerBreakdown, RevealInfo } from '@/domain/answer/answer-dto';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import { formatCount, formatInteger, formatQuestionProgress, percent } from '@/lib/format';

/**
 * 正解発表の投影。
 *
 * ここで初めて正解情報を表示する。表示に使うのは
 * 「正解発表フェーズの Snapshot がサーバーから返した reveal / breakdown」だけで、
 * 発表前に受け取って隠しておいた値は存在しない。
 *
 * 個人が特定できる情報（誰が何を答えたか）は出さない。人数と割合だけを示す。
 */
export function RevealStage({
  question,
  reveal,
  breakdown,
  questionPosition,
  totalQuestions,
}: {
  question: PublicQuestion;
  reveal: RevealInfo;
  breakdown: AnswerBreakdown | null;
  questionPosition: number | null;
  totalQuestions: number;
}) {
  const matched = breakdown && breakdown.questionId === question.id ? breakdown : null;
  const hasSidePanel =
    (reveal.explanation !== null && reveal.explanation.length > 0) || reveal.revealImage !== null;

  return (
    <div className="flex h-full w-full flex-col" style={{ gap: stageSize(24) }}>
      <div className="flex shrink-0 items-center" style={{ gap: stageSize(24) }}>
        <span
          className="text-stage-950 inline-flex items-center rounded-full bg-emerald-400 font-bold"
          style={{
            gap: stageSize(12),
            paddingInline: stageSize(32),
            paddingBlock: stageSize(10),
            fontSize: stageSize(STAGE_FONT.heading),
          }}
        >
          <span aria-hidden="true">✓</span>正解発表
        </span>
        {questionPosition !== null ? (
          <span
            className="font-bold text-white/60"
            style={{ fontSize: stageSize(STAGE_FONT.small) }}
          >
            {formatQuestionProgress(questionPosition, totalQuestions)}
          </span>
        ) : null}
        {question.text !== null && question.text.length > 0 ? (
          <span
            className="min-w-0 truncate font-bold text-white/90"
            style={{ fontSize: stageSize(STAGE_FONT.body) }}
          >
            {question.text}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 items-stretch" style={{ gap: stageSize(32) }}>
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col justify-center overflow-hidden"
          style={{ gap: stageSize(24) }}
        >
          {question.type === 'choice' ? (
            <ChoiceReveal
              question={question}
              reveal={reveal}
              breakdown={matched !== null && matched.type === 'choice' ? matched : null}
            />
          ) : (
            <NumberReveal
              reveal={reveal}
              unit={question.unit}
              breakdown={matched !== null && matched.type === 'number' ? matched : null}
            />
          )}
        </div>

        {hasSidePanel ? (
          <aside
            className="flex min-h-0 shrink-0 flex-col justify-center overflow-hidden rounded-3xl border-4 border-white/20 bg-white/5 text-white"
            style={{ width: stageSize(600), padding: stageSize(32), gap: stageSize(20) }}
          >
            <h2
              className="shrink-0 font-bold text-white/60"
              style={{ fontSize: stageSize(STAGE_FONT.small) }}
            >
              解説
            </h2>
            {/* 解説文は読ませたいので縮めない。余りの吸収は画像に任せる。 */}
            {reveal.revealImage ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <StageImage image={reveal.revealImage} maxHeightRatio={0.34} fill />
              </div>
            ) : null}
            {reveal.explanation !== null && reveal.explanation.length > 0 ? (
              <p
                className="shrink-0 break-words whitespace-pre-wrap"
                style={{ fontSize: stageSize(STAGE_FONT.body), lineHeight: 1.5 }}
              >
                {reveal.explanation}
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** 選択式の結果。正解カードを太枠＋チェック＋「正解」で示し、各選択肢の人数と割合を出す。 */
function ChoiceReveal({
  question,
  reveal,
  breakdown,
}: {
  question: Extract<PublicQuestion, { type: 'choice' }>;
  reveal: RevealInfo;
  breakdown: Extract<AnswerBreakdown, { type: 'choice' }> | null;
}) {
  return (
    <div className="flex flex-col" style={{ gap: stageSize(20) }}>
      <ChoiceGrid
        choices={question.choices}
        results={breakdown?.choices ?? null}
        correctChoiceId={reveal.correctChoiceId}
      />

      {breakdown ? (
        <p
          className="text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.caption), lineHeight: 1.5 }}
        >
          回答 {formatCount(breakdown.answeredCount)} / 未回答{' '}
          {formatCount(breakdown.unansweredCount)}（割合は回答した人の中での比率）
        </p>
      ) : null}
    </div>
  );
}

/** 数値式の結果。正解条件・正解者数・多かった回答を示す（個人名は出さない）。 */
function NumberReveal({
  reveal,
  unit,
  breakdown,
}: {
  reveal: RevealInfo;
  unit: string | null;
  breakdown: Extract<AnswerBreakdown, { type: 'number' }> | null;
}) {
  // 正解条件の文字列はサーバーが decimal.js で整形したものをそのまま使う。
  const answerRule = reveal.answerRuleDisplay ?? breakdown?.answerRuleDisplay ?? null;
  const frequent = breakdown?.frequentValues ?? [];

  return (
    <div className="flex flex-col" style={{ gap: stageSize(28) }}>
      <div
        className="flex flex-col rounded-3xl border-4 border-emerald-300 bg-emerald-400/20 text-white"
        style={{ padding: stageSize(36), gap: stageSize(12) }}
      >
        <span
          className="font-bold text-emerald-100"
          style={{ fontSize: stageSize(STAGE_FONT.small) }}
        >
          正解
        </span>
        <span
          className="font-bold break-words"
          style={{ fontSize: stageSize(STAGE_FONT.emphasis), lineHeight: 1.15 }}
        >
          {answerRule ?? '—'}
          {unit !== null && unit.length > 0 ? (
            <span style={{ fontSize: stageSize(STAGE_FONT.heading) }}> {unit}</span>
          ) : null}
        </span>
      </div>

      {breakdown ? (
        <div className="flex items-stretch" style={{ gap: stageSize(24) }}>
          <StatCard label="正解者" value={formatInteger(breakdown.correctCount)} suffix="人" />
          <StatCard label="正解率" value={percent(breakdown.correctRate)} />
          <StatCard label="回答" value={formatInteger(breakdown.answeredCount)} suffix="人" />
          <StatCard label="未回答" value={formatInteger(breakdown.unansweredCount)} suffix="人" />
        </div>
      ) : null}

      {frequent.length > 0 ? (
        <div className="flex flex-col" style={{ gap: stageSize(14) }}>
          <h2 className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
            多かった回答（上位 {formatInteger(frequent.length)} 件）
          </h2>
          <ul className="flex list-none flex-wrap" style={{ gap: stageSize(16) }}>
            {frequent.map((entry) => (
              <li
                key={entry.value}
                className="flex items-baseline rounded-2xl border-2 border-white/25 bg-white/10 font-bold text-white"
                style={{
                  gap: stageSize(14),
                  paddingInline: stageSize(28),
                  paddingBlock: stageSize(16),
                }}
              >
                <span style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1 }}>
                  {entry.value}
                </span>
                {unit !== null && unit.length > 0 ? (
                  <span
                    className="text-white/60"
                    style={{ fontSize: stageSize(STAGE_FONT.caption) }}
                  >
                    {unit}
                  </span>
                ) : null}
                <span className="text-white/70" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
                  {formatCount(entry.count)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div
      className="flex flex-1 flex-col rounded-2xl border-2 border-white/20 bg-white/5 text-white"
      style={{ padding: stageSize(24), gap: stageSize(8) }}
    >
      <span className="font-bold text-white/60" style={{ fontSize: stageSize(STAGE_FONT.caption) }}>
        {label}
      </span>
      <span className="flex items-baseline font-bold" style={{ gap: stageSize(8) }}>
        <span style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1 }}>{value}</span>
        {suffix !== undefined ? (
          <span className="text-white/60" style={{ fontSize: stageSize(STAGE_FONT.caption) }}>
            {suffix}
          </span>
        ) : null}
      </span>
    </div>
  );
}
