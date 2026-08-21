'use client';

import { StageCelebration } from '@/components/presentation/StageEffects';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import { drawUnit, type StageDraw, type StageDrawEntry } from '@/domain/draw/draw-stage';
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

  return (
    <div className="relative flex h-full w-full flex-col" style={{ gap: stageSize(24) }}>
      {settled ? <StageCelebration burst={draw.latestOrder ?? 0} /> : null}

      {/*
        表題は上部のヘッダーがすでに出している。ここで繰り返すと、
        いちばん見せたい当選者の場所が狭くなるだけなので出さない。
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
        className="z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden"
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
