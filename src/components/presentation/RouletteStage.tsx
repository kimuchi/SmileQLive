'use client';

import type { RefObject } from 'react';
import { StageBurst, StageConfetti, StageFlash } from '@/components/presentation/StageEffects';
import { STAGE_FONT, stageSize } from '@/components/presentation/stage-theme';
import { arcPath, SegmentLabel } from '@/components/presentation/wheel-graphics';
import { drawUnit, wheelSegments, type StageDraw } from '@/domain/draw/draw-stage';
import { cn } from '@/lib/client/cn';
import { formatInteger } from '@/lib/format';

/**
 * ルーレットの投影。
 *
 * 重みに応じた幅の扇を並べた円盤を、司会の「スタート」で回し、
 * 「ストップ」で当たりの扇が真上の針へ来るように止める。
 *
 * **当たりを決めるのはサーバー。** ストップを押した瞬間に重み付きで引いて記録する。
 * この画面は、決まった扇が針の下へ来る角度を計算して回しているだけで、
 * 結果を先に知って演出しているわけではない。
 *
 * 角度は真上 (12 時) を 0 度として時計回りに数える。
 * 円盤を `rotation` 度回すと、`centerAngle` の扇が真上へ来る。
 */

/** 扇の色。隣り合う扇が同じ色にならないよう、順番に使う。 */
const SEGMENT_COLORS = [
  '#2f82ff',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
] as const;

/** 円盤の半径（1920 基準の px）。 */
const WHEEL_RADIUS = 380;

export function RouletteStage({
  draw,
  wheelRef,
  spinning,
  revealed,
  winnerId,
}: {
  draw: StageDraw;
  /** 円盤の要素。回転は `useRouletteWheel` が直接書き換える。 */
  wheelRef: RefObject<HTMLDivElement | null>;
  spinning: boolean;
  /** 結果を出しているフェーズか。 */
  revealed: boolean;
  /** 当たった扇。回っている最中は null。 */
  winnerId: string | null;
}) {
  const segments = wheelSegments(draw.entries);
  const unit = drawUnit(draw.kind);
  const spinCount = draw.drawn.length;
  const settled = revealed && !spinning && winnerId !== null;
  const winner = winnerId ? draw.entries.find((entry) => entry.id === winnerId) : null;

  return (
    <div className="relative flex h-full w-full flex-col" style={{ gap: stageSize(16) }}>
      {/*
        決まった瞬間の演出。
        光線と輪は**結果の文字の側だけ**に置く（円盤の上まで広げると扇が読みにくい）。
        閃光と紙吹雪は画面全体。
      */}
      {settled ? (
        <>
          <StageFlash burst={draw.latestOrder ?? 0} />
          <StageConfetti burst={draw.latestOrder ?? 0} />
        </>
      ) : null}

      <div className="z-10 flex shrink-0 items-baseline justify-end" style={{ gap: stageSize(24) }}>
        <span
          className="shrink-0 rounded-full bg-black/35 font-bold whitespace-nowrap text-white/75"
          style={{
            fontSize: stageSize(STAGE_FONT.small),
            paddingInline: stageSize(20),
            paddingBlock: stageSize(4),
          }}
        >
          {formatInteger(spinCount)}
          {unit}目 / 全 {formatInteger(draw.entries.length)}項目
        </span>
      </div>

      <div
        className="z-10 flex min-h-0 flex-1 flex-row items-center justify-center"
        style={{ gap: stageSize(56) }}
      >
        <Wheel segments={segments} wheelRef={wheelRef} spinning={spinning} winnerId={winnerId} />

        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col items-start justify-center"
          style={{ gap: stageSize(20) }}
        >
          {settled ? <StageBurst burst={draw.latestOrder ?? 0} /> : null}
          {settled && winner ? (
            <>
              <span
                key={`badge-${draw.latestOrder ?? 0}`}
                className="stage-slam text-stage-950 z-10 shrink-0 rounded-full bg-amber-300 font-bold"
                style={{
                  paddingInline: stageSize(32),
                  paddingBlock: stageSize(8),
                  fontSize: stageSize(STAGE_FONT.small),
                }}
              >
                {formatInteger(draw.latestOrder ?? spinCount)}
                {unit}目の結果
              </span>
              <p
                key={`winner-${draw.latestOrder ?? 0}`}
                className="stage-pop-big stage-shine z-10 w-full font-bold break-words"
                style={{
                  fontSize: stageSize(draw.settings.resultFontSize),
                  lineHeight: 1.1,
                }}
              >
                {winner.label}
              </p>
            </>
          ) : (
            <p
              className={cn(
                'w-full font-bold',
                spinning ? 'text-cyan-200' : 'stage-breathe text-cyan-300',
              )}
              style={{
                fontSize: stageSize(STAGE_FONT.hero),
                lineHeight: 1.2,
                textShadow: '0 0 0.4cqw rgba(103,232,249,0.9)',
              }}
            >
              {spinning ? 'まわっています…' : 'READY'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 円盤そのもの。
 *
 * SVG の円弧で扇を描く。当たりが決まると、当たり以外の扇を薄くして
 * どこで止まったのかが一目で分かるようにする。
 */
function Wheel({
  segments,
  wheelRef,
  spinning,
  winnerId,
}: {
  segments: ReturnType<typeof wheelSegments>;
  wheelRef: RefObject<HTMLDivElement | null>;
  spinning: boolean;
  winnerId: string | null;
}) {
  const size = WHEEL_RADIUS * 2;

  return (
    <div className="relative shrink-0" style={{ width: stageSize(size), height: stageSize(size) }}>
      {/* 針。円盤の外側・真上に固定する。ここへ来た扇が当たり。 */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 z-20 -translate-x-1/2"
        style={{ top: stageSize(-24) }}
      >
        <div
          className={cn('rounded-b-sm bg-amber-300', spinning && 'stage-urgent')}
          style={{
            width: stageSize(28),
            height: stageSize(72),
            clipPath: 'polygon(50% 100%, 0 0, 100% 0)',
            filter: 'drop-shadow(0 0 0.6cqw rgba(252,211,77,0.9))',
          }}
        />
      </div>

      {/*
        回転はこの div へ掛ける。角度は useRouletteWheel が style を直接書き換える
        （毎秒 60 回の再描画を React へ通すと、投影画面の他の表示まで重くなる）。
      */}
      <div
        ref={wheelRef}
        className="h-full w-full will-change-transform"
        style={{ filter: 'drop-shadow(0 0 1.2cqw rgba(0,0,0,0.55))' }}
      >
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="h-full w-full"
          role="img"
          aria-label="ルーレット"
        >
          {segments.map((segment, index) => (
            <g key={segment.entry.id}>
              <path
                d={arcPath(size / 2, size / 2, size / 2 - 8, segment.startAngle, segment.endAngle)}
                fill={SEGMENT_COLORS[index % SEGMENT_COLORS.length]}
                stroke="rgba(255,255,255,0.6)"
                strokeWidth={3}
                opacity={winnerId === null || winnerId === segment.entry.id ? 1 : 0.55}
              />
              <SegmentLabel
                cx={size / 2}
                cy={size / 2}
                radius={size / 2 - 8}
                angle={segment.centerAngle}
                sweep={segment.sweep}
                label={segment.entry.label}
              />
            </g>
          ))}

          {/* 中心のふた。扇の頂点が集まって汚くなるのを隠す。 */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={size * 0.09}
            fill="#0d1530"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth={6}
          />
        </svg>
      </div>
    </div>
  );
}
