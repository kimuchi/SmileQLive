'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { formatQuestionProgress } from '@/lib/format';

/**
 * 出題直前の投影。
 *
 * 「回答受付を始める前に問題を見せる」設定が**オフ**のとき、
 * question_ready ではこの画面になる（問題文も選択肢もサーバーから送られてこない）。
 *
 * 会場で「第3問！」と読み上げてから出すための間。
 * 番号だけを大きく出し、視線を集めておく。
 */
export function UpcomingStage({
  questionPosition,
  totalQuestions,
  showTotalQuestions,
}: {
  questionPosition: number | null;
  totalQuestions: number;
  /** 「/ 全n問」を出すか。 */
  showTotalQuestions: boolean;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center text-center">
      <span
        className="bg-brand-500 stage-pop inline-flex items-center rounded-full font-bold text-white"
        style={{
          paddingInline: stageSize(72),
          paddingBlock: stageSize(28),
          fontSize: stageSize(STAGE_FONT.hero),
          lineHeight: 1,
        }}
      >
        {questionPosition !== null
          ? formatQuestionProgress(questionPosition, totalQuestions, {
              showTotal: showTotalQuestions,
            })
          : '次の問題'}
      </span>

      <p
        className="font-bold text-white/70"
        style={{ marginTop: stageSize(48), fontSize: stageSize(STAGE_FONT.heading) }}
      >
        まもなく出題します
      </p>

      <p
        className="text-white/50"
        style={{ marginTop: stageSize(16), fontSize: stageSize(STAGE_FONT.body) }}
      >
        手元の画面をご用意ください
      </p>
    </div>
  );
}
