/**
 * 投影の本体を作り直すかどうかを決める鍵。
 *
 * クイズは場面が変わるたびに作り直して入場効果をやり直す。
 * 会場では画面の切り替わりが伝わりにくいため、動きで「変わった」ことを示す。
 *
 * **抽選（抽選会・ビンゴ・ルーレット）は作り直さない。**
 * 回す演出を持っている部品が「画面を開いた直後」の状態へ戻ってしまい、
 * その回だけ回らずに、いきなり結果から出る（実際にそうなった）。
 * 抽選の画面は自前で演出を持っているので、入場効果は要らない。
 */
export function stageBodyKey(input: {
  drawMode: boolean;
  phase: string;
  questionId: string | null;
}): string {
  if (input.drawMode) {
    return 'draw';
  }
  return `${input.phase}-${input.questionId ?? ''}`;
}
