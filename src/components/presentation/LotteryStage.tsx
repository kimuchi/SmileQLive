'use client';

import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import { drawUnit, type StageDraw, type StageDrawEntry } from '@/domain/draw/draw-stage';
import { cn } from '@/lib/client/cn';
import { formatInteger } from '@/lib/format';

/**
 * 抽選会の投影。
 *
 * GAS 版の抽選アプリと同じ見え方にしている。
 * - 回している間は候補が高速で切り替わり、水色に光る
 * - 止まったら当選者が金色で大きく出る
 * - 下に「何人目か」と「残り何人か」
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

  return (
    <div className="flex h-full w-full flex-col" style={{ gap: stageSize(24) }}>
      {/*
        表題は上部のヘッダーがすでに出している。ここで繰り返すと、
        いちばん見せたい当選者の場所が狭くなるだけなので出さない。
      */}
      <div className="flex shrink-0 items-baseline justify-end" style={{ gap: stageSize(24) }}>
        <span
          className="shrink-0 font-bold whitespace-nowrap text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.small) }}
        >
          残り {formatInteger(remaining)}
          {unit} / 全 {formatInteger(total)}
          {unit}
        </span>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden"
        style={{ gap: stageSize(20) }}
      >
        {revealed && !spinning && display ? (
          <span
            className="text-stage-950 shrink-0 rounded-full bg-amber-300 font-bold"
            style={{
              paddingInline: stageSize(40),
              paddingBlock: stageSize(10),
              fontSize: stageSize(STAGE_FONT.small),
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
 * 回している間・止まったあと・まだ引く前で、色と光り方を変える。
 * 会場の後方からは文字の形より「色が変わったこと」のほうが先に伝わる。
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
        className="stage-urgent text-center font-bold text-cyan-300"
        style={{
          fontSize: stageSize(STAGE_FONT.hero),
          lineHeight: 1.2,
          textShadow: '0 0 0.4cqw rgba(103,232,249,0.9), 0 0 1.2cqw rgba(255,255,255,0.6)',
        }}
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

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center"
      style={{ gap: stageSize(20) }}
    >
      {/* 品目の抽選では写真が主役。名簿の抽選では画像を持たないので出ない。 */}
      {display.image ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <StageImage image={display.image} maxHeightRatio={0.45} fill />
        </div>
      ) : null}

      <p
        // stage-pop: 止まった瞬間に一度だけ弾ませる。切り替わりを見逃させない。
        key={settled ? `settled-${display.id}` : 'spinning'}
        className={cn(
          'w-full shrink-0 text-center font-bold break-words',
          settled ? 'stage-pop text-amber-300' : 'text-cyan-300',
        )}
        style={{
          // 写真があるときは写真が主役。文字を設定どおりにすると写真が潰れる。
          fontSize: stageSize(
            display.image ? Math.min(140, draw.settings.resultFontSize) : draw.settings.resultFontSize,
          ),
          lineHeight: 1.1,
          textShadow: settled
            ? '0 0 0.4cqw rgba(252,211,77,0.9), 0 0 1.4cqw rgba(255,255,255,0.7)'
            : '0 0 0.3cqw rgba(103,232,249,0.8), 0 0 1cqw rgba(255,255,255,0.5)',
        }}
      >
        {display.label}
      </p>
    </div>
  );
}
