'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { wheelRotationFor, wheelSegments, type StageDrawEntry } from '@/domain/draw/draw-stage';

/**
 * ルーレットの円盤を回す。
 *
 * 進行はサーバーの状態に従う。
 *   回っている間（draw_spinning） … 等速で回し続ける。**当たりはまだ決まっていない。**
 *   止まったあと（draw_revealed） … 当たりの扇が真上へ来る角度まで、減速しながら回す。
 *
 * 減速にかける時間は抽選リストの設定（ストップしてから止まるまで）。
 * 司会が「ストップ」を押してからこの時間で止まる。
 *
 * **結果を先に知って演出しているわけではない。**
 * 当たりはサーバーがストップを受けた瞬間に決めて記録し、
 * ここはその扇が針の下へ来る角度を計算しているだけ。
 *
 * 角度は React の状態に持たず、要素の style を直接書き換える。
 * 毎秒 60 回の再描画を React に通すと、投影画面の他の表示まで巻き込んで重くなる。
 */

/** 回している間の速さ（度/秒）。会場で「速い」と感じる程度。 */
const SPIN_SPEED_DEG_PER_SEC = 540;

/** 止まるまでに最低これだけは回す（周）。少ないと「ただ動いた」ように見える。 */
const MIN_TURNS_BEFORE_STOP = 3;

/** 減速の効き方。最後にゆっくり詰めて、針の手前で「止まりそうで止まらない」形にする。 */
const STOP_EASING = 'cubic-bezier(0.12, 0.72, 0.12, 1)';

export function useRouletteWheel(input: {
  /** 扇の一覧。順番と重みから角度を決める。 */
  entries: readonly StageDrawEntry[];
  /** サーバーの状態: 回っている最中か。 */
  isSpinning: boolean;
  /** 当たった扇。回っている最中は null。 */
  winnerId: string | null;
  /** 何回目の結果か。値が変わると新しい結果として止め直す。 */
  latestOrder: number | null;
  /** ストップを押してから止まるまでの時間 (ms)。 */
  stopDurationMs: number;
}): RefObject<HTMLDivElement | null> {
  const { entries, isSpinning, winnerId, latestOrder, stopDurationMs } = input;

  const wheelRef = useRef<HTMLDivElement | null>(null);
  /** いまの角度（度）。止めるときの続きの角度として使う。 */
  const rotationRef = useRef(0);
  /** 止め処理を始めた結果番号。同じ結果で二度止めない。 */
  const stoppedOrderRef = useRef<number | null>(null);

  // --- 回している間 ---
  useEffect(() => {
    const element = wheelRef.current;
    if (!isSpinning || !element) {
      return;
    }

    stoppedOrderRef.current = null;
    // 減速の指定が残っていると、毎フレームの書き換えが引きずられる。
    element.style.transition = 'none';

    let previous = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      rotationRef.current += (SPIN_SPEED_DEG_PER_SEC * (now - previous)) / 1000;
      previous = now;
      element.style.transform = `rotate(${rotationRef.current}deg)`;
      frame = requestAnimationFrame(step);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isSpinning]);

  // --- 止める ---
  useEffect(() => {
    const element = wheelRef.current;
    if (isSpinning || !element || winnerId === null || latestOrder === null) {
      return;
    }
    if (stoppedOrderRef.current === latestOrder) {
      return;
    }
    stoppedOrderRef.current = latestOrder;

    const segment = wheelSegments(entries).find((candidate) => candidate.entry.id === winnerId);
    if (!segment) {
      return;
    }

    /*
      いまの角度から**先へ進む形**で止める。
      角度を巻き戻すと「逆回転して止まった」ように見えてしまう。
    */
    const turns = Math.ceil(rotationRef.current / 360) + MIN_TURNS_BEFORE_STOP;
    const target = wheelRotationFor(segment.centerAngle, turns);
    rotationRef.current = target;

    element.style.transition = `transform ${stopDurationMs}ms ${STOP_EASING}`;
    element.style.transform = `rotate(${target}deg)`;
  }, [entries, isSpinning, latestOrder, stopDurationMs, winnerId]);

  return wheelRef;
}
