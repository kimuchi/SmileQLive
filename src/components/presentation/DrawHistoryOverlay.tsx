'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import { drawnStageEntries, drawUnit, type StageDraw } from '@/domain/draw/draw-stage';
import { fitFontSize } from '@/domain/draw/fit-text';
import { formatCount } from '@/lib/format';

/**
 * 引いたものの一覧（GAS 版の HISTORY / WINNERS に相当）。
 *
 * 抽選会では当選者を順位つきで、ビンゴでは出た球を出た順に並べる。
 * 文字の大きさは抽選リストの設定（historyFontSize）を**上限**として、
 * 名前が最後まで入る大きさまで下げる。
 * 会場で聞かれるのは「誰が当たったか」なので、途中で切れては意味がない。
 *
 * 順位以外の通し番号は出さない。何番目に出たかは会場の役に立たず、
 * その幅だけ名前が短くなる。
 */

/** 1 件の枠の内側の余白（左右合計）。 */
const TILE_PADDING = 24;
/** 写真と名前のあいだ。 */
const TILE_GAP = 12;

export function DrawHistoryOverlay({
  draw,
  ordered,
  onClose,
}: {
  draw: StageDraw;
  /** 順位つきで出すか（抽選会）。 */
  ordered: boolean;
  onClose: () => void;
}) {
  const entries = drawnStageEntries(draw).reverse();
  const fontSize = draw.settings.historyFontSize;
  const unit = drawUnit(draw.kind);

  /*
    1 列の幅。文字の大きさから決める（大きい文字のときに 1 行へ詰め込みすぎない）。
    名前を縮める計算もこの幅を基準にする。実際の列はこれ以上に広がりうるので、
    見積もりとしては安全側（少し小さめ）に出る。
  */
  const columnWidth = fontSize * 4;
  /** 順位の札を出す場合に取られる幅。 */
  const badgeWidth = ordered ? fontSize * 1.6 + TILE_GAP : 0;

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
        {ordered ? '当選者' : '出たもの'}（{formatCount(entries.length, unit)}）
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
          className="grid min-h-0 w-full flex-1 list-none overflow-y-auto"
          style={{
            gap: stageSize(16),
            gridTemplateColumns: `repeat(auto-fill, minmax(${stageSize(columnWidth)}, 1fr))`,
            gridAutoRows: 'max-content',
            /*
              件数が少ないときは上下の真ん中へ寄せる。
              上に貼り付くと、下半分が空いたまま投影されて落ち着かない。
              safe を付けているのは、入りきらないときに上端が隠れないようにするため。
            */
            alignContent: 'safe center',
          }}
        >
          {entries.map((entry) => {
            // 写真がある行は、そのぶん名前に使える幅が減る。
            const imageWidth = entry.image ? fontSize * 1.4 + TILE_GAP : 0;
            const labelFontSize = fitFontSize(entry.label, {
              maxWidth: columnWidth - TILE_PADDING - badgeWidth - imageWidth,
              maxFontSize: fontSize,
            });

            return (
              <li
                key={entry.id}
                className="flex items-center overflow-hidden rounded-xl border-2 border-white/20 bg-white/10"
                style={{ padding: stageSize(12), gap: stageSize(TILE_GAP) }}
              >
                {/*
                  順位は抽選会でだけ出す。「何位が当たったか」は会場が知りたいこと。
                  ビンゴ・ルーレットの通し番号は誰も見ないので出さない。
                */}
                {ordered ? (
                  <span
                    className="text-stage-950 inline-flex shrink-0 items-center justify-center rounded-full bg-cyan-300 font-bold tabular-nums"
                    style={{
                      paddingInline: stageSize(10),
                      paddingBlock: stageSize(2),
                      fontSize: stageSize(Math.max(20, fontSize * 0.35)),
                    }}
                  >
                    {entry.order}位
                  </span>
                ) : null}
                {entry.image ? (
                  <StageImage image={entry.image} maxHeightRatio={0.08} className="mx-0 shrink-0" />
                ) : null}
                <span
                  className="min-w-0 font-bold break-words text-white"
                  style={{ fontSize: stageSize(labelFontSize), lineHeight: 1.15 }}
                >
                  {entry.label}
                </span>
              </li>
            );
          })}
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
