# E2E テストと Security Rules テスト

SmileQ Live には「机上で読むだけでは守れない要件」が 2 つあります。

1. **正解を正解発表前に参加者へ渡さない**
2. **参加は二次元コードの参加 URL 直行だけ**（ルームコードの手入力を作らない）

この 2 つは、実際にブラウザで開き、実際の Firestore Security Rules を適用した状態で
確かめないと壊れたことに気づけません。そのための仕組みがこの文書の対象です。

| 何を確かめるか                        | 実行コマンド                    | Firebase     | ブラウザ |
| ------------------------------------- | ------------------------------- | ------------ | -------- |
| Firestore Security Rules              | `node scripts/test-rules.mjs`   | エミュレータ | 不要     |
| 画面の通し動作（Firebase 不要のもの） | `pnpm test:e2e`                 | 不要         | 必要     |
| 会場進行の通し（§37.3 の 1〜22）      | `pnpm test:e2e`（環境変数つき） | 必要         | 必要     |

単体テスト（`tests/unit/**`）と Firestore トランザクションのスモーク
（`tests/emulator/**` / `scripts/test-emulator.mjs`）は別担当です。`tests/README.md` を参照してください。

---

## 1. Firestore Security Rules のテスト

### 1.1 何を確かめているか

`firebase/firestore.rules` は「万一クライアントが直接 Firestore を叩いても
正解が 1 件も漏れない」ための最終防壁です。
アプリ側の実装が正しくても、ここが緩んでいれば会場で正解が先に見えてしまいます。

`tests/rules/security-rules.test.mjs` が、実際のエミュレータへルールを適用したうえで
次を検証します（現在 130 件）。

- 匿名参加者が `rooms/{id}` を読めない（`quizSnapshot` に正解が入っている）
- 匿名参加者が `quizzes/**` と `questions/**` を読めない（正解・解説）
  - `collectionGroup("questions")` で回り込んでも読めない
- 匿名参加者が `rooms/{id}/public/state` を **読める**
  - さらに、その中身に正解・解説・選択肢が入っていないことも確認
- 匿名参加者が `rooms/{id}/staff/progress` を **読めない**
- 参加者は自分の `members` / `answers` だけ読める。他人のものは読めない
- 司会者は自分のルーム・クイズを読める。他の司会者のものは読めない
- **あらゆるロール（未認証・参加者・投影担当・司会者・別の司会者）からの書き込みがすべて拒否される**

各行は「期待どおり拒否」「期待どおり許可」と明示して表示されます。

### 1.2 実行方法

```bash
node scripts/test-rules.mjs
```

必要なもの:

- **Java**（Firestore / Auth エミュレータは JVM 上で動きます）
  - macOS: `brew install openjdk`
  - Windows: <https://adoptium.net/>
  - Linux: `sudo apt install default-jre`
- **firebase-tools**
  - 常用するなら `npm install -g firebase-tools`
  - 未導入なら `pnpm dlx` / `npx` で一時実行を試みます（初回は取得に時間がかかります）

どちらも用意できない環境では、**理由を表示して終了コード 0 でスキップ**します。
エミュレータが無いだけで CI を赤くしないためです。

> このテストのために依存パッケージは 1 つも追加していません。
> `@firebase/rules-unit-testing` は使わず、導入済みの `firebase` / `firebase-admin` だけで
> 検証しています（Admin SDK で種データを作り、匿名サインインしたクライアント SDK で読み書きを試す）。

### 1.3 構成

```text
scripts/test-rules.mjs           firebase emulators:exec を起動する入口
tests/rules/run.mjs              エミュレータ内で *.test.mjs を順に実行する
tests/rules/harness.mjs          ロール別クライアントの用意・種データ・結果の記録
tests/rules/security-rules.test.mjs  検証本体
```

ロールは Auth エミュレータで**実際に匿名サインイン**させ、
得られた uid で種データを作ります。`request.auth.uid` の比較が本番と同じ経路で評価されます。

### 1.4 ルールを変えたときは

`firebase/firestore.rules` を変更したら必ずこのテストを通してください。
表の対応関係は `docs/FIRESTORE_MODEL.md` §4 にあります。

わざとルールを緩めて `node scripts/test-rules.mjs` を実行すると、
該当する検証が `NG` になることを確認できます（テストが空振りしていないことの確認）。

---

## 2. E2E テスト（Playwright）

### 2.1 前提

- Node.js 24 系（`.node-version` 参照）
- **本番ビルド済みであること**（`scripts/e2e-server.mjs` は `next start` を使います）
- Playwright のブラウザが導入済みであること

```bash
pnpm build
pnpm test:e2e
```

`playwright.config.ts` の `webServer` が `node scripts/e2e-server.mjs` を起動し、
`http://127.0.0.1:3100/api/health` が応答するまで待ちます。
すでに起動済みのサーバーを使いたい場合は `E2E_BASE_URL` を設定してください（webServer は起動されません）。

> `next.config.ts` は `output: 'standalone'` のため、`next start` を使うと
> Next.js が「standalone では `node .next/standalone/server.js` を使え」と警告します。
> E2E では `.next/static` をそのまま配れる `next start` の方が都合がよいため、この警告は想定どおりです。

### 2.2 Firebase 不要のテスト

Firebase の設定が無い環境でも必ず通ります。CI の既定はこの 3 本です。

| ファイル                                 | 何を守るか                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `tests/e2e/health.spec.ts`               | `/api/health` が 200 で `{ status:'ok', service:'smileq-live' }` を返す          |
| `tests/e2e/no-room-code.spec.ts`         | 無効な参加 URL で「この参加URLは無効」と出る。**ルームコード入力欄が存在しない** |
| `tests/e2e/participant-no-audio.spec.ts` | 参加者画面が音・振動を一切扱わない。音声ファイルも取りに行かない                 |

`no-room-code.spec.ts` は、参加 URL 解決 API の応答を Playwright の `page.route()` で
実物と同じ 404（`JOIN_LINK_INVALID`）に差し替えた場合と、差し替えない素の場合の両方を見ます。
**どちらでも入力欄が現れないこと**が本題です。

`participant-no-audio.spec.ts` は `addInitScript` で
`AudioContext` / `webkitAudioContext` / `HTMLAudioElement.prototype.play` / `navigator.vibrate`
を差し替えて呼び出しを検出します。
「フック自体が機能している」テストを併せて置いてあるので、
フックが壊れて無条件に通る状態になれば気づけます。

### 2.3 会場進行の通しテスト（Firebase が必要）

`tests/e2e/full-flow.spec.ts` は仕様書 §37.3 の 1〜22 を通しで実行します。
司会（API）・参加者 2 名（ブラウザ）・投影担当（ブラウザ）を同時に動かし、
**正解発表までは参加者のネットワークにも画面にも正解が出てこないこと**を確かめます。

環境変数が揃っていなければ **理由つきでスキップ**します（削除・コメントアウトはしないでください）。

#### 必要な環境変数

| 変数                     | 必須 | 内容                                                         |
| ------------------------ | ---- | ------------------------------------------------------------ |
| `E2E_FIREBASE_PROJECT`   | ○    | Firebase / Firestore のプロジェクト ID（エミュレータでも可） |
| `E2E_HOST_EMAIL`         | ○    | 司会者アカウントのメールアドレス                             |
| `E2E_AUTH_EMULATOR_HOST` | △    | 例 `127.0.0.1:9099`。Auth エミュレータで司会者を用意する     |
| `E2E_HOST_ID_TOKEN`      | △    | 実プロジェクト向け。手元で取得した Google の ID トークン     |
| `E2E_FIREBASE_API_KEY`   |      | 省略時はエミュレータ用のダミー                               |

△ は **どちらか一方が必要**です。

> サーバーは Google と匿名以外のサインイン方法を受け付けません
> （`src/app/api/auth/session/route.ts`）。メール＋パスワードでは司会者になれないため、
> Auth エミュレータでは `accounts:signInWithIdp` に偽の Google ID トークンを渡して
> 「google.com プロバイダ・メール確認済み」の利用者を作っています。
> 実 Google の同意画面は自動化できないため、実プロジェクトでは
> あらかじめ取得した ID トークンを `E2E_HOST_ID_TOKEN` で渡してください。

#### ローカルでの手順（エミュレータ）

1. エミュレータを起動する（別ターミナルで開いたままにする）

   ```bash
   firebase emulators:start --only firestore,auth --project smileq-live-emulator
   # firebase-tools が未導入なら
   pnpm dlx firebase-tools@15 emulators:start --only firestore,auth --project smileq-live-emulator
   ```

   エミュレータ UI は <http://127.0.0.1:4000> です。

2. アプリをエミュレータへ向けてビルド・起動できるよう `.env.local` を用意する

   ```dotenv
   FIREBASE_PROJECT_ID=smileq-live-emulator
   FIREBASE_API_KEY=emulator-api-key
   FIREBASE_AUTH_DOMAIN=127.0.0.1
   APP_BASE_URL=http://127.0.0.1:3100
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
   ```

3. 司会ユーザーを作る

   まず一度サインインさせて Auth 利用者を作り、その uid に対して `profiles/{uid}` を登録します。
   アプリは `profiles` を自動作成しません（`docs/HOST_ACCESS.md`）。

   ```bash
   # Auth エミュレータへ「Google でサインインした司会者」を作る
   curl -s -X POST \
     "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator-api-key" \
     -H 'content-type: application/json' \
     -d '{"postBody":"id_token={\"sub\":\"e2e-host\",\"email\":\"host@example.com\",\"email_verified\":true}&providerId=google.com","requestUri":"http://localhost","returnIdpCredential":true,"returnSecureToken":true}'

   # profiles/{uid} を作る（エミュレータへ向けたまま実行する）
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
   FIREBASE_PROJECT_ID=smileq-live-emulator \
     node scripts/host-admin.mjs add host@example.com --name "E2E 司会"
   ```

4. ビルドして E2E を実行する

   ```bash
   pnpm build

   E2E_FIREBASE_PROJECT=smileq-live-emulator \
   E2E_HOST_EMAIL=host@example.com \
   E2E_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
   E2E_FIREBASE_API_KEY=emulator-api-key \
     pnpm test:e2e
   ```

   スキップされる場合は、Playwright の出力に**どの環境変数が足りないか**が表示されます。

#### 検証している 22 手順

| #   | 手順                                     | 主に守っていること                               |
| --- | ---------------------------------------- | ------------------------------------------------ |
| 1   | 司会者がサインインする                   | Google / 匿名以外を受け付けない・`profiles` 必須 |
| 2   | クイズを作成する                         |                                                  |
| 3   | 選択式の問題を追加する                   |                                                  |
| 4   | 数値式（範囲判定）の問題を追加する       | 数値が**文字列のまま**往復する                   |
| 5   | クイズを公開する                         | 公開前検証                                       |
| 6   | ルームを作成し参加 URL を受け取る        | 平文トークンはこの応答だけ・クエリへ載せない     |
| 7   | 投影用リンクを発行する                   |                                                  |
| 8   | 投影画面が引き換えを終える               | URL からトークンが消える                         |
| 9   | 参加者 A が参加する                      | 参加後の URL にトークンが残らない                |
| 10  | 参加者 B が参加する                      |                                                  |
| 11  | 司会 Snapshot に 2 人見える              |                                                  |
| 12  | 参加受付を締め切る                       |                                                  |
| 13  | 第 1 問を表示する                        | 状態遷移と `stateVersion`                        |
| 14  | **正解発表前に正解が届いていない**       | ★ 最重要。画面にもネットワークにも出てこない     |
| 15  | 回答受付を開始する                       |                                                  |
| 16  | 参加者 A が正解を選ぶ                    | 受理しても正誤は返さない                         |
| 17  | 参加者 B が不正解を選ぶ                  |                                                  |
| 18  | 二重回答が拒否される                     | 決定的ドキュメント ID + `create()`               |
| 19  | 回答を締め切る／締切後の回答が拒否される | 締切判定はサーバー時刻                           |
| 20  | 正解を発表する                           | ここで初めて正解・解説が届く                     |
| 21  | 内訳とランキングを表示する               | 内訳は締切後のみ                                 |
| 22  | 数値問題（境界値）を出題して終了する     | range は**両端を含む**                           |

---

## 3. よくあるつまずき

**`本番ビルドが見つかりません（.next/BUILD_ID が無い）`**
`pnpm build` を先に実行してください。`scripts/e2e-server.mjs` は本番ビルドを起動します。

**`Executable doesn't exist at ...`**
Playwright のブラウザが未導入か、バージョンが合っていません。
`pnpm exec playwright install` を実行してください
（ブラウザの置き場所を変えている場合は `PLAYWRIGHT_BROWSERS_PATH` を設定します）。

**`ポート 3100 が使用中`**
前回の E2E サーバーが残っています。停止するか、`E2E_BASE_URL` で既存サーバーを指してください。

**Rules テストが「スキップします」で終わる**
Java か firebase-tools がありません。§1.2 を参照してください。
CI を壊さないため、これは失敗ではなく**意図的なスキップ**です。

**`firestore-debug.log` が増える**
エミュレータの出力です。コミット対象ではないので削除して構いません。

---

## 4. 触ってはいけないもの

- `playwright.config.ts`（testDir / webServer / baseURL は固定）
- `firebase/firestore.rules`（テストはルールに合わせる。ルールをテストに合わせない）
- `src/types/api.ts` / `src/domain/**`（E2E はこの契約の上で書く）
