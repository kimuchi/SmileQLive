/**
 * ルーレットの回り方。
 *
 * 操作は 3 つ。**スタートで等速に回り、ストップで減速して止まる。**
 * ルームで回す抽選会のルーレットと同じ操作にしてある
 * （会場では「まだ回して」「そろそろ止めて」を司会がその場で決めたい）。
 *
 *   スタート … 決めた速さで回り続ける。押すまで止まらない。
 *   ストップ … 決めた秒数をかけて減速し、止まる。
 *
 * 速さと減速の秒数は**別々**に決める。速く回して短く止めることも、
 * ゆっくり回して長く引っぱることもできる。
 *
 * ## 当たりの決め方
 *
 * **先に当たりを決めてから角度を合わせるのではなく、回った先にあったものを当たりとする。**
 * ただし「勢い任せ」にはしない。それだと止まる角度の分布が回した長さに引きずられ、
 * 扇の広さどおりの確率にならない。
 *
 * ストップを押した瞬間に、
 *   1. **止まる角度を 0〜360 度から一様に引く**
 *   2. そこへちょうど着くまでの距離を、いまの角度から求める
 * という順で決める。止まる角度が一様なら、ある扇に止まる確率は
 * その扇の広さにきっちり比例する（＝重みどおりになる）。
 *
 * 減速の形は 3 次のイーズアウト（最後にゆっくり詰める）。
 * 回る距離は「押した瞬間の速さがそのまま続く」ように選ぶので、
 * 押した瞬間に速さが飛ばず、そのまま減速へ入って見える。
 *
 * ここはドメイン層。乱数も時計も外から受け取る（同じ入力なら同じ結果になる）。
 */

/** 減速の単位をそろえるための想定フレーム数（配布サイトの decel_value 換算に使う）。 */
const FRAMES_PER_SECOND = 60;

/**
 * ストップしてから最低これだけは回す（周）。
 *
 * 既に回っているので 1 周あれば「減速して止まった」と分かる。
 * 0 にすると、押した位置のすぐ隣で止まって「操作で止めた」ように見えてしまう。
 */
export const MIN_TURNS_ON_STOP = 1;

/**
 * 3 次イーズアウトの初速の係数。
 *
 * `p(t) = 1 - (1-t)^3` の t=0 での傾きは 3。つまり距離 D を時間 T で走ると
 * 押した瞬間の速さは 3D/T になる。逆に言えば D = vT/3 に選べば、
 * 回っていた速さのまま減速へ入る。
 */
const EASE_OUT_INITIAL_SLOPE = 3;

export type StopPlan = {
  /** ストップを押した時点の角度（度）。 */
  startRotation: number;
  /** 止まったときの角度（度）。ここから当たりを読む。 */
  endRotation: number;
  /** 減速中に回る量（度）。 */
  distance: number;
  /** 止まるまでの時間 (ms)。 */
  durationMs: number;
};

/** 等速で回っている間の角度。 */
export function spinningRotationAt(input: {
  startRotation: number;
  /** 度/秒。 */
  speed: number;
  elapsedMs: number;
}): number {
  return input.startRotation + (input.speed * Math.max(0, input.elapsedMs)) / 1000;
}

/**
 * ストップを押したときの止まり方を決める。
 *
 * @param random 0 以上 1 未満を返す関数。止まる角度をここから引く。
 */
export function planStop(input: {
  startRotation: number;
  /** 回っていた速さ（度/秒）。 */
  speed: number;
  /** 止まるまでにかける秒数。 */
  stopSeconds: number;
  random: () => number;
}): StopPlan {
  const durationMs = Math.max(0, input.stopSeconds) * 1000;

  // 止まる角度を一様に引く。ここが「重みどおりの確率」の根拠になる。
  const offset = Math.min(0.999_999, Math.max(0, input.random())) * 360;

  /*
    押した瞬間の速さがそのまま続くように、回る距離のおよその目標を決める。
    そのうえで「止まる角度」を守れる値（= 周回数を整数に丸めた値）へ寄せる。
  */
  const ideal = (input.speed * Math.max(0, input.stopSeconds)) / EASE_OUT_INITIAL_SLOPE;
  const turns = Math.max(MIN_TURNS_ON_STOP, Math.round((ideal - offset) / 360));
  const distance = turns * 360 + offset;

  return {
    startRotation: input.startRotation,
    endRotation: input.startRotation + distance,
    distance,
    durationMs,
  };
}

/**
 * 減速中の角度。
 *
 * 止まったあとは止まった角度を返す（行き過ぎて戻らないように）。
 */
export function stoppingRotationAt(plan: StopPlan, elapsedMs: number): number {
  if (plan.durationMs <= 0 || elapsedMs >= plan.durationMs) {
    return plan.endRotation;
  }
  const t = Math.max(0, elapsedMs) / plan.durationMs;
  const eased = 1 - (1 - t) ** 3;
  return plan.startRotation + plan.distance * eased;
}

// ---------------------------------------------------------------------------
// 配布サイトの decel_value との換算
// ---------------------------------------------------------------------------

/**
 * 速さと止まるまでの秒数から、配布サイトの `decel_value` を求める。
 *
 * あちらは「1 フレームあたり何度ぶん速度が落ちるか」で回り方を決めている。
 * こちらの URL にもこの値を書き出しておくと、あちらへ貼っても近い回り方になる。
 */
export function decelValueFor(speed: number, stopSeconds: number): number {
  if (stopSeconds <= 0) {
    return 0;
  }
  const perSecond = speed / stopSeconds;
  return perSecond / (FRAMES_PER_SECOND * FRAMES_PER_SECOND);
}

/**
 * 配布サイトの `decel_value` から、止まるまでの秒数を見積もる。
 *
 * あちらの初速はこちらでは分からないので、**この画面の速さで**その減速をかけたら
 * 何秒で止まるかを返す。速く回すほど止まるのに時間がかかる、という関係は保たれる。
 */
export function stopSecondsFromDecel(decelValue: number, speed: number): number {
  const perSecond = decelValue * FRAMES_PER_SECOND * FRAMES_PER_SECOND;
  if (perSecond <= 0) {
    return 0;
  }
  return speed / perSecond;
}
