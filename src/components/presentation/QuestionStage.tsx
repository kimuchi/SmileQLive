'use client';

import { AnswerProgress } from '@/components/presentation/AnswerProgress';
import { ChoiceGrid } from '@/components/presentation/ChoiceGrid';
import { StageCountdown } from '@/components/presentation/StageCountdown';
import { StageImage } from '@/components/presentation/StageImage';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import type { PublicQuestion } from '@/domain/quiz/public-question';
import type { RoomPhase } from '@/domain/room/state-machine';
import { formatInteger, formatQuestionProgress } from '@/lib/format';

/**
 * 出題中の投影。
 *
 * 表示できるのは toPublicQuestion() を通した内容だけ。
 * 正解選択肢・正解値・許容誤差・解説・正解画像は、この画面のどこにも現れない
 * （Snapshot が正解発表フェーズになるまでサーバーから送られてこない）。
 *
 * 回答受付中は「何人が答えたか」しか出さない。選択肢別の人数・数値の分布は締切後に初めて出す。
 */
export function QuestionStage({
  question,
  phase,
  questionPosition,
  totalQuestions,
  remainingSeconds,
  remainingMs,
  answeredCount,
  participantCount,
}: {
  question: PublicQuestion;
  phase: RoomPhase;
  questionPosition: number | null;
  totalQuestions: number;
  remainingSeconds: number;
  remainingMs: number;
  answeredCount: number;
  participantCount: number;
}) {
  const open = phase === 'question_open';
  const locked = phase === 'question_locked';

  return (
    <div className="flex h-full w-full flex-col" style={{ gap: stageSize(28) }}>
      <div className="flex shrink-0 items-start justify-between" style={{ gap: stageSize(32) }}>
        <div className="flex flex-col" style={{ gap: stageSize(12) }}>
          <span
            className="bg-brand-500 inline-flex w-fit items-center rounded-full font-bold text-white"
            style={{
              paddingInline: stageSize(32),
              paddingBlock: stageSize(10),
              fontSize: stageSize(STAGE_FONT.heading),
            }}
          >
            {questionPosition !== null
              ? formatQuestionProgress(questionPosition, totalQuestions)
              : '問題'}
          </span>

          {phase === 'question_ready' ? (
            <span
              className="font-bold text-white/70"
              style={{ fontSize: stageSize(STAGE_FONT.small) }}
            >
              まもなく回答受付を開始します
            </span>
          ) : null}

          {locked ? (
            <span
              className="font-bold text-amber-200"
              style={{ fontSize: stageSize(STAGE_FONT.small) }}
            >
              回答を締め切りました
            </span>
          ) : null}
        </div>

        {open ? (
          <StageCountdown
            remainingSeconds={remainingSeconds}
            remainingMs={remainingMs}
            timeLimitSeconds={question.timeLimitSeconds}
          />
        ) : null}
      </div>

      {/*
        高さが足りないときに何を削るかを決めておく。
        問題文と選択肢は会場から読めないと成立しないので縮めない（shrink-0）。
        余りを吸収するのは画像で、入りきらなければ画像が小さくなる。
        これが無いと中身が枠を越えて、上の残り秒数や下の回答済み表示へ重なる。
      */}
      <div className="flex min-h-0 flex-1 flex-col justify-center" style={{ gap: stageSize(24) }}>
        {question.text !== null && question.text.length > 0 ? (
          <h1
            className="shrink-0 font-bold break-words text-white"
            style={{ fontSize: stageSize(STAGE_FONT.question), lineHeight: 1.25 }}
          >
            {question.text}
          </h1>
        ) : null}

        {question.image ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <StageImage image={question.image} maxHeightRatio={0.4} fill />
          </div>
        ) : null}

        <div className="shrink-0">
          {question.type === 'choice' ? (
            // 受付中は results を渡さない = 選択肢別の人数を出さない。
            <ChoiceGrid choices={question.choices} />
          ) : (
            <NumberQuestionPanel question={question} />
          )}
        </div>
      </div>

      <div className="shrink-0">
        <AnswerProgress answeredCount={answeredCount} participantCount={participantCount} />
      </div>
    </div>
  );
}

/**
 * 数値問題の案内。
 *
 * 出せるのは「どう入力すればよいか」だけ。
 * 正解値・許容誤差・範囲・個々の回答値は締切後（正解発表）まで一切出さない。
 */
function NumberQuestionPanel({
  question,
}: {
  question: Extract<PublicQuestion, { type: 'number' }>;
}) {
  const decimalGuide =
    question.decimalPlaces > 0
      ? `小数第 ${formatInteger(question.decimalPlaces)} 位まで入力できます`
      : '整数で入力してください';

  return (
    <div
      className="flex w-full flex-col items-center rounded-3xl border-4 border-white/30 bg-white/10 text-white"
      style={{ padding: stageSize(40), gap: stageSize(20) }}
    >
      <p className="font-bold" style={{ fontSize: stageSize(STAGE_FONT.heading) }}>
        数値で回答してください
      </p>

      {question.unit !== null && question.unit.length > 0 ? (
        <p className="flex items-baseline font-bold" style={{ gap: stageSize(16) }}>
          <span className="text-white/60" style={{ fontSize: stageSize(STAGE_FONT.small) }}>
            単位
          </span>
          <span style={{ fontSize: stageSize(STAGE_FONT.emphasis), lineHeight: 1 }}>
            {question.unit}
          </span>
        </p>
      ) : null}

      <p className="text-white/70" style={{ fontSize: stageSize(STAGE_FONT.body) }}>
        {decimalGuide}
      </p>
    </div>
  );
}
