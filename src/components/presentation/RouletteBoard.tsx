'use client';

import type { RefObject } from 'react';
import { arcPath, SegmentLabel } from '@/components/presentation/wheel-graphics';
import { rouletteSegments, type RouletteItem } from '@/domain/roulette/wheel';
import { cn } from '@/lib/client/cn';

/**
 * URL だけで回すルーレットの円盤。
 *
 * ルームで回すルーレット（RouletteStage）と違い、投影の枠 (StageFrame) に
 * 乗せない。設定欄と並べて使うため、置かれた場所の幅いっぱいに広がる四角へ収める。
 * 扇の弧と文字の描き方は共通の部品を使う（片方だけ直すと見た目がずれる）。
 *
 * **回転はこの部品では持たない。** `wheelRef` の style を
 * `useRouletteSpin` が毎フレーム書き換える。React へ通すと項目が多いとき重い。
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

/** 描画に使う座標系の大きさ。実際の表示サイズは CSS が決める。 */
const VIEW_SIZE = 760;

export function RouletteBoard({
  items,
  wheelRef,
  spinning,
  showLabels,
  /** 当たった扇。回っている最中は null。 */
  winnerLabel,
}: {
  items: readonly RouletteItem[];
  wheelRef: RefObject<HTMLDivElement | null>;
  spinning: boolean;
  showLabels: boolean;
  winnerLabel: string | null;
}) {
  const segments = rouletteSegments(items);
  const radius = VIEW_SIZE / 2 - 8;

  return (
    <div className="relative aspect-square w-full">
      {/* 針。円盤の外側・真上に固定する。ここへ来た扇が当たり。 */}
      <div
        aria-hidden="true"
        className="absolute top-[-1.5%] left-1/2 z-20 h-[8%] w-[3.5%] -translate-x-1/2"
      >
        <div
          className={cn('h-full w-full bg-amber-300', spinning && 'stage-urgent')}
          style={{
            clipPath: 'polygon(50% 100%, 0 0, 100% 0)',
            filter: 'drop-shadow(0 0 10px rgba(252,211,77,0.9))',
          }}
        />
      </div>

      <div
        ref={wheelRef}
        className="h-full w-full will-change-transform"
        style={{ filter: 'drop-shadow(0 0 20px rgba(0,0,0,0.55))' }}
      >
        <svg
          viewBox={`0 0 ${String(VIEW_SIZE)} ${String(VIEW_SIZE)}`}
          className="h-full w-full"
          role="img"
          aria-label={`ルーレット（${String(segments.length)}項目）`}
        >
          {segments.length === 0 ? (
            <circle
              cx={VIEW_SIZE / 2}
              cy={VIEW_SIZE / 2}
              r={radius}
              fill="#1e293b"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={3}
            />
          ) : null}

          {segments.map((segment, index) => (
            <g key={segment.item.id}>
              <path
                d={arcPath(
                  VIEW_SIZE / 2,
                  VIEW_SIZE / 2,
                  radius,
                  segment.startAngle,
                  segment.endAngle,
                )}
                fill={SEGMENT_COLORS[index % SEGMENT_COLORS.length]}
                stroke="rgba(255,255,255,0.6)"
                strokeWidth={3}
                /*
                  止まったら、当たり以外を薄くしてどこで止まったのかを分かりやすくする。
                  同じ名前の扇が複数あることはあるので、色を戻すのは名前で見る。
                */
                opacity={winnerLabel === null || winnerLabel === segment.item.label ? 1 : 0.5}
              />
              {showLabels ? (
                <SegmentLabel
                  cx={VIEW_SIZE / 2}
                  cy={VIEW_SIZE / 2}
                  radius={radius}
                  angle={segment.centerAngle}
                  sweep={segment.sweep}
                  label={segment.item.label}
                />
              ) : null}
            </g>
          ))}

          {/* 中心のふた。扇の頂点が集まって汚くなるのを隠す。 */}
          <circle
            cx={VIEW_SIZE / 2}
            cy={VIEW_SIZE / 2}
            r={VIEW_SIZE * 0.09}
            fill="#0d1530"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth={6}
          />
        </svg>
      </div>
    </div>
  );
}
