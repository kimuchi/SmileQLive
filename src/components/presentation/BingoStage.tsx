'use client';

import { BingoBall, BingoCage } from '@/components/presentation/BingoBall';
import { StageBurst, StageConfetti, StageFlash } from '@/components/presentation/StageEffects';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import {
  bingoColumnOf,
  bingoColumns,
  drawUnit,
  drawnEntryIdSet,
  drawnStageEntries,
  type StageDraw,
  type StageDrawEntry,
} from '@/domain/draw/draw-stage';
import { cn } from '@/lib/client/cn';
import { formatInteger } from '@/lib/format';

/**
 * ビンゴの投影。
 *
 * 出てくるものが数字のときと、文字＋画像（景品など）のときの両方を扱う。
 *
 * 見せ方の考え方:
 * - **ビンゴに見えること**を最優先にする。数字が変わるだけの画面にしない。
 *   抽選中は球がかごの中で回り、決まると球が上から落ちてきて弾む。
 * - 左に「いま出た球」を大きく、右に「これまでに出た球」を並べる。
 *   参加者は手元の紙のカードと見比べるので、盤面は常に見えている必要がある。
 * - 数字のときは B/I/N/G/O の列に分けて並べ、出たものを光らせる。
 *   出ていない数字も枠として出す（「まだ出ていない」が一目で分かる）。
 * - 品目のときは出たものだけを新しい順に並べる（全部出すと写真が小さくなりすぎる）。
 * - 下に「出た順」の球を並べる。ビンゴ機の受け皿に相当する。
 */
export function BingoStage({
  draw,
  display,
  spinning,
  revealed,
}: {
  draw: StageDraw;
  display: StageDrawEntry | null;
  spinning: boolean;
  revealed: boolean;
}) {
  const remaining = draw.remainingCount;
  const drawnCount = draw.drawn.length;
  const showBoard = draw.settings.showBoard;
  const unit = drawUnit(draw.kind);
  const settled = revealed && !spinning && display !== null;

  return (
    <div className="relative flex h-full w-full flex-col" style={{ gap: stageSize(16) }}>
      {/*
        決まった瞬間の演出。
        光線と輪は**球の側だけ**に置く（盤面の上まで広げると数字が白く飛ぶ）。
        閃光と紙吹雪は画面全体。こちらは薄いので数字を潰さない。
      */}
      {settled ? (
        <>
          <StageFlash burst={draw.latestOrder ?? 0} />
          <StageConfetti burst={draw.latestOrder ?? 0} />
        </>
      ) : null}

      {/* 表題は上部のヘッダーが出している。ここで繰り返すとボードが狭くなる。 */}
      <div className="z-10 flex shrink-0 items-baseline justify-end" style={{ gap: stageSize(24) }}>
        <span
          className="shrink-0 rounded-full bg-black/35 font-bold whitespace-nowrap text-white/75"
          style={{
            fontSize: stageSize(STAGE_FONT.small),
            paddingInline: stageSize(20),
            paddingBlock: stageSize(4),
          }}
        >
          {formatInteger(drawnCount)}
          {unit}目 / 残り {formatInteger(remaining)}
          {unit}
        </span>
      </div>

      <div
        className="z-10 flex min-h-0 flex-1 flex-row items-stretch"
        style={{ gap: stageSize(40) }}
      >
        <div
          className={cn(
            'relative flex min-h-0 min-w-0 flex-col items-center justify-center',
            // 数字のときは盤（5 列 x 15 行）が主役。品目のときは出たものの名前と写真が主役。
            showBoard ? (draw.kind === 'number' ? 'flex-[2]' : 'flex-[3]') : 'flex-1',
          )}
          style={{ gap: stageSize(20) }}
        >
          {settled ? <StageBurst burst={draw.latestOrder ?? 0} /> : null}
          <div className="z-10 flex flex-col items-center" style={{ gap: stageSize(20) }}>
            <CurrentBall draw={draw} display={display} spinning={spinning} revealed={revealed} />
          </div>
        </div>

        {showBoard ? (
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-col justify-center',
              draw.kind === 'number' ? 'flex-[3]' : 'flex-[2]',
            )}
          >
            {draw.kind === 'number' ? <NumberBoard draw={draw} /> : <ItemBoard draw={draw} />}
          </div>
        ) : null}
      </div>

      {/* 受け皿。出た順に球が並ぶ。ビンゴ機の見た目に寄せる。 */}
      {draw.kind === 'number' ? <BallTray draw={draw} /> : null}
    </div>
  );
}

/** いま出た球。 */
function CurrentBall({
  draw,
  display,
  spinning,
  revealed,
}: {
  draw: StageDraw;
  display: StageDrawEntry | null;
  spinning: boolean;
  revealed: boolean;
}) {
  const settled = revealed && !spinning;

  if (!revealed && !spinning) {
    const finished = draw.remainingCount === 0 && draw.drawn.length > 0;
    return (
      <div className="flex flex-col items-center" style={{ gap: stageSize(24) }}>
        {!finished && draw.kind === 'number' ? <BingoCage size={340} spinning={false} /> : null}
        <p
          className={cn(
            'text-center font-bold',
            finished ? 'text-white/60' : 'stage-breathe text-cyan-300',
          )}
          style={{ fontSize: stageSize(STAGE_FONT.hero), lineHeight: 1.2 }}
        >
          {finished ? 'すべて出ました' : 'READY'}
        </p>
      </div>
    );
  }

  if (!display) {
    return (
      <p
        className="text-center font-bold text-white/60"
        style={{ fontSize: stageSize(STAGE_FONT.heading) }}
      >
        準備をしています
      </p>
    );
  }

  if (draw.kind === 'number') {
    // 回している間はかごの中。決まったら球が落ちてくる。
    if (!settled) {
      return (
        <div className="flex flex-col items-center" style={{ gap: stageSize(20) }}>
          <BingoCage size={420} spinning={spinning} />
          <p
            className="text-center font-bold text-cyan-200"
            style={{
              fontSize: stageSize(STAGE_FONT.emphasis),
              lineHeight: 1,
              textShadow: '0 0 0.5cqw rgba(103,232,249,0.9), 0 0 1.6cqw rgba(255,255,255,0.45)',
            }}
          >
            <span key={display.id} className="stage-reel inline-block tabular-nums">
              {display.label}
            </span>
          </p>
        </div>
      );
    }

    return (
      <BingoBall
        key={`ball-${display.id}`}
        label={display.label}
        column={bingoColumnOf(draw, display.id)}
        size={480}
        settled
        spinning={false}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center"
      style={{ gap: stageSize(20) }}
    >
      {display.image ? (
        <div
          key={settled ? `image-${display.id}` : 'image-spinning'}
          className={cn(
            'flex min-h-0 flex-1 items-center justify-center',
            settled ? 'stage-drop' : '',
          )}
        >
          <StageImage image={display.image} maxHeightRatio={0.5} fill />
        </div>
      ) : null}
      <p
        key={settled ? `item-${display.id}` : `spin-${display.id}`}
        className={cn(
          'w-full shrink-0 text-center font-bold break-words',
          settled ? 'stage-pop-big stage-shine' : 'stage-reel text-cyan-300',
        )}
        style={{
          // 写真があるときは写真が主役。文字を設定どおりの大きさにすると写真が潰れる。
          fontSize: stageSize(
            display.image
              ? Math.min(140, draw.settings.resultFontSize)
              : draw.settings.resultFontSize,
          ),
          lineHeight: 1.1,
          ...(settled ? {} : { textShadow: '0 0 0.3cqw rgba(103,232,249,0.8)' }),
        }}
      >
        {display.label}
      </p>
    </div>
  );
}

/**
 * 数字のボード。
 *
 * 出ていない数字も枠として並べる。参加者は手元のカードと見比べるので、
 * 「まだ出ていない」が見えることに意味がある。
 * 出た瞬間のマスはめくれて光る（どこが増えたのか探さなくて済む）。
 */
function NumberBoard({ draw }: { draw: StageDraw }) {
  const drawn = drawnEntryIdSet(draw);
  const columns = bingoColumns(draw);
  const latestId = draw.latestEntryId;

  /** 見出しの色。球の色と揃えると、盤と球が同じものだと分かる。 */
  const headerColor: Record<string, string> = {
    B: 'bg-blue-600 text-white',
    I: 'bg-red-600 text-white',
    N: 'bg-slate-100 text-stage-950',
    G: 'bg-green-600 text-white',
    O: 'bg-amber-500 text-stage-950',
  };

  return (
    <div className="flex h-full min-h-0 items-stretch" style={{ gap: stageSize(12) }}>
      {columns.map((column, columnIndex) => (
        <div
          key={column.label ?? columnIndex}
          className="flex min-h-0 flex-1 flex-col"
          style={{ gap: stageSize(8) }}
        >
          {column.label ? (
            <div
              className={cn(
                'shrink-0 rounded-lg text-center font-bold',
                headerColor[column.label] ?? 'text-stage-950 bg-white/80',
              )}
              style={{ fontSize: stageSize(STAGE_FONT.body), paddingBlock: stageSize(4) }}
            >
              {column.label}
            </div>
          ) : null}
          <div
            className="grid min-h-0 flex-1"
            style={{
              gap: stageSize(6),
              gridTemplateRows: `repeat(${column.entries.length}, minmax(0, 1fr))`,
            }}
          >
            {column.entries.map((entry) => {
              const isDrawn = drawn.has(entry.id);
              const isLatest = entry.id === latestId;
              return (
                <div
                  key={entry.id}
                  className={cn(
                    'flex items-center justify-center rounded-md border-2 font-bold tabular-nums',
                    isLatest
                      ? 'stage-mark text-stage-950 border-amber-200 bg-amber-300'
                      : isDrawn
                        ? 'border-cyan-300 bg-cyan-300/25 text-white'
                        : 'border-white/15 text-white/30',
                  )}
                  style={{
                    fontSize: stageSize(draw.settings.historyFontSize / 2),
                    ...(isLatest
                      ? { boxShadow: '0 0 1.2cqw rgba(252,211,77,0.85)' }
                      : isDrawn
                        ? { boxShadow: '0 0 0.4cqw rgba(103,232,249,0.35)' }
                        : {}),
                  }}
                >
                  {entry.label}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 受け皿。出た球を出た順に並べる。
 *
 * 盤面は「どの数字が出たか」を見るためのもの。こちらは「さっき何が出たか」を
 * 見るためのもので、遅れて顔を上げた人がすぐ追いつける。
 */
function BallTray({ draw }: { draw: StageDraw }) {
  const drawn = drawnStageEntries(draw).slice(-12);
  if (drawn.length === 0) {
    return null;
  }

  return (
    <div
      className="z-10 flex shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/25"
      style={{ gap: stageSize(10), padding: stageSize(10) }}
    >
      {drawn.map((entry, index) => (
        <div
          key={entry.id}
          className={index === drawn.length - 1 ? 'stage-pop' : ''}
          style={{ opacity: index === drawn.length - 1 ? 1 : 0.55 }}
        >
          <BingoBall
            label={entry.label}
            column={bingoColumnOf(draw, entry.id)}
            size={72}
            settled={false}
            spinning={false}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * 品目のボード。
 *
 * 出たものだけを新しい順に並べる。
 * 全部を並べると 1 つあたりが小さくなりすぎ、会場から何も読めなくなる。
 *
 * **写真は出さない。** 写真は「いま出たもの」を大きく見せる左側の役目で、
 * ここは「もう出たかどうか」を手元のカードと見比べるための一覧。
 * 小さな写真を並べても会場からは読み取れず、名前の入る幅を奪うだけだった。
 */
function ItemBoard({ draw }: { draw: StageDraw }) {
  const drawn = drawnStageEntries(draw).reverse();

  if (drawn.length === 0) {
    return (
      <p
        className="flex h-full items-center justify-center text-center font-bold text-white/40"
        style={{ fontSize: stageSize(STAGE_FONT.body) }}
      >
        まだ何も出ていません
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col justify-center" style={{ gap: stageSize(12) }}>
      <p
        className="shrink-0 font-bold text-white/50"
        style={{ fontSize: stageSize(STAGE_FONT.caption) }}
      >
        出たもの
      </p>
      <ul
        // 高さは中身なりにする。1〜2 件しか無いときに縦長の帯になるのを避ける。
        className="grid max-h-full min-h-0 list-none content-start overflow-hidden"
        style={{
          gap: stageSize(12),
          gridTemplateColumns: 'repeat(auto-fill, minmax(12cqw, 1fr))',
          gridAutoRows: 'max-content',
        }}
      >
        {drawn.slice(0, 18).map((entry, index) => (
          <li
            key={entry.id}
            className={cn(
              'flex min-h-0 flex-col items-center justify-center overflow-hidden rounded-xl border-2',
              index === 0
                ? 'stage-mark border-amber-300 bg-amber-300/15'
                : 'border-white/20 bg-white/5',
            )}
            style={{ padding: stageSize(8), gap: stageSize(6) }}
          >
            <span
              className={cn(
                'w-full shrink-0 truncate text-center font-bold',
                index === 0 ? 'text-amber-200' : 'text-white/80',
              )}
              style={{ fontSize: stageSize(STAGE_FONT.body) }}
            >
              {entry.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
