'use client';

import { STAGE_FONT, stageHeightRatio, stageSize } from '@/components/presentation/stage-theme';
import { StageImage } from '@/components/presentation/StageImage';
import {
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
 * - 左に「いま出た球」を大きく
 * - 右に「これまでに出た球」を並べる。参加者は手元の紙のカードと見比べる
 * - 数字のときは B/I/N/G/O の列に分けて並べ、出たものを光らせる
 *   （出ていない数字も枠として出す。「まだ出ていない」が一目で分かるため）
 * - 品目のときは出たものだけを新しい順に並べる（全部出すと写真が小さくなりすぎる）
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

  return (
    <div className="flex h-full w-full flex-col" style={{ gap: stageSize(20) }}>
      {/* 表題は上部のヘッダーが出している。ここで繰り返すとボードが狭くなる。 */}
      <div className="flex shrink-0 items-baseline justify-end" style={{ gap: stageSize(24) }}>
        <span
          className="shrink-0 font-bold whitespace-nowrap text-white/60"
          style={{ fontSize: stageSize(STAGE_FONT.small) }}
        >
          {formatInteger(drawnCount)}
          {unit}目 / 残り {formatInteger(remaining)}
          {unit}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-row items-stretch" style={{ gap: stageSize(40) }}>
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-col items-center justify-center',
            showBoard ? 'flex-[2]' : 'flex-1',
          )}
        >
          <CurrentBall draw={draw} display={display} spinning={spinning} revealed={revealed} />
        </div>

        {showBoard ? (
          <div className="flex min-h-0 min-w-0 flex-[3] flex-col justify-center">
            {draw.kind === 'number' ? <NumberBoard draw={draw} /> : <ItemBoard draw={draw} />}
          </div>
        ) : null}
      </div>
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
      <p
        className={cn(
          'text-center font-bold',
          finished ? 'text-white/60' : 'stage-urgent text-cyan-300',
        )}
        style={{
          fontSize: stageSize(STAGE_FONT.hero),
          lineHeight: 1.2,
          textShadow: finished
            ? 'none'
            : '0 0 0.4cqw rgba(103,232,249,0.9), 0 0 1.2cqw rgba(255,255,255,0.6)',
        }}
      >
        {finished ? 'すべて出ました' : 'READY'}
      </p>
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
    return (
      <div
        key={settled ? `ball-${display.id}` : 'spinning'}
        className={cn(
          'flex aspect-square items-center justify-center rounded-full border-8',
          settled
            ? 'stage-pop border-amber-300 bg-amber-300/15 text-amber-300'
            : 'border-cyan-300 bg-cyan-300/10 text-cyan-300',
        )}
        style={{
          width: stageSize(520),
          maxWidth: '100%',
          boxShadow: settled
            ? '0 0 1.5cqw rgba(252,211,77,0.45)'
            : '0 0 1cqw rgba(103,232,249,0.35)',
        }}
      >
        <span
          className="font-bold tabular-nums"
          style={{ fontSize: stageSize(draw.settings.resultFontSize), lineHeight: 1 }}
        >
          {display.label}
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center"
      style={{ gap: stageSize(20) }}
    >
      {display.image ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <StageImage image={display.image} maxHeightRatio={0.5} fill />
        </div>
      ) : null}
      <p
        key={settled ? `item-${display.id}` : 'spinning'}
        className={cn(
          'w-full shrink-0 text-center font-bold break-words',
          settled ? 'stage-pop text-amber-300' : 'text-cyan-300',
        )}
        style={{
          // 写真があるときは写真が主役。文字を設定どおりの大きさにすると写真が潰れる。
          fontSize: stageSize(
            display.image ? Math.min(140, draw.settings.resultFontSize) : draw.settings.resultFontSize,
          ),
          lineHeight: 1.1,
          textShadow: settled
            ? '0 0 0.4cqw rgba(252,211,77,0.9), 0 0 1.4cqw rgba(255,255,255,0.7)'
            : '0 0 0.3cqw rgba(103,232,249,0.8)',
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
 */
function NumberBoard({ draw }: { draw: StageDraw }) {
  const drawn = drawnEntryIdSet(draw);
  const columns = bingoColumns(draw);
  const latestId = draw.latestEntryId;

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
              className="text-stage-950 shrink-0 rounded-lg bg-white/80 text-center font-bold"
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
                      ? 'stage-pop border-amber-300 bg-amber-300 text-stage-950'
                      : isDrawn
                        ? 'border-cyan-300 bg-cyan-300/25 text-white'
                        : 'border-white/15 text-white/30',
                  )}
                  style={{ fontSize: stageSize(draw.settings.historyFontSize / 2) }}
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
 * 品目のボード。
 *
 * 出たものだけを新しい順に並べる。
 * 全部を並べると 1 つあたりが小さくなりすぎ、会場から何も読めなくなる。
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
    <ul
      // 行の高さは中身なりにする。1 行しか無いときに縦長の帯になるのを避ける。
      className="grid h-full min-h-0 list-none content-start overflow-hidden"
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
            index === 0 ? 'border-amber-300 bg-amber-300/15' : 'border-white/20 bg-white/5',
          )}
          style={{ padding: stageSize(8), gap: stageSize(6) }}
        >
          {entry.image ? (
            <div
              className="flex w-full items-center justify-center"
              style={{ height: stageHeightRatio(0.13) }}
            >
              <StageImage image={entry.image} maxHeightRatio={0.13} fill />
            </div>
          ) : null}
          <span
            className={cn(
              'w-full shrink-0 truncate text-center font-bold',
              index === 0 ? 'text-amber-200' : 'text-white/80',
            )}
            style={{ fontSize: stageSize(STAGE_FONT.caption) }}
          >
            {entry.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
