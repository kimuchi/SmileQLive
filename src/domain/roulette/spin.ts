/**
 * ルーレットの回り方。
 *
 * 押したら一定の割合で減速し、ひとりでに止まる。
 * 司会が「ストップ」を押す抽選会のルーレット（`hooks/use-draw-roulette.ts`）とは
 * 操作が違う。こちらはボタン 1 つで、止まる位置も止まるまでの時間も物理で決まる。
 *
 * ## 当たりの決め方
 *
 * **先に当たりを決めてから角度を合わせるのではなく、回った先にあったものを当たりとする。**
 * ただし「初速を適当に散らす」やり方はしない。それだと止まる角度の分布が
 * 初速の散らし方に引きずられ、扇の広さどおりの確率にならない。
 *
 * ここでは逆に、
 *   1. **止まる角度を 0〜360 度から一様に引く**
 *   2. そこへちょうど着く初速を、減速から逆算する
 * という順で決める。止まる角度が一様なら、ある扇に止まる確率は
 * その扇の広さにきっちり比例する（＝重みどおりになる）。
 * 見た目は 1 の等速減速そのもので、回している間に結果は画面のどこにも無い。
 *
 * ## 減速の単位
 *
 * `decel` は「1 フレーム（60 分の 1 秒）あたり何度ぶん速度が落ちるか」。
 * 配布されているルーレットの `decel_value` をそのまま貼れるように合わせてある。
 *
 * ここはドメイン層。乱数も時計も外から受け取る（同じ入力なら同じ結果になる）。
 */

/** 減速の単位をそろえるための想定フレーム数。 */
const FRAMES_PER_SECOND = 60;

/**
 * 止まるまでに最低これだけは回す（周）。
 *
 * 少ないと「ちょっと動いて止まった」ようにしか見えない。
 * 3 周あれば、会場から見て「回った」と分かる。
 */
export const MIN_TURNS = 3;

export type SpinPlan = {
  /** 回し始めの角度（度）。 */
  startRotation: number;
  /** 止まったときの角度（度）。ここから当たりを読む。 */
  endRotation: number;
  /** 回る量（度）。 */
  distance: number;
  /** 初速（度/秒）。 */
  initialSpeed: number;
  /** 減速（度/秒^2）。 */
  deceleration: number;
  /** 止まるまでの時間 (ms)。 */
  durationMs: number;
};

/** 「1 フレームあたり何度」を「1 秒あたり何度」へ直す。 */
export function decelPerSecond(decelPerFrame: number): number {
  return decelPerFrame * FRAMES_PER_SECOND * FRAMES_PER_SECOND;
}

/**
 * 1 回ぶんの回り方を決める。
 *
 * @param random 0 以上 1 未満を返す関数。止まる角度をここから引く。
 */
export function planSpin(input: {
  startRotation: number;
  /** 1 フレームあたりの減速（度）。 */
  decel: number;
  random: () => number;
}): SpinPlan {
  const deceleration = decelPerSecond(input.decel);

  // 止まる角度を一様に引く。ここが「重みどおりの確率」の根拠になる。
  const offset = Math.min(0.999_999, Math.max(0, input.random())) * 360;
  const distance = MIN_TURNS * 360 + offset;

  // 等減速で distance だけ進んで止まる初速: v^2 = 2 a s
  const initialSpeed = Math.sqrt(2 * deceleration * distance);

  return {
    startRotation: input.startRotation,
    endRotation: input.startRotation + distance,
    distance,
    initialSpeed,
    deceleration,
    durationMs: (initialSpeed / deceleration) * 1000,
  };
}

/**
 * 経過時間から、いまの角度を求める。
 *
 * 止まったあとは止まった角度を返す（行き過ぎて戻らないように）。
 */
export function rotationAt(plan: SpinPlan, elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1000;
  const stopSeconds = plan.durationMs / 1000;
  if (seconds >= stopSeconds) {
    return plan.endRotation;
  }
  const traveled = plan.initialSpeed * seconds - 0.5 * plan.deceleration * seconds * seconds;
  return plan.startRotation + traveled;
}

/**
 * その減速だと何秒くらい回るか（画面へ出す目安）。
 *
 * 止まる角度を引く前でも出せるよう、回る量は真ん中（MIN_TURNS + 0.5 周）で見積もる。
 * 実際の 1 回はこれより ±5% ほど動く。
 */
export function estimatedSpinSeconds(decel: number): number {
  const deceleration = decelPerSecond(decel);
  const distance = (MIN_TURNS + 0.5) * 360;
  return Math.sqrt((2 * distance) / deceleration);
}
