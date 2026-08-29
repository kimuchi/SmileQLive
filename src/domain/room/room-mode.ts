/**
 * ルームのモード。
 *
 * 会場では「クイズ大会」「抽選会」「ビンゴ大会」を別々の催しとして開く。
 * どれも投影画面と司会画面の組み合わせで進むが、出すものと操作が違う。
 * モードは**ルームを作るときに決め、途中で変えない**。
 * 途中で変えられると、参加者が読んだ二次元コードの意味が変わってしまう。
 *
 * 既存のルームには mode が保存されていない。読むときは `roomModeOf()` を通し、
 * 保存されていなければクイズとして扱う（移行作業を要らなくするため）。
 */

export const ROOM_MODES = ['quiz', 'lottery', 'bingo', 'roulette', 'poll'] as const;

export type RoomMode = (typeof ROOM_MODES)[number];

export const ROOM_MODE_LABELS: Record<RoomMode, string> = {
  quiz: 'クイズ',
  lottery: '抽選会',
  bingo: 'ビンゴ',
  roulette: 'ルーレット',
  poll: '投票',
};

/** 管理画面でモードを選ぶときの説明。 */
export const ROOM_MODE_DESCRIPTIONS: Record<RoomMode, string> = {
  quiz: '問題を出して、参加者がスマホで答えます。',
  lottery: '名簿から当選者を 1 人ずつ引きます。参加者のスマホは使いません。',
  bingo: '数字や景品を 1 つずつ引きます。ビンゴカードは紙で配ります。',
  roulette: '重みを付けた項目を円盤に並べ、回して止めます。同じ項目が何度でも出ます。',
  poll: '参加者がスマホで投票します。1端末につき1票。集計を確かめてから結果を発表できます。',
};

export function isRoomMode(value: string): value is RoomMode {
  return (ROOM_MODES as readonly string[]).includes(value);
}

/**
 * 保存された値をモードとして読む。未設定・不正ならクイズ。
 *
 * この関数を通さずに `room.mode` を直接見ないこと。
 * モードが増える前に作られたルームは値を持っていない。
 */
export function roomModeOf(value: unknown): RoomMode {
  return typeof value === 'string' && isRoomMode(value) ? value : 'quiz';
}

/**
 * 1 つずつ引いていくモードか（抽選会・ビンゴ・ルーレット）。
 *
 * どれも「引いたものをサーバーが決めて記録し、投影は見せるだけ」という
 * 同じ仕組みで動く。違うのは見せ方と、引いたものを母集団から外すかどうか。
 */
export function isDrawMode(mode: RoomMode): boolean {
  return mode === 'lottery' || mode === 'bingo' || mode === 'roulette';
}

/**
 * 引いたものを母集団から外すか。
 *
 * 抽選会・ビンゴは外す（同じ人が二度当たらない／同じ球が二度出ない）。
 * **ルーレットは外さない。** 円盤の扇は回すたびに減らないし、
 * 減らしてしまうと重みの意味が無くなる（残り 1 つになれば必ずそれが出る）。
 */
export function removesDrawnEntries(mode: RoomMode): boolean {
  return mode === 'lottery' || mode === 'bingo';
}

/**
 * 参加者が加わるモードか。
 *
 * 抽選会・ビンゴ・ルーレットは名簿や紙のカードで進めるため、参加者はスマホを使わない。
 * ルーム作成時に参加受付を開かず、参加 URL も発行しない。
 * クイズと投票は参加者が自分の端末から操作するので、参加 URL を出す。
 */
export function acceptsParticipants(mode: RoomMode): boolean {
  return mode === 'quiz' || mode === 'poll';
}

/** 投票のモードか。 */
export function isPollMode(mode: RoomMode): boolean {
  return mode === 'poll';
}
