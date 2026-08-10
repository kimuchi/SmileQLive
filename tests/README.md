# テスト

SmileQ Live のテストは、目的別に 3 層へ分かれています。

| ディレクトリ           | 目的                                                             | 実行環境       |
| ---------------------- | ---------------------------------------------------------------- | -------------- |
| `tests/unit/**`        | ドメイン層・共通ライブラリの単体テスト（**バックエンド非依存**） | Vitest (jsdom) |
| `tests/integration/**` | Firestore Emulator を使う結合テスト                              | Vitest (jsdom) |
| `e2e/**`               | ブラウザを通した通しテスト                                       | Playwright     |

## 実行方法

```bash
# 単体 + 結合
pnpm exec vitest run

# 監視しながら
pnpm exec vitest

# カバレッジ
pnpm exec vitest run --coverage

# 型検査 / Lint
pnpm exec tsc --noEmit
pnpm exec eslint .
```

設定は `vitest.config.ts`（`environment: 'jsdom'` / `setupFiles: ./tests/setup.ts`）にあります。

## `tests/setup.ts`

- `@testing-library/jest-dom` のカスタムマッチャを登録します。
- サーバー用モジュールが読む**ダミー環境変数**を用意します。
  値は形式を満たすだけのもので、実際の Firebase へは接続しません。
- Firebase 版では**サーバー用の秘密情報が存在しない**ため
  （Cloud Run 実行サービスアカウントの ADC を使う。`docs/FIRESTORE_MODEL.md` §6）、
  ここに秘密情報は一切置きません。

## `tests/unit/**` の方針

単体テストの対象は **`src/domain/**` と `src/lib/**` だけ**です。
これらは Supabase / Firebase のどちらにも依存しないため、
移行の前後で**テストを 1 行も書き換えずに通ること**が、移行が正しいことの証明になります。

Firestore・Cloud Storage・HTTP に触れる検証は `tests/integration/**` の担当です。

### ファイル構成

```text
tests/unit/
├── _helpers/
│   └── question-factory.ts        テスト用の Question / MediaRef 生成
├── domain/
│   ├── answer/
│   │   ├── answer-dto.test.ts          代表値集計（上位5件・同数は数値昇順）
│   │   ├── number-judgement.test.ts    正誤判定の境界値・decimal.js の精度
│   │   └── number-normalizer.test.ts   全角/カンマ/空白の正規化と拒否条件
│   ├── media/
│   │   └── image-policy.test.ts        保存パスと usage 別の長辺上限
│   ├── quiz/
│   │   ├── public-question.test.ts     ★ 正解の非漏洩（回帰防止の要）
│   │   └── publish-validation.test.ts  公開前検証
│   └── room/
│       ├── scoring.test.ts             得点と同点時の順位規則
│       ├── state-machine.test.ts       全フェーズ × 全アクションの遷移可否
│       └── timer.test.ts               サーバー時刻補正とカウントダウン音
└── lib/
    ├── crypto/tokens.test.ts           トークン生成・ハッシュ・ログ秘匿
    ├── errors/app-error.test.ts        全コードの status と日本語メッセージ
    └── validation/schemas.test.ts      不正入力の拒否
```

## とくに重要なテスト

### 1. 正解を正解発表前に渡さない

`tests/unit/domain/quiz/public-question.test.ts` が最重要です。

`toPublicQuestion()` は参加者・投影画面へ問題を渡す唯一の入口です。
ここに正解が混ざると、Security Rules をすり抜けて正解が配信されてしまいます。

そのため、プロパティ単位の検査だけでなく
**`JSON.stringify()` した文字列そのもの**に対して
`isCorrect` / 正解値 / 解説 / `revealImage` が現れないことを検査しています。
将来 `Question` にフィールドが増えても、この検査が落ちて気づける形にしています。

`state-machine.test.ts` の `revealsAnswer` / `showsBreakdown` も対になる防波堤です。

### 2. 数値は文字列のまま扱う

`number-normalizer.test.ts` / `number-judgement.test.ts` は、
数値を JavaScript の `number` へ落とさないことを前提に書かれています。

Firestore の数値型は倍精度浮動小数点しか持たないため、
数値回答は `numberRaw` / `numberNormalized` の**文字列**として保存し、
判定は `decimal.js` だけで行います（`docs/FIRESTORE_MODEL.md` §1）。

`0.1 + 0.2 !== 0.3` で誤判定しないこと、
許容誤差・範囲の**両端を含む**ことを境界値で固定しています。

### 3. 締切はサーバー時刻で決める

`timer.test.ts` が検証するのは**表示用の計算**だけです。
実際の締切判定は Cloud Run の `Date.now()` が行い、クライアント時計は信用しません
（`docs/FIRESTORE_MODEL.md` §3.3）。この境界を崩さないでください。

## テストを書くときの注意

- **失敗するテストを削除・skip しない。** 落ちたら実装かテストのどちらが誤りかを判断する。
- `src/lib/crypto/tokens.ts` など `import 'server-only'` を持つモジュールを読む場合は、
  ファイル先頭で `vi.mock('server-only', () => ({}))` を宣言する。
  `server-only` は読み込むだけで例外を投げるマーカーパッケージのため。
- 効果音 (`src/lib/audio/**`) は投影画面専用。参加者向けコードから import しない
  （ESLint の `no-restricted-imports` で禁止済み）。
- 参加トークンをテスト出力へ残さない。ログ経路の検証には `redactPath` を使う。
- 日本語でテスト名・コメントを書く。`any` を使わない。
- `noUncheckedIndexedAccess` が有効なので、配列要素は `at()` や `find()` の
  戻り値を optional chaining で扱う。
