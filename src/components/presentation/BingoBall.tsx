'use client';

import { stageSize } from '@/components/presentation/stage-theme';
import { cn } from '@/lib/client/cn';

/**
 * ビンゴの球。
 *
 * 本物のビンゴ機から出てくる球に寄せる。会場の人が一目で
 * 「ビンゴをやっている」と分かることが、この画面のいちばんの仕事。
 *
 * - 列（B/I/N/G/O）ごとに色を変える。これはビンゴの決まり事で、
 *   青・赤・白・緑・黄の順。手元の紙のカードと照らし合わせやすくなる。
 * - 立体に見せるため、上からの光と下からの照り返しを重ねる。
 * - 数字は白い面の上に黒で置く。球の色に関係なく読めるようにする。
 */

/** 列ごとの球の色。ビンゴの慣習に合わせる。 */
const COLUMN_COLORS: Record<string, { base: string; rim: string; ink: string }> = {
  B: { base: '#1d4ed8', rim: '#93c5fd', ink: '#1e3a8a' },
  I: { base: '#dc2626', rim: '#fca5a5', ink: '#7f1d1d' },
  N: { base: '#e2e8f0', rim: '#ffffff', ink: '#0f172a' },
  G: { base: '#16a34a', rim: '#86efac', ink: '#14532d' },
  O: { base: '#f59e0b', rim: '#fde68a', ink: '#78350f' },
};

/** 列が決まらないとき（1〜75 でない範囲）の色。 */
const NEUTRAL = { base: '#0ea5e9', rim: '#7dd3fc', ink: '#0c4a6e' };

export function BingoBall({
  label,
  column,
  size,
  settled,
  spinning,
}: {
  /** 球に書く文字（ふつうは数字）。 */
  label: string;
  /** B/I/N/G/O のどれか。決まらないときは null。 */
  column: string | null;
  /** 直径（1920 基準の px）。 */
  size: number;
  /** 出た球として確定しているか。確定したときだけ落ちてくる。 */
  settled: boolean;
  /** 抽選中か。抽選中は揺れる。 */
  spinning: boolean;
}) {
  const palette = (column !== null ? COLUMN_COLORS[column] : undefined) ?? NEUTRAL;

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full',
        settled ? 'stage-drop' : spinning ? 'stage-tumble' : '',
      )}
      style={{
        width: stageSize(size),
        height: stageSize(size),
        // 上からの光・下からの照り返し・地の色を重ねて球に見せる。
        background: `
          radial-gradient(circle at 32% 26%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.35) 16%, transparent 42%),
          radial-gradient(circle at 70% 82%, ${palette.rim} 0%, transparent 48%),
          radial-gradient(circle at 50% 45%, ${palette.base} 42%, ${palette.ink} 100%)
        `,
        boxShadow: `inset 0 ${stageSize(-size * 0.06)} ${stageSize(size * 0.12)} rgba(0,0,0,0.45), 0 ${stageSize(size * 0.04)} ${stageSize(size * 0.14)} rgba(0,0,0,0.5), 0 0 ${stageSize(size * 0.16)} ${palette.rim}55`,
      }}
    >
      {/* 数字を載せる白い面。球の色が濃くても数字が読めるようにする。 */}
      <div
        className="flex flex-col items-center justify-center rounded-full bg-white"
        style={{
          width: `${68}%`,
          height: `${68}%`,
          boxShadow: `inset 0 0 ${stageSize(size * 0.05)} rgba(0,0,0,0.25)`,
        }}
      >
        {column !== null ? (
          <span
            className="font-bold"
            style={{
              color: palette.ink,
              fontSize: stageSize(size * 0.17),
              lineHeight: 1,
              letterSpacing: '0.08em',
            }}
          >
            {column}
          </span>
        ) : null}
        <span
          className="text-stage-950 font-bold tabular-nums"
          style={{
            fontSize: stageSize(size * (column !== null ? 0.34 : 0.42)),
            lineHeight: 1,
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

/**
 * 抽選機（球がぐるぐる回るかご）。
 *
 * 抽選中だけ出す。「いま引いている」ことが、数字が変わる以外の手がかりでも伝わる。
 * 中の球は飾りなので固定の並びでよい（乱数を使うとサーバー描画と食い違う）。
 */
const CAGE_BALLS = [
  { x: 30, y: 28, size: 15, color: '#1d4ed8' },
  { x: 62, y: 22, size: 12, color: '#dc2626' },
  { x: 22, y: 58, size: 13, color: '#16a34a' },
  { x: 55, y: 62, size: 16, color: '#f59e0b' },
  { x: 44, y: 42, size: 11, color: '#e2e8f0' },
  { x: 70, y: 52, size: 12, color: '#0ea5e9' },
  { x: 38, y: 72, size: 10, color: '#f9a8d4' },
] as const;

export function BingoCage({ size, spinning }: { size: number; spinning: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="relative shrink-0 rounded-full"
      style={{
        width: stageSize(size),
        height: stageSize(size),
        background:
          'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.22) 0%, transparent 46%), radial-gradient(circle at 50% 55%, rgba(8,20,45,0.75) 40%, rgba(3,8,20,0.9) 100%)',
        border: `${stageSize(size * 0.035)} solid rgba(255,255,255,0.35)`,
        boxShadow: `inset 0 0 ${stageSize(size * 0.12)} rgba(255,255,255,0.18), 0 0 ${stageSize(size * 0.1)} rgba(103,232,249,0.35)`,
      }}
    >
      <div className={cn('absolute inset-0', spinning ? 'stage-cage' : '')}>
        {CAGE_BALLS.map((ball, index) => (
          <span
            key={index}
            className="absolute rounded-full"
            style={{
              left: `${ball.x}%`,
              top: `${ball.y}%`,
              width: `${ball.size}%`,
              height: `${ball.size}%`,
              background: `radial-gradient(circle at 34% 30%, #ffffff 0%, ${ball.color} 55%, rgba(0,0,0,0.5) 100%)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
