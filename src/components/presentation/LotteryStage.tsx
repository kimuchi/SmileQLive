'use client';

import { StageCelebration } from '@/components/presentation/StageEffects';
import { STAGE_FONT, stageHeightRatio, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import { drawLayoutOf } from '@/domain/draw/draw-list';
import { fitFontSize } from '@/domain/draw/fit-text';
import {
  drawUnit,
  drawnStageEntries,
  type StageDraw,
  type StageDrawEntry,
} from '@/domain/draw/draw-stage';
import { cn } from '@/lib/client/cn';
import { formatInteger } from '@/lib/format';

/**
 * 抽選会の投影。
 *
 * GAS 版の抽選アプリと同じ流れを踏襲しつつ、会場で盛り上がるように演出を足している。
 * - 回している間は候補が縦に流れる（回転しているように見せる枠を出す）
 * - 止まった瞬間に閃光・光線・紙吹雪、当選者の名前が金色に光る
 * - 「◯人目の当選」の札が勢いよく決まる
 * - 下に「残り何人か」
 *
 * 文字の大きさは抽選リストの設定（resultFontSize）に従う。
 * 会場の広さ・名前の長さによって見やすい大きさが変わるため。
 *
 * **次に誰が当たるかはこの画面に入っていない。**
 * 当選はサーバーが引く操作を受けた瞬間に決めて記録し、ここはそれを見せるだけ。
 */

/** 右の一覧の 1 行の文字の大きさ（1920 基準の px）。 */
const WINNER_FONT_SIZE = 44;
/** 1 行の上下の余白。 */
const WINNER_ROW_PADDING = 10;
/** 行と行のあいだ。 */
const WINNER_ROW_GAP = 10;
/**
 * 一覧に使える高さ（1920×1080 基準の px）。
 *
 * 画面の高さから、投影の余白・上の件数表示・見出しを引いたおおよその値。
 * 何件入るかをここから数える。
 */
const WINNER_LIST_HEIGHT = 800;
/** 名前に使える幅。右の列の幅から、順番の数字と余白を引いたおおよその値。 */
const WINNER_NAME_WIDTH = 560;

export function LotteryStage({
  draw,
  display,
  spinning,
  revealed,
}: {
  draw: StageDraw;
  /** いま画面に出すもの。回している間は候補が次々に入れ替わる。 */
  display: StageDrawEntry | null;
  spinning: boolean;
  /** 結果を出しているフェーズか。false なら「READY」を出す。 */
  revealed: boolean;
}) {
  const total = draw.entries.length;
  const drawnCount = draw.drawn.length;
  const remaining = draw.remainingCount;
  const finished = remaining === 0 && drawnCount > 0;
  const unit = drawUnit(draw.kind);
  const settled = revealed && !spinning && display !== null;
  const layout = drawLayoutOf(draw.settings);

  // 一覧だけを出すモード。当選者を貼り出しておく使い方。
  if (layout === 'list') {
    return <WinnerListStage draw={draw} drawnCount={drawnCount} total={total} unit={unit} />;
  }

  // 当選者を右に並べる見せ方。会場から「誰が当たったか」を追える。
  const showWinners = layout === 'board';

  return (
    <div className="relative flex h-full w-full flex-col" style={{ gap: stageSize(24) }}>
      {settled ? <StageCelebration burst={draw.latestOrder ?? 0} /> : null}

      {/*
        表題は出さない。会場のスクリーンには、
        いちばん見せたいもの（当選者）だけを大きく出す。
      */}
      <div className="z-10 flex shrink-0 items-baseline justify-end" style={{ gap: stageSize(24) }}>
        <span
          className="shrink-0 rounded-full bg-black/35 font-bold whitespace-nowrap text-white/75"
          style={{
            fontSize: stageSize(STAGE_FONT.small),
            paddingInline: stageSize(20),
            paddingBlock: stageSize(4),
          }}
        >
          残り {formatInteger(remaining)}
          {unit} / 全 {formatInteger(total)}
          {unit}
        </span>
      </div>

      <div
        className="z-10 flex min-h-0 flex-1 flex-row items-stretch"
        style={{ gap: stageSize(32) }}
      >
        <div
          className="flex min-h-0 min-w-0 flex-[3] flex-col items-center justify-center overflow-hidden"
          style={{ gap: stageSize(20) }}
        >
          {settled && display ? (
            <span
              key={`ordinal-${display.id}`}
              className="stage-slam text-stage-950 shrink-0 rounded-full bg-amber-300 font-bold"
              style={{
                paddingInline: stageSize(40),
                paddingBlock: stageSize(10),
                fontSize: stageSize(STAGE_FONT.small),
                boxShadow: '0 0 1.6cqw rgba(252,211,77,0.7)',
              }}
            >
              {formatOrdinal(display, drawnCount, unit)}
            </span>
          ) : null}

          <DrawHeadline
            draw={draw}
            display={display}
            spinning={spinning}
            revealed={revealed}
            finished={finished}
          />
        </div>

        {showWinners ? <WinnerSideList draw={draw} unit={unit} /> : null}
      </div>
    </div>
  );
}

/**
 * 右側に並べる当選者。
 *
 * **新しい順**に並べる。会場が知りたいのは「いま誰が当たったか」で、
 * 古い当選は下へ流れていってよい。
 *
 * 入りきらないぶんは出さない。小さくして詰め込むと、
 * 会場の後方からどれも読めなくなる。何人ぶん隠れているかは見出しに出す。
 */
function WinnerSideList({ draw, unit }: { draw: StageDraw; unit: string }) {
  const drawn = drawnStageEntries(draw);
  const latest = [...drawn].reverse();

  /*
    入る件数は高さから決める。
    投影は 1920×1080 を基準に比例するので、ここも基準の px で数えれば
    実際の投影機の解像度に関わらず同じ件数になる。
  */
  const rowHeight = WINNER_FONT_SIZE * 1.2 + WINNER_ROW_PADDING * 2 + WINNER_ROW_GAP;
  const capacity = Math.max(1, Math.floor(WINNER_LIST_HEIGHT / rowHeight));
  const shown = latest.slice(0, capacity);
  const hidden = latest.length - shown.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-[2] flex-col" style={{ gap: stageSize(12) }}>
      <div className="flex shrink-0 items-baseline justify-between" style={{ gap: stageSize(12) }}>
        <h2
          className="font-bold whitespace-nowrap text-amber-200"
          style={{ fontSize: stageSize(STAGE_FONT.small) }}
        >
          当選者
        </h2>
        <span
          className="shrink-0 font-bold whitespace-nowrap text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.caption) }}
        >
          {hidden > 0
            ? `新しい ${formatInteger(shown.length)}${unit}（ほか ${formatInteger(hidden)}${unit}）`
            : `${formatInteger(drawn.length)}${unit}`}
        </span>
      </div>

      {shown.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center text-center font-bold text-white/35"
          style={{ fontSize: stageSize(STAGE_FONT.body) }}
        >
          まだ抽選していません
        </p>
      ) : (
        <ol
          className="flex min-h-0 flex-1 list-none flex-col overflow-hidden"
          style={{ gap: stageSize(WINNER_ROW_GAP) }}
        >
          {shown.map((entry) => {
            const isLatest = entry.id === draw.latestEntryId;
            return (
              <li
                key={entry.id}
                className={cn(
                  'flex shrink-0 items-center overflow-hidden rounded-xl border-2 font-bold',
                  isLatest
                    ? 'stage-mark text-stage-950 border-amber-200 bg-amber-300'
                    : 'border-white/15 bg-white/5 text-white/85',
                )}
                style={{
                  gap: stageSize(12),
                  paddingInline: stageSize(14),
                  paddingBlock: stageSize(WINNER_ROW_PADDING),
                  ...(isLatest ? { boxShadow: '0 0 1.2cqw rgba(252,211,77,0.7)' } : {}),
                }}
              >
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
                    isLatest ? 'text-stage-950/70' : 'text-white/40',
                  )}
                  style={{ fontSize: stageSize(STAGE_FONT.caption) }}
                >
                  {entry.order}
                </span>
                <span
                  className="min-w-0 flex-1 break-words"
                  style={{
                    // 名前が最後まで入る大きさまで下げる。切れては出す意味がない。
                    fontSize: stageSize(
                      fitFontSize(entry.label, {
                        maxWidth: WINNER_NAME_WIDTH,
                        maxFontSize: WINNER_FONT_SIZE,
                      }),
                    ),
                    lineHeight: 1.15,
                  }}
                >
                  {entry.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * 当選者の一覧だけを出す画面。
 *
 * 抽選が一巡したあと、会場に貼り出しておく使い方を想定する。
 * 当選した順に並べ、いちばん新しい当選だけ色を変える。
 */
function WinnerListStage({
  draw,
  drawnCount,
  total,
  unit,
}: {
  draw: StageDraw;
  drawnCount: number;
  total: number;
  unit: string;
}) {
  const drawn = drawnStageEntries(draw);
  const latestId = draw.latestEntryId;

  /*
    列数は人数から決めて画面いっぱいに広げる。固定だと 10 人で下が真っ白になる。
    名前は横に長いので、升目は横長でよい（1 列あたりを広く取る）。
  */
  const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(drawn.length / 2))));
  const fontSize =
    columns >= 5 ? STAGE_FONT.body : columns >= 3 ? STAGE_FONT.choice : STAGE_FONT.heading;

  return (
    <div className="flex h-full w-full flex-col" style={{ gap: stageSize(20) }}>
      <div className="flex shrink-0 items-baseline justify-between" style={{ gap: stageSize(24) }}>
        <h2
          className="font-bold text-amber-200"
          style={{ fontSize: stageSize(STAGE_FONT.heading), lineHeight: 1.1 }}
        >
          当選者
        </h2>
        <span
          className="shrink-0 rounded-full bg-black/35 font-bold whitespace-nowrap text-white/75"
          style={{
            fontSize: stageSize(STAGE_FONT.small),
            paddingInline: stageSize(20),
            paddingBlock: stageSize(4),
          }}
        >
          {formatInteger(drawnCount)}
          {unit} / 全 {formatInteger(total)}
          {unit}
        </span>
      </div>

      {drawn.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center text-center font-bold text-white/50"
          style={{ fontSize: stageSize(STAGE_FONT.heading) }}
        >
          まだ抽選していません
        </p>
      ) : (
        <ol
          className="grid min-h-0 flex-1 list-none overflow-hidden"
          style={{
            gap: stageSize(12),
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            // 行も伸ばして高さを使い切る。会場の後ろからは大きいほど読める。
            gridAutoRows: 'minmax(0, 1fr)',
            // ただし 1 枚が大きくなりすぎないよう上限を付ける（下の maxHeight）。
            // 3 件しか無いときに巨大な板が並ぶのを避ける。
            alignItems: 'center',
          }}
        >
          {drawn.map((entry, index) => {
            const isLatest = entry.id === latestId;
            return (
              <li
                key={entry.id}
                className={cn(
                  'flex items-center overflow-hidden rounded-xl border-2 font-bold',
                  isLatest
                    ? 'stage-mark text-stage-950 border-amber-200 bg-amber-300'
                    : 'border-white/20 bg-white/5 text-white/85',
                )}
                style={{
                  gap: stageSize(12),
                  paddingInline: stageSize(14),
                  paddingBlock: stageSize(10),
                  height: '100%',
                  maxHeight: stageHeightRatio(0.2),
                  ...(isLatest ? { boxShadow: '0 0 1.2cqw rgba(252,211,77,0.8)' } : {}),
                }}
              >
                <span
                  className={cn(
                    'shrink-0 tabular-nums',
                    isLatest ? 'text-stage-950/70' : 'text-white/45',
                  )}
                  style={{ fontSize: stageSize(STAGE_FONT.caption) }}
                >
                  {index + 1}
                </span>
                <span className="w-full truncate" style={{ fontSize: stageSize(fontSize) }}>
                  {entry.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** 何人目の当選かを示す文言。単位はリストの種類に合わせる。 */
function formatOrdinal(
  display: StageDrawEntry & { order?: number },
  fallback: number,
  unit: string,
): string {
  const order = typeof display.order === 'number' ? display.order : fallback;
  return `${formatInteger(order)}${unit}目の当選`;
}

/**
 * 中央の巨大な表示。
 *
 * 回している間・止まったあと・まだ引く前で、見え方をはっきり変える。
 * 会場の後方からは文字の形より「動きと色が変わったこと」のほうが先に伝わる。
 */
function DrawHeadline({
  draw,
  display,
  spinning,
  revealed,
  finished,
}: {
  draw: StageDraw;
  display: StageDrawEntry | null;
  spinning: boolean;
  revealed: boolean;
  finished: boolean;
}) {
  const settled = revealed && !spinning;

  if (!revealed && !spinning) {
    if (finished) {
      return (
        <p
          className="text-center font-bold text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.2 }}
        >
          抽選は終了しました
        </p>
      );
    }
    return (
      <p
        className="stage-breathe text-center font-bold text-cyan-300"
        style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.2 }}
      >
        READY
      </p>
    );
  }

  if (!display) {
    return (
      <p
        className="text-center font-bold text-white/60"
        style={{ fontSize: stageSize(STAGE_FONT.heading) }}
      >
        抽選の準備をしています
      </p>
    );
  }

  const fontSize = stageSize(
    display.image ? Math.min(140, draw.settings.resultFontSize) : draw.settings.resultFontSize,
  );

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center"
      style={{ gap: stageSize(20) }}
    >
      {/* 品目の抽選では写真が主役。名簿の抽選では画像を持たないので出ない。 */}
      {display.image ? (
        <div
          key={settled ? `image-${display.id}` : 'image-spinning'}
          className={cn(
            'flex min-h-0 flex-1 items-center justify-center',
            settled ? 'stage-drop' : '',
          )}
        >
          <StageImage image={display.image} maxHeightRatio={0.45} fill />
        </div>
      ) : null}

      {spinning ? (
        // 回している最中。窓の中を候補が流れていくように見せる。
        <div
          className="flex w-full shrink-0 items-center justify-center overflow-hidden rounded-3xl border-2 border-cyan-300/50 bg-cyan-300/5"
          style={{
            paddingBlock: stageSize(16),
            boxShadow: 'inset 0 0 2cqw rgba(103,232,249,0.25)',
          }}
        >
          <p
            key={display.id}
            className="stage-reel w-full text-center font-bold break-words text-cyan-200"
            style={{
              fontSize,
              lineHeight: 1.1,
              textShadow: '0 0 0.3cqw rgba(103,232,249,0.8)',
            }}
          >
            {display.label}
          </p>
        </div>
      ) : (
        // 決まったあと。金色に光らせ、一度だけ大きく弾ませる。
        <p
          key={`settled-${display.id}`}
          className="stage-pop-big stage-shine w-full shrink-0 text-center font-bold break-words"
          style={{ fontSize, lineHeight: 1.1 }}
        >
          {display.label}
        </p>
      )}
    </div>
  );
}
