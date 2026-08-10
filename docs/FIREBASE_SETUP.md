# Firebase セットアップ手順 — SmileQ Live

SmileQ Live は永続状態のすべてを **Firestore** に置きます。
`onSnapshot` は状態の配信手段であり、正しさの根拠は常に Firestore のドキュメントです。

データモデルと「なぜそうなっているか」は **[docs/FIRESTORE_MODEL.md](./FIRESTORE_MODEL.md)** が最上位の基準です。
この文書は、その設計を実際の Firebase プロジェクトへ適用するための操作手順です。

---

## 0. 前提

| 項目 | 内容 |
|---|---|
| 認証基盤 | Firebase Authentication（司会 = Google / 参加者 = 匿名） |
| データベース | Cloud Firestore（ネイティブモード） |
| 画像 | Cloud Storage for Firebase |
| アプリ実行 | Cloud Run（Firebase Hosting は**使いません**） |
| サーバーの認証情報 | **不要**。Cloud Run 実行サービスアカウントの ADC を使う |

> **サービスアカウントの秘密鍵（JSON）は作らないでください。**
> Cloud Run 上の Admin SDK は実行サービスアカウントの権限で動きます。
> 鍵ファイルを作ると、それが最大の漏洩リスクになります（docs/FIRESTORE_MODEL.md §6）。

環境は分けることを強く推奨します。**Firestore を本番とステージングで共有しないでください。**

| 環境 | Firebase プロジェクト |
|---|---|
| 本番 | `smileq-live-production` |
| ステージング | `smileq-live-staging` |

---

## 1. プロジェクト作成

1. https://console.firebase.google.com で「プロジェクトを追加」
2. **既存の Google Cloud プロジェクトに Firebase を追加**するのが最も簡単です
   （Cloud Run と同じプロジェクトにすると、ADC の権限付与が 1 か所で済みます）
3. Google Analytics は不要（有効にしても構いませんが、本アプリは使いません）

作成後、**プロジェクトの設定 → 全般** で「プロジェクト ID」を控えます。
これが `FIREBASE_PROJECT_ID` になります。

### ウェブアプリを登録する

**プロジェクトの設定 → マイアプリ → ウェブ（`</>`）**

アプリ名は任意（例: `SmileQ Live Web`）。**Firebase Hosting は設定しません。**

登録後に表示される設定から次を控えます。

| 表示名 | 環境変数 | 秘密か |
|---|---|---|
| `apiKey` | `FIREBASE_API_KEY` | **秘密ではない**（公開前提の識別子） |
| `authDomain` | `FIREBASE_AUTH_DOMAIN` | 秘密ではない |
| `projectId` | `FIREBASE_PROJECT_ID` | 秘密ではない |
| `storageBucket` | `FIREBASE_STORAGE_BUCKET` | 秘密ではない |
| `appId` | `FIREBASE_APP_ID` | 秘密ではない（任意） |

> `apiKey` は「どのプロジェクトへ話しかけるか」を示す識別子であって、認可の鍵ではありません。
> 実際の保護は **Security Rules とサーバー側の認可**で行います。
> そのため `deploy/cloud-run.*.json` へ書いて構いません。

---

## 2. Authentication の設定

**Authentication → Sign-in method**

| プロバイダ | 設定 | 用途 |
|---|---|---|
| **Google** | 有効 | 司会者・管理者のログイン |
| **匿名** | 有効 | 参加者・投影担当 |
| メール／パスワード | 無効のまま | 使いません |

### 2.1 Google Workspace ドメインで絞る場合

Firebase コンソール側には「このドメインだけログインさせる」設定はありません。
本アプリでは **アプリ側の 2 段構え**で制御します。

| 層 | 仕組み | 設定場所 |
|---|---|---|
| 1. ドメイン制限（任意） | ID トークンの `hd` / メールドメインをサーバーで検証 | `ALLOWED_AUTH_DOMAINS` |
| 2. 司会者判定（必須） | `profiles/{uid}` の存在 | Firestore |

```jsonc
// deploy/cloud-run.production.json
{
  "allowedAuthDomains": ["example.co.jp"]
}
```

- 空配列（既定）なら**ドメイン制限なし**。外部の司会者を招ける代わりに、
  `profiles/{uid}` の作り方だけが唯一の関門になります。
- ブラウザが送る `hd` パラメータは改ざんできるため、**判定は必ずサーバー側**で行います。
  クライアントの `hd` はアカウント選択画面を絞るための UX ヒントにすぎません。

> **重要**: ログインできること（= Google アカウントを持っていること）と、
> 司会者であることは別です。詳細と運用ルールは
> **[docs/HOST_ACCESS.md](./HOST_ACCESS.md)** を必ず読んでください。

### 2.2 承認済みドメイン

**Authentication → Settings → 承認済みドメイン**

公開 URL を追加します。ここに無いドメインからはログインできません。

```text
localhost                      （既定で入っています）
quiz.example.jp                （カスタムドメイン）
smileq-live-xxxxx.a.run.app    （Cloud Run の既定 URL）
```

カスタムドメインを変更したら**必ずここを更新**してください
（[docs/CUSTOM_DOMAIN.md](./CUSTOM_DOMAIN.md) §4.2）。

### 2.3 匿名認証の割り当て

200 人規模のイベントでは、開場直後に匿名サインインが集中します。
**Authentication → Settings → ユーザー アクション**で匿名ユーザーの扱いを確認し、
必要なら定期的な整理（下記 §7）を計画してください。

---

## 3. 司会者ログインに使う OAuth 同意画面

Google プロバイダを有効化すると、Google Cloud 側に OAuth クライアントが自動生成されます。
社内利用だけなら **Google Cloud コンソール → API とサービス → OAuth 同意画面** で
ユーザーの種類を **内部（Internal）** にしておくと、Workspace 組織外のアカウントは
そもそもログイン画面を通過できません（多層防御の 1 つとして有効です）。

---

## 4. Firestore の作成

**Firestore Database → データベースの作成**

| 項目 | 値 | 備考 |
|---|---|---|
| モード | **ネイティブモード** | Datastore モードでは動きません |
| ロケーション | `asia-northeast1`（東京） | **後から変更できません** |
| 開始ルール | 「本番環境モードで開始」 | どのみち §6 で上書きします |

> ロケーションは Cloud Run のリージョンと揃えてください。
> 別リージョンにすると 1 回のトランザクションごとに往復遅延が乗り、
> 会場での回答受付が目に見えて遅くなります。

### インデックス

複合インデックスは `firebase/firestore.indexes.json` で管理し、§6 のコマンドで反映します。
**コンソールで手作業に作らないでください**（リポジトリと実体がずれます）。

---

## 5. Storage バケット

**Storage → 始める**

| 項目 | 値 |
|---|---|
| ロケーション | Firestore と同じ（`asia-northeast1`） |
| 既定バケット | `<project-id>.firebasestorage.app` |

このバケット名が `FIREBASE_STORAGE_BUCKET`（および既定の `MEDIA_BUCKET`）になります。

### 公開設定

**バケットは非公開のままにしてください。** `firebase/storage.rules` は
クライアントからの読み書きを**すべて拒否**しています。

- アップロードは Cloud Run（Admin SDK）経由のみ
- 表示は**署名付き URL**（期限つき）を API が返す
- 正解解説画像の URL は、正解発表まで参加者へ返さない

公開バケットにすると「URL を知っていれば誰でも見える」状態になり、
正解画像の秘匿という最重要要件が壊れます。

---

## 6. Rules とインデックスのデプロイ

Rules は **「万一クライアントが直接 Firestore を叩いても正解が 1 件も漏れない」ための最終防壁**です
（docs/FIRESTORE_MODEL.md §4）。コンソールで編集せず、必ずリポジトリから反映します。

```bash
# 反映先は deploy/cloud-run.<env>.json の firebaseProjectId から解決されます
npm run rules:deploy -- production
npm run rules:deploy -- staging

# プロジェクトを直接指定する場合
npm run rules:deploy -- --project my-firebase-project

# 実行されるコマンドの確認だけ
npm run rules:deploy -- --dry-run
```

初回は `firebase login` が必要です（未導入なら `npx --yes firebase-tools` が自動で使われます）。

反映されるもの:

| ファイル | 内容 |
|---|---|
| `firebase/firestore.rules` | 参加者から `rooms/{id}` と `quizzes/**` を到達不能にする |
| `firebase/firestore.indexes.json` | 複合インデックス |
| `firebase/storage.rules` | クライアントからの読み書きを全拒否 |

> 複合インデックスの構築には数分かかることがあります。**構築中は該当クエリが失敗します。**
> 本番反映は、イベント当日ではなく前日までに済ませてください。

### 反映前に必ず検証する

```bash
npm run test:rules       # エミュレータへ実際に適用して検証（Java が必要）
npm run test:emulator    # トランザクションの不変条件を実測
```

`npm run verify` にはこれらを**含めていません**（エミュレータと Java が必須のため）。
Rules を変更したときは手動で実行してください。CI では専用ジョブが実行します。

### ローカルでエミュレータを使う

```bash
npm run emulators
# Firestore 127.0.0.1:8080 / Auth 127.0.0.1:9099 / Storage 127.0.0.1:9199 / UI http://127.0.0.1:4000
```

`.env.local` に `FIRESTORE_EMULATOR_HOST` などを設定するとアプリがエミュレータへ向きます。
**本番環境では絶対に設定しないでください。**

---

## 7. 最初の司会者を作る

**アプリは `profiles/{uid}` を自動作成しません。** 初回ログインで自動的に司会者になる実装は、
Google アカウントを持つ全員に管理画面を開放することと同じです（docs/HOST_ACCESS.md）。

### 手順

1. 対象者に一度アプリへ Google ログインしてもらう（この時点では「権限がありません」と表示されます）
2. 管理スクリプトで登録する

```bash
# ADC を用意（初回のみ）
gcloud auth application-default login

npm run host:add -- you@example.com --name "あなたの名前"
npm run host:list
npm run host:remove -- someone@example.com
```

3. 対象者がもう一度ログインすると管理画面が使えます

### コンソールから作る場合

**Authentication** タブで対象ユーザーの `uid` を確認し、
**Firestore → profiles → ドキュメントを追加** で、ドキュメント ID にその `uid` を指定します。

| フィールド | 型 | 例 |
|---|---|---|
| `email` | string | `you@example.com` |
| `displayName` | string | `あなたの名前` |
| `createdAt` | timestamp | 現在時刻 |

> 匿名ユーザー（参加者・投影担当）には `profiles` を作らないでください。

---

## 8. バックアップ方針

Firestore は「誤って消したデータ」を自動では戻しません。次の 2 段構えを推奨します。

### 8.1 PITR（ポイントインタイム リカバリ）

直近 7 日間の任意の時点へ戻せます。**誤削除・誤更新に最も効きます。**

```bash
gcloud firestore databases update --enable-pitr --project <FIREBASE_PROJECT_ID>
```

### 8.2 定期エクスポート

イベント単位の記録を長期保存する場合は、Cloud Storage へエクスポートします。

```bash
# 保存先バケット（Firestore と同じロケーションに作ること）
gcloud storage buckets create gs://smileq-live-backup --location asia-northeast1 --project <PROJECT>

# 手動エクスポート（イベント終了後に実行する運用が簡単）
gcloud firestore export gs://smileq-live-backup/$(date +%Y%m%d) --project <FIREBASE_PROJECT_ID>
```

定期実行する場合は Cloud Scheduler から同じ操作を呼びます。

### 8.3 運用の目安

| タイミング | 操作 |
|---|---|
| 初回セットアップ時 | PITR を有効化 |
| 大きなイベントの前日 | 手動エクスポートを 1 回 |
| イベント終了後 | 手動エクスポート＋結果の書き出し |
| 定期 | バケットのライフサイクル設定で古い世代を自動削除 |

> **復元は必ず別プロジェクト／別データベースへ行ってから中身を確認**してください。
> 本番へ直接インポートすると、生きているデータを壊します。

---

## 9. チェックリスト

- [ ] Firebase プロジェクトを作成し、ウェブアプリを登録した
- [ ] Google プロバイダを有効化した
- [ ] 匿名認証を有効化した
- [ ] 承認済みドメインへ公開 URL を追加した
- [ ] Firestore をネイティブモード・`asia-northeast1` で作成した
- [ ] Storage バケットを作成した（**非公開のまま**）
- [ ] `npm run test:rules` が通る
- [ ] `npm run rules:deploy -- <env>` で Rules とインデックスを反映した
- [ ] PITR を有効化した
- [ ] 最初の司会者を `npm run host:add` で登録した
- [ ] `deploy/cloud-run.<env>.json` へ `firebase*` の値を書いた（秘密鍵は書かない）

---

## 10. よくあるつまずき

### `PERMISSION_DENIED: Missing or insufficient permissions`

クライアント（ブラウザ）から Firestore を読もうとして Rules に弾かれています。
参加者が購読してよいのは `rooms/{roomId}/public/state` **だけ**です。
`rooms/{roomId}` 本体には正解（`quizSnapshot`）が入っているため、意図的に読めません。

### `5 NOT_FOUND: The database (default) does not exist`

Firestore をまだ作成していません（§4）。デプロイは通っても起動直後に失敗します。
`npm run deploy:doctor` でも検出されます。

### `The query requires an index`

複合インデックスが未反映か、構築中です。

```bash
npm run rules:deploy -- <env> --only firestore:indexes
```

### 司会ログインは通るのに「権限がありません」と出る

仕様どおりです。`profiles/{uid}` がまだありません（§7）。

### `Firebase: Error (auth/unauthorized-domain)`

アクセスしているドメインが承認済みドメインに入っていません（§2.2）。

### エミュレータが起動しない

Java がありません。`npm run test:rules` は Java が無い場合スキップして終了コード 0 を返します。

```bash
# macOS
brew install openjdk
# Linux
sudo apt install default-jre
# Windows
# https://adoptium.net/
```
