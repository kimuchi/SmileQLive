/**
 * 鳴らす音の一覧。
 *
 * ここには**音を鳴らす仕組みを置かない**。名前と用途と既定のファイル名だけ。
 * 再生そのもの（AudioContext）は投影画面だけが持つ決まりになっており、
 * 管理画面から名前や用途を参照できるように、この部分だけを切り出している。
 * （`src/lib/audio/*` は ESLint の no-restricted-imports で投影画面以外から禁止。）
 */

export type SoundName =
  | 'question-start'
  | 'tick'
  | 'answer-lock'
  | 'answer-reveal'
  /** ランキング発表前のためる音（ドラムロール）。 */
  | 'ranking'
  /** ランキングが出た瞬間の音（ファンファーレ）。 */
  | 'fanfare'
  | 'finish'
  /**
   * 抽選のルーレットを回している間ずっと鳴らす音。
   * 繰り返して鳴らすため、素材の長さがそのまま継ぎ目の間隔になる。
   */
  | 'draw-spin'
  /** 引いたものが確定した瞬間の音。 */
  | 'draw-win';

export const SOUND_NAMES = [
  'question-start',
  'tick',
  'answer-lock',
  'answer-reveal',
  'ranking',
  'fanfare',
  'finish',
  'draw-spin',
  'draw-win',
] as const satisfies readonly SoundName[];

export function isSoundName(value: string): value is SoundName {
  return (SOUND_NAMES as readonly string[]).includes(value);
}

/** 管理画面に出す名前。 */
export const SOUND_LABELS: Record<SoundName, string> = {
  'question-start': '出題の合図',
  tick: '残り時間のカウント',
  'answer-lock': '回答締切',
  'answer-reveal': '正解発表',
  ranking: 'ランキングのためる音',
  fanfare: 'ランキングのファンファーレ',
  finish: '終了',
  'draw-spin': '抽選を回している音',
  'draw-win': '当選の瞬間',
};

/** いつ鳴るか。差し替えるときに「どれを変えているか」が分かるようにする。 */
export const SOUND_DESCRIPTIONS: Record<SoundName, string> = {
  'question-start': '問題を出した瞬間に 1 回。',
  tick: '回答を受け付けている間ずっと繰り返します。長い素材だと間延びします。',
  'answer-lock': '回答を締め切った瞬間に 1 回。',
  'answer-reveal': '正解を出した瞬間に 1 回。',
  ranking: '順位が出るまでの間ずっと繰り返します（ドラムロール向き）。',
  fanfare: '順位が出た瞬間に 1 回。',
  finish: '会を終えた瞬間に 1 回。',
  'draw-spin': '抽選・ルーレットを回している間ずっと繰り返します。',
  'draw-win': '引いたものが確定した瞬間に 1 回。',
};

/**
 * 同梱の既定音の置き場所（公開パス）。
 *
 * 差し替えていないものはここから鳴る。
 * 差し替えた音は Cloud Storage に置き、配信経路の URL に入れ替わる。
 */
export const DEFAULT_SOUND_URLS: Record<SoundName, string> = {
  'question-start': '/sounds/default/question-start.wav',
  tick: '/sounds/default/tick.wav',
  'answer-lock': '/sounds/default/answer-lock.wav',
  'answer-reveal': '/sounds/default/answer-reveal.wav',
  ranking: '/sounds/default/ranking.wav',
  fanfare: '/sounds/default/fanfare.wav',
  finish: '/sounds/default/finish.wav',
  'draw-spin': '/sounds/default/draw-spin.wav',
  'draw-win': '/sounds/default/draw-win.wav',
};
