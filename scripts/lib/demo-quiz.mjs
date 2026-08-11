/**
 * デモクイズの中身（問題そのもの）。
 *
 * 画像 ID の割り当てと Firestore への書き込みは seed-demo-quiz.mjs が行う。
 * ここを分けているのは、**アプリ本体の公開検証にそのままかけられる**ようにするため
 * （tests/unit/scripts/demo-quiz.test.ts）。
 * 「シードは通ったが公開できないクイズだった」という状態を防ぐ。
 *
 * 収録する型:
 *   1. 2 択                … 問題画像 + 解説画像
 *   2. 3 択                … 文章のみ
 *   3. 4 択                … 選択肢がすべて画像（代替テキスト必須の例）
 *   4. 数値 / 完全一致
 *   5. 数値 / 許容誤差
 *   6. 数値 / 範囲指定
 */

export const DEMO_TITLE = 'SmileQ Live 動作確認クイズ';

/**
 * 問題の保存先。
 *
 * **`questions` はトップレベルではなく `quizzes/{quizId}` のサブコレクション。**
 * ここを間違えるとクイズ自体は一覧に出るのに中身が 0 問になり、
 * ルーム作成が「問題を1問以上作成してください」で止まる。
 * アプリ側の paths.ts（questionsCollection）と一致していること。
 * tests/unit/scripts/demo-quiz.test.ts で突き合わせている。
 */
export function questionsPath(quizId) {
  return ['quizzes', quizId, 'questions'];
}
export const DEMO_DESCRIPTION =
  '選択式と数値入力をひととおり収録したデモです。会場での動作確認に使えます。';

/**
 * 必要な画像の一覧。キーは `media` の参照名。
 * seed 側がこの定義どおりに生成・アップロードする。
 */
export const DEMO_MEDIA = {
  q1: { kind: 'question', title: '富士山がまたがるのは？', subtitle: '標高 3,776 m の日本最高峰', palette: ['blue', 'navy'], illustration: 'mountain' },
  q1reveal: { kind: 'reveal', answer: '静岡県と山梨県', note: '山頂付近の県境は未確定のままになっています', palette: ['emerald'] },
  q2: { kind: 'question', title: '面積が一番大きい都道府県は？', palette: ['emerald', '#065f46'], illustration: 'nestedSquares' },
  triangle: { kind: 'shape', shape: 'triangle', palette: ['rose'] },
  square: { kind: 'shape', shape: 'square', palette: ['blue'] },
  circle: { kind: 'shape', shape: 'circle', palette: ['amber'] },
  star: { kind: 'shape', shape: 'star', palette: ['violet'] },
  q4: { kind: 'question', title: '都道府県はいくつ？', subtitle: '数字で答えてください', palette: ['violet', '#4c1d95'], illustration: 'dotGrid' },
  q5: { kind: 'question', title: '富士山の標高は？', subtitle: 'メートルで答えてください', palette: ['amber', '#92400e'], illustration: 'measuringColumn' },
  q5reveal: { kind: 'reveal', answer: '3,776 m', note: '±50 m まで正解', palette: ['amber'] },
  q6: { kind: 'question', title: '東京〜大阪の直線距離は？', subtitle: 'キロメートルで答えてください', palette: ['teal', '#134e4a'], illustration: 'routeLine' },
};

/**
 * 問題の定義。
 *
 * `image` / `revealImage` / 選択肢の `image` には DEMO_MEDIA のキーを書く。
 * seed 側が実際の assetId へ置き換える。
 */
export const DEMO_QUESTIONS = [
  {
    position: 1,
    type: 'choice',
    text: '富士山がまたがっているのは、静岡県と何県でしょう？',
    image: { key: 'q1', alt: '雪をかぶった山のイラスト' },
    revealImage: { key: 'q1reveal', alt: '正解は静岡県と山梨県' },
    explanation:
      '富士山は静岡県と山梨県にまたがっています。山頂付近の県境は現在も確定していません。',
    timeLimitSeconds: 20,
    points: 1000,
    choices: [
      { position: 1, text: '山梨県', isCorrect: true },
      { position: 2, text: '長野県', isCorrect: false },
    ],
  },
  {
    position: 2,
    type: 'choice',
    text: '日本でもっとも面積が大きい都道府県はどこでしょう？',
    image: { key: 'q2', alt: '大きさの違う四角形が入れ子になったイラスト' },
    explanation: '北海道の面積は約 83,000 平方キロメートルで、2 位の岩手県のおよそ 5 倍です。',
    timeLimitSeconds: 20,
    points: 1000,
    choices: [
      { position: 1, text: '岩手県', isCorrect: false },
      { position: 2, text: '北海道', isCorrect: true },
      { position: 3, text: '福島県', isCorrect: false },
    ],
  },
  {
    position: 3,
    type: 'choice',
    text: '正三角形はどれでしょう？',
    explanation: '3 つの辺の長さがすべて等しい三角形が正三角形です。',
    timeLimitSeconds: 15,
    points: 800,
    // 文章を持たない選択肢。代替テキストが必須になる例。
    choices: [
      { position: 1, text: null, isCorrect: true, image: { key: 'triangle', alt: '赤い三角形' } },
      { position: 2, text: null, isCorrect: false, image: { key: 'square', alt: '青い四角形' } },
      { position: 3, text: null, isCorrect: false, image: { key: 'circle', alt: 'オレンジ色の円' } },
      { position: 4, text: null, isCorrect: false, image: { key: 'star', alt: '紫色の星形' } },
    ],
  },
  {
    position: 4,
    type: 'number',
    text: '日本の都道府県はいくつあるでしょう？',
    image: { key: 'q4', alt: '点が並んだ格子のイラスト' },
    explanation: '1 都・1 道・2 府・43 県で合計 47 です。',
    timeLimitSeconds: 20,
    points: 1000,
    numberRule: { mode: 'exact', correctValue: '47' },
    unit: '都道府県',
    decimalPlaces: 0,
  },
  {
    position: 5,
    type: 'number',
    text: '富士山の標高は何メートルでしょう？（±50 m まで正解）',
    image: { key: 'q5', alt: '目盛りのついた柱のイラスト' },
    revealImage: { key: 'q5reveal', alt: '正解は 3,776 メートル' },
    explanation: '3,776 m です。この問題は ±50 m までを正解として扱います。',
    timeLimitSeconds: 25,
    points: 1200,
    numberRule: { mode: 'absolute_tolerance', correctValue: '3776', tolerance: '50' },
    unit: 'm',
    decimalPlaces: 0,
  },
  {
    position: 6,
    type: 'number',
    text: '東京駅から大阪駅までの直線距離はおよそ何キロメートルでしょう？',
    image: { key: 'q6', alt: '2 つの地点を結ぶ経路のイラスト' },
    explanation: 'およそ 400 km です。この問題は 380〜430 km を正解として扱います。',
    timeLimitSeconds: 30,
    points: 1200,
    numberRule: { mode: 'range', minValue: '380', maxValue: '430' },
    unit: 'km',
    decimalPlaces: 0,
  },
];

/**
 * ドメイン層の Question 形へ変換する。
 *
 * @param {(key: string) => {assetId: string, url: string, width: number, height: number}} resolveMedia
 * @returns {import('../../src/domain/quiz/question').Question[]}
 */
export function toDomainQuestions(resolveMedia) {
  const toRef = (ref) => {
    if (!ref) {
      return null;
    }
    const asset = resolveMedia(ref.key);
    return { assetId: asset.assetId, url: asset.url, alt: ref.alt, width: asset.width, height: asset.height };
  };

  return DEMO_QUESTIONS.map((question, index) => {
    const base = {
      id: `demo-${index + 1}`,
      position: question.position,
      text: question.text ?? null,
      image: toRef(question.image),
      revealImage: toRef(question.revealImage),
      timeLimitSeconds: question.timeLimitSeconds,
      points: question.points,
      explanation: question.explanation ?? null,
    };

    if (question.type === 'choice') {
      return {
        ...base,
        type: 'choice',
        choices: question.choices.map((choice, choiceIndex) => ({
          id: `demo-${index + 1}-${choiceIndex + 1}`,
          position: choice.position,
          text: choice.text ?? null,
          image: toRef(choice.image),
          isCorrect: choice.isCorrect,
        })),
      };
    }

    return {
      ...base,
      type: 'number',
      numberRule: question.numberRule,
      unit: question.unit ?? null,
      decimalPlaces: question.decimalPlaces,
    };
  });
}
