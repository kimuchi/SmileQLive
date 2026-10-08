/**
 * ルーレットの円盤を描く部品。
 *
 * 扇の弧と、扇の中に置く文字。角度は**真上 (12 時) を 0 度として時計回り**。
 * SVG の角度は 3 時方向が 0 度なので、描くときに 90 度ずらしている。
 *
 * ルームで回すルーレット（RouletteStage）と、URL だけで回すルーレット
 * （StandaloneRoulette）の両方から使う。扇に文字を収める加減は
 * 何度も直した末の値なので、片方だけ直して見た目がずれるのを避けたい。
 */

/**
 * 扇の中の文字。
 *
 * **中心線に沿って外向きに寝かせる**（放射状）。
 * 扇を横切る向きに置くと、狭い扇では文字が隣の扇まではみ出して重なる。
 * 放射状なら、狭い扇でも扇の長い方向へ伸ばせる。
 *
 * 右半分は外向き、左半分は内向きに読ませる。
 * こうすると、どちらの半分でも文字が上下逆さまにならない。
 */
export function SegmentLabel({
  cx,
  cy,
  radius,
  angle,
  sweep,
  label,
}: {
  cx: number;
  cy: number;
  radius: number;
  angle: number;
  sweep: number;
  label: string;
}) {
  const sweepRad = (sweep * Math.PI) / 180;
  // 文字を置き始める外端。縁ぎりぎりだと切れて見えるので少し内側。
  const outerR = radius * 0.94;
  // 中心のふたの外側。ここより内側には置けない。
  const hubR = radius * 0.18;

  /*
    字の高さは扇の弧の幅で決まる。弧は外側ほど広いので、外端の幅を基準にする。
    上限は、扇がいくら広くても画面の他の表示より目立たせないための頭打ち。
  */
  let fontSize = Math.round(Math.max(18, Math.min(46, outerR * sweepRad * 0.5)));

  /*
    長い名前は字を小さくして最後まで見せる。切るのは最後の手段。
    1 回 2 ずつ下げる。下限まで 15 回ほどで着くので、描画のたびに回っても軽い。
  */
  while (
    fontSize > 18 &&
    label.length * fontSize * 0.92 > radialRoom(outerR, hubR, sweepRad, fontSize)
  ) {
    fontSize -= 2;
  }

  const room = radialRoom(outerR, hubR, sweepRad, fontSize);
  /*
    1 文字も置けない扇には何も入れない。
    無理に入れても読めないうえ、隣の扇の文字と重なって円盤全体が汚くなる。
    色と、止まったときの大きな表示で伝わる。
  */
  if (room < fontSize) {
    return null;
  }

  // 全角 1 文字の幅はおおよそ字の高さ。入る字数で切る。
  const maxChars = Math.max(1, Math.floor(room / (fontSize * 0.92)));
  const text = label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 1))}…` : label;

  // 真上を 0 度として時計回り。SVG の角度は 3 時方向が 0 度なので 90 度ずらす。
  const rad = ((angle - 90) * Math.PI) / 180;
  const x = cx + Math.cos(rad) * outerR;
  const y = cy + Math.sin(rad) * outerR;

  /*
    右半分（0〜180 度）は外端で文字を終わらせ、左半分は外端から始める。
    どちらも「外端に寄せて、中心へ向かって伸びる」形になり、
    かつ文字が上下逆さまにならない。
  */
  const rightHalf = angle < 180;

  return (
    <text
      x={x}
      y={y}
      fill="#ffffff"
      fontSize={fontSize}
      fontWeight="bold"
      textAnchor={rightHalf ? 'end' : 'start'}
      dominantBaseline="middle"
      transform={`rotate(${rightHalf ? angle - 90 : angle + 90} ${x} ${y})`}
      style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.45)', strokeWidth: 4 }}
    >
      {text}
    </text>
  );
}

/**
 * 中心線に沿って文字を置ける長さ。
 *
 * 弧の幅が字の高さより狭いところへ置くと隣の扇へはみ出すので、
 * その位置より外側だけを使えるものとして数える。
 */
function radialRoom(outerR: number, hubR: number, sweepRad: number, fontSize: number): number {
  const innerR = Math.max(hubR, (fontSize * 0.9) / sweepRad);
  return outerR - innerR;
}

/** 扇 1 枚の円弧パス。角度は真上 0 度・時計回り。 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  // 1 件しか無いときは扇にならないので、円をそのまま描く。
  if (endAngle - startAngle >= 359.999) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`;
  }

  const toPoint = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + Math.cos(rad) * radius, cy + Math.sin(rad) * radius] as const;
  };

  const [x1, y1] = toPoint(startAngle);
  const [x2, y2] = toPoint(endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}
