'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import { drawnStageEntries, type StageDraw } from '@/domain/draw/draw-stage';
import { formatCount } from '@/lib/format';

/**
 * 引いたものの一覧（GAS 版の HISTORY / WINNERS に相当）。
 *
 * 抽選会では当選者を順位つきで、ビンゴでは出た球を出た順に並べる。
 * 文字の大きさは抽選リストの設定（historyFontSize）に従う。
 * 会場の広さと件数によって、読める大きさが変わるため。
 *
 * 会場では「さっき誰が当たったか」を聞かれることが多い。
 * 司会が言い直さなくても済むよう、投影側からいつでも出せるようにしている。
 */
export function DrawHistoryOverlay({
  draw,
  ordered,
  onClose,
}: {
  draw: StageDraw;
  /** 順位つきで出すか（抽選会）。ビンゴでは出た順の番号として出す。 */
  ordered: boolean;
  onClose: () => void;
}) {
  const entries = drawnStageEntries(draw).reverse();
  const fontSize = draw.settings.historyFontSize;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/95"
      style={{ padding: stageSize(48), gap: stageSize(20) }}
    >
      <h2
        className="shrink-0 font-bold text-cyan-300"
        style={{
          fontSize: stageSize(STAGE_FONT.heading),
          textShadow: '0 0 0.4cqw rgba(103,232,249,0.8)',
        }}
      >
        {ordered ? '当選者' : '出た球'}（{formatCount(entries.length)}）
      </h2>

      {entries.length === 0 ? (
        <p
          className="flex flex-1 items-center font-bold text-white/50"
          style={{ fontSize: stageSize(STAGE_FONT.heading) }}
        >
          まだ 1 件も引いていません
        </p>
      ) : (
        <ul
          className="grid w-full min-h-0 flex-1 list-none overflow-y-auto"
          style={{
            gap: stageSize(16),
            // 1 件あたりの幅を文字の大きさから決める。
            // 大きい文字にしたときに 1 行へ詰め込みすぎないため。
            gridTemplateColumns: `repeat(auto-fill, minmax(${stageSize(fontSize * 4)}, 1fr))`,
            gridAutoRows: 'max-content',
          }}
        >
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center overflow-hidden rounded-xl border-2 border-white/20 bg-white/10"
              style={{ padding: stageSize(12), gap: stageSize(12) }}
            >
              <span
                className="text-stage-950 inline-flex shrink-0 items-center justify-center rounded-full bg-cyan-300 font-bold tabular-nums"
                style={{
                  minWidth: stageSize(fontSize),
                  paddingInline: stageSize(10),
                  paddingBlock: stageSize(2),
                  fontSize: stageSize(Math.max(20, fontSize * 0.35)),
                }}
              >
                {ordered ? `${entry.order}位` : entry.order}
              </span>
              {entry.image ? (
                <StageImage image={entry.image} maxHeightRatio={0.08} className="mx-0 shrink-0" />
              ) : null}
              <span
                className="min-w-0 truncate font-bold text-white"
                style={{ fontSize: stageSize(fontSize) }}
              >
                {entry.label}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded-lg border border-white/40 font-bold text-white"
        style={{
          paddingInline: stageSize(48),
          paddingBlock: stageSize(12),
          fontSize: stageSize(STAGE_FONT.body),
        }}
      >
        閉じる
      </button>
    </div>
  );
}
