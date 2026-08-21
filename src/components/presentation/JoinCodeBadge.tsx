'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { QrCode } from '@/components/shared/QrCode';

/**
 * 進行中もずっと出しておく参加用の二次元コード。
 *
 * クイズ設定「参加用の二次元コードをずっと表示する」を入れたときだけ出す。
 * 途中から会場へ来た人が、進行を止めずにその場で参加できる。
 *
 * 置き方の決めごと:
 * - 問題文・選択肢の上へ重ねない。StageFrame の右下に**場所を取って**置く。
 * - 待機画面の大きなコードとは別物。ここは小さくてよい（近くの席向け）。
 * - 参加 URL は文字として出さない。二次元コードとしてだけ出す。
 */
export function JoinCodeBadge({ joinUrl }: { joinUrl: string }) {
  return (
    <div
      className="flex flex-col items-center rounded-2xl border border-white/25 bg-white/10"
      style={{
        padding: stageSize(12),
        gap: stageSize(8),
        width: stageSize(268),
      }}
    >
      <QrCode
        // 参加 URL が変わったら、古いコードを DOM ごと作り直して残さない。
        key={joinUrl}
        value={joinUrl}
        size={228}
        title="参加用の二次元コード"
        className="w-full"
      />
      <p
        // 折り返し位置を自動任せにすると「参 / 加できます」のように割れる。改行は自分で決める。
        className="text-center font-bold whitespace-pre-line text-white/85"
        style={{ fontSize: stageSize(STAGE_FONT.caption), lineHeight: 1.25 }}
      >
        {'あとからでも\n参加できます'}
      </p>
    </div>
  );
}
