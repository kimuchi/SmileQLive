'use client';

import { cn } from '@/lib/client/cn';

/**
 * 当選・正解の瞬間に重ねる演出部品。
 *
 * 会場は明るく、席は遠い。文字が変わっただけでは伝わらないので、
 * 光線・輪・紙吹雪・閃光を重ねて「いま決まった」ことを動きで示す。
 *
 * 決めごと:
 * - すべて `pointer-events-none` かつ `aria-hidden`。飾りであって情報ではない。
 * - 位置や速さに乱数を使わない。サーバー描画と食い違って作り直しになるため、
 *   見た目のばらつきは**固定の表**で作る。
 * - 読ませたい文字の上に不透明なものを置かない。背面か、外側で動かす。
 */

/**
 * 紙吹雪の一枚ごとの設定。
 *
 * 乱数の代わりに手で散らした表。左右の位置・落ちる速さ・回り方・色を
 * わざと不揃いにしてある（等間隔だと「模様」に見えて安っぽくなる）。
 */
const CONFETTI = [
  { left: 4, drift: 6, delay: 0, duration: 2.6, spin: 620, color: '#fcd34d', w: 0.6, h: 1.1 },
  { left: 11, drift: -4, delay: 180, duration: 3.1, spin: -480, color: '#67e8f9', w: 0.5, h: 0.9 },
  { left: 18, drift: 9, delay: 60, duration: 2.4, spin: 720, color: '#f9a8d4', w: 0.7, h: 0.7 },
  { left: 25, drift: -7, delay: 320, duration: 2.9, spin: -600, color: '#fde68a', w: 0.5, h: 1.2 },
  { left: 32, drift: 3, delay: 120, duration: 3.4, spin: 540, color: '#86efac', w: 0.6, h: 0.8 },
  { left: 39, drift: -9, delay: 420, duration: 2.5, spin: -700, color: '#fcd34d', w: 0.8, h: 0.8 },
  { left: 46, drift: 5, delay: 40, duration: 3.0, spin: 480, color: '#93c5fd', w: 0.5, h: 1.0 },
  { left: 53, drift: -3, delay: 260, duration: 2.7, spin: -540, color: '#fde68a', w: 0.7, h: 1.1 },
  { left: 60, drift: 8, delay: 500, duration: 3.2, spin: 660, color: '#f9a8d4', w: 0.6, h: 0.7 },
  { left: 67, drift: -6, delay: 100, duration: 2.6, spin: -620, color: '#67e8f9', w: 0.5, h: 1.2 },
  { left: 74, drift: 4, delay: 380, duration: 3.3, spin: 580, color: '#fcd34d', w: 0.7, h: 0.9 },
  { left: 81, drift: -8, delay: 200, duration: 2.8, spin: -500, color: '#86efac', w: 0.6, h: 1.0 },
  { left: 88, drift: 7, delay: 460, duration: 3.0, spin: 700, color: '#fde68a', w: 0.5, h: 0.8 },
  { left: 95, drift: -5, delay: 80, duration: 2.5, spin: -560, color: '#93c5fd', w: 0.7, h: 1.1 },
  { left: 8, drift: 10, delay: 620, duration: 3.5, spin: 640, color: '#fcd34d', w: 0.6, h: 0.9 },
  { left: 22, drift: -10, delay: 700, duration: 3.1, spin: -680, color: '#f9a8d4', w: 0.5, h: 1.0 },
  { left: 36, drift: 6, delay: 560, duration: 2.9, spin: 520, color: '#67e8f9', w: 0.7, h: 0.8 },
  { left: 50, drift: -4, delay: 780, duration: 3.4, spin: -740, color: '#fde68a', w: 0.6, h: 1.2 },
  { left: 64, drift: 9, delay: 640, duration: 2.7, spin: 600, color: '#86efac', w: 0.5, h: 0.9 },
  { left: 78, drift: -7, delay: 840, duration: 3.2, spin: -520, color: '#fcd34d', w: 0.8, h: 1.0 },
  { left: 92, drift: 5, delay: 720, duration: 2.8, spin: 680, color: '#93c5fd', w: 0.6, h: 0.7 },
] as const;

/**
 * 紙吹雪。
 *
 * `burst` を変えると降り直す（React に作り直させるため key に使う）。
 * 当選のたびに 1 回ぶんだけ降らせ、降り終わったら消える。
 */
export function StageConfetti({ burst }: { burst: string | number }) {
  return (
    <div
      key={burst}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {CONFETTI.map((piece, index) => (
        <span
          key={index}
          className="stage-confetti absolute top-0 block rounded-[0.1cqw]"
          style={{
            left: `${piece.left}%`,
            width: `${piece.w}cqw`,
            height: `${piece.h}cqw`,
            backgroundColor: piece.color,
            ['--stage-confetti-drift' as string]: `${piece.drift}cqw`,
            ['--stage-confetti-delay' as string]: `${piece.delay}ms`,
            ['--stage-confetti-duration' as string]: `${piece.duration}s`,
            ['--stage-confetti-spin' as string]: `${piece.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * 当選者の背後で回り続ける光線と、そこから広がる輪。
 *
 * 主役の文字より**背面**に置く。前に出すと読めなくなる。
 */
export function StageBurst({ burst }: { burst: string | number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden"
    >
      <div className="stage-rays absolute aspect-square w-[120%] opacity-70" />
      <div key={burst} className="absolute flex aspect-square w-[60%] items-center justify-center">
        <span className="stage-ring absolute inset-0 rounded-full border-[0.35cqw] border-amber-200/70" />
        <span className="stage-ring stage-ring-2 absolute inset-0 rounded-full border-[0.3cqw] border-amber-100/60" />
        <span className="stage-ring stage-ring-3 absolute inset-0 rounded-full border-[0.25cqw] border-white/50" />
      </div>
    </div>
  );
}

/** 決まった瞬間の閃光。1 回だけ白く飛ばす。 */
export function StageFlash({ burst }: { burst: string | number }) {
  return (
    <div
      key={burst}
      aria-hidden="true"
      className="stage-flash pointer-events-none absolute inset-0 z-30 bg-white"
    />
  );
}

/**
 * 当選演出ひとそろい（光線・輪・閃光・紙吹雪）。
 *
 * `burst` には「何回目の抽選か」を渡す。値が変わるたびに演出をやり直す。
 */
export function StageCelebration({
  burst,
  className,
}: {
  burst: string | number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0', className)}>
      <StageBurst burst={burst} />
      <StageFlash burst={burst} />
      <StageConfetti burst={burst} />
    </div>
  );
}
