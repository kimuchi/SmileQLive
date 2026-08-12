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
  showTotalQuestions,
  remainingSeconds,
  remainingMs,
  answeredCount,
  participantCount,
}: {
  question: PublicQuestion;
  phase: RoomPhase;
  questionPosition: number | null;
  totalQuestions: number;
  /** 「/ 全n問」を出すか。 */
  showTotalQuestions: boolean;
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
              ? formatQuestionProgress(questionPosition, totalQuestions, {
                  showTotal: showTotalQuestions,
                })
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

        文字（問題文・選択肢の文言）は会場から読めないと成立しないので縮めない。
        縮むのは**画像**だけ。
        overflow-hidden は最後の砦で、それでも入りきらないときに枠の外へ
        はみ出して見出しや回答済み表示へ重なるのを止める。
      */}
      <div
        className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden"
        style={{ gap: stageSize(24) }}
      >
        {question.text !== null && question.text.length > 0 ? (
          <h1
            className="shrink-0 font-bold break-words text-white"
            style={{ fontSize: stageSize(STAGE_FONT.question), lineHeight: 1.25 }}
          >
            {question.text}
          </h1>
        ) : null}

        {question.image ? (
          /*
            写真がある問題は、写真と回答欄を**左右**に並べる。

            16:9 の投影で縦に積むと、見出し・選択肢・残り時間と高さを取り合って
            写真が画面高の 15% ほどにしかならず、写真を見て答えるクイズが成立しない。
            横に並べれば同じ余白で 3 倍以上の大きさで出せる。
            写真の高さは行の高さそのもの。幅は縦横比なりに決まる（縦長でも歪めない）。
          */
          <div className="flex min-h-0 flex-1 flex-row items-stretch" style={{ gap: stageSize(40) }}>
            {/*
              写真の高さは行いっぱい。幅は縦横比なりに決まるので、
              横長なら広く、縦長なら狭く場所を取る（余白を作らない）。
              ただし行の 60% は超えさせない。超えると選択肢の文字が読めなくなる。
            */}
            <div
              className="flex min-h-0 min-w-0 shrink items-center justify-center"
              style={{ maxWidth: '60%' }}
            >
              <StageImage image={question.image} maxHeightRatio={0.62} fill />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center">
              <AnswerArea question={question} />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-center">
            <AnswerArea question={question} />
          </div>
        )}
      </div>

      <div className="shrink-0">
        <AnswerProgress answeredCount={answeredCount} participantCount={participantCount} />
      </div>
    </div>
  );
}

/**
 * 回答欄。選択肢の一覧か、数値入力の案内。
 *
 * 写真の有無で置き場所（縦積み・左右）が変わるだけで、中身は同じにする。
 */
function AnswerArea({ question }: { question: PublicQuestion }) {
  if (question.type === 'choice') {
    // 受付中は results を渡さない = 選択肢別の人数を出さない。
    // fillHeight: 与えられた高さに合わせ、入りきらないときは選択肢の画像を縮める。
    return <ChoiceGrid choices={question.choices} fillHeight />;
  }
  return <NumberQuestionPanel question={question} />;
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
