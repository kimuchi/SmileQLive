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

### 既存の Google Cloud プロジェクトに Firebase を追加する

すでに Google Cloud プロジェクトがある場合（Cloud Run と同じプロジェクトを使いたい等）、
そのプロジェクトへ **Firebase リソースを追加**する必要があります。

GCP プロジェクトが存在していても Firebase が未追加だと、次のエラーになります。

```text
Firebase project 461269261166 not found.
```

プロジェクト**番号**で「not found」と言われるのが特徴で、権限不足と紛らわしいですが別物です。
`npm run firebase:config` はこの状態を検出して、追加するか確認します。

手動で追加する場合:

```bash
npx --yes firebase-tools@15 projects:addfirebase <PROJECT_ID>
```

うまくいかない場合は Firebase Management API を有効にしてから再実行してください。

```bash
gcloud services enable firebase.googleapis.com --project <PROJECT_ID>
```

> `firebase projects:list` は **Firebase が有効なプロジェクトだけ**を返します。
> 一覧に出てこない = まだ Firebase が追加されていない、と判断できます。

---

### 既存アプリと同じプロジェクトへ同居させる（推奨構成）

すでに別のアプリが動いている Google Cloud プロジェクトへ SmileQ Live を同居させられます。
**ただし既定のまま入れてはいけません。**

> #### 何が危険か
>
> `firebase deploy --only firestore:rules` は、対象データベースの
> **セキュリティルール全体を置き換えます**。
> 既定データベース `(default)` へ配信すると、
> **既存アプリのルールが消え、既存アプリが壊れます**（インデックスも同様）。

#### 分離のしくみ

SmileQ Live は既定で次のように、既存アプリと**物理的に分離**されます。

| 対象 | SmileQ Live | 既存アプリ |
|---|---|---|
| Firestore データベース | `smileq-live`（名前付き） | `(default)` |
| Firestore ルール／インデックス | `smileq-live` にのみ適用 | **触れない** |
| Storage バケット | `<project>-smileq-media`（専用） | 既定バケット |
| Storage ルール | 専用バケットにのみ適用 | **触れない** |
| ブラウザ用 API キー | `SmileQ Live Web`（専用） | 既存アプリのキー |
| Firebase Authentication | **共有** | 共有 |

Firestore は 1 プロジェクトに複数のデータベースを持て、
**ルールもインデックスもデータベースごとに独立**します。これを利用しています。

設定は `deploy/cloud-run.<env>.json` の 2 つのキーで決まります。

```jsonc
{
  "firestoreDatabaseId": "smileq-live",                    // (default) は使わない
  "mediaBucket": "idl-application-smileq-media"            // 専用バケット
}
```

`npm run gcp:bootstrap` がこの 2 つを自動で作成します。

```bash
gcloud firestore databases create --database smileq-live --location asia-northeast1 --type firestore-native
gcloud storage buckets create gs://idl-application-smileq-media --uniform-bucket-level-access --public-access-prevention
```

#### 事故を構造的に防いでいる箇所

`npm run rules:deploy` は、既存アプリ側を対象にしようとすると**必ず停止**します。

```text
✖ 既定データベース (default) を対象にしようとしています。
  既定データベースへ配信すると、同じプロジェクトに同居している
  既存アプリのセキュリティルールとインデックスを上書きしてしまいます。
```

```text
✖ Firebase 既定バケット (idl-application.firebasestorage.app) へ
  Storage ルールを配信しようとしています。
```

配信対象は常に `firestore:smileq-live,storage:<専用バケット>` の形になり、
`(default)` と既定バケットには触れません。

- `firebase.json` の `storage.bucket` は**プレースホルダのまま**にしてあります。
  手作業で `firebase deploy` を実行しても、既存アプリのバケットへは当たりません。
  実際の配信では `rules:deploy` がリポジトリ直下へ `.smileq-deploy.json` を生成し、
  `--config` で対象を確定させます（`.gitignore` 済み）。
  この一時設定を**リポジトリ直下**へ置くのは、firebase CLI が `--config` の
  置き場所をプロジェクトルートとみなし、`rules` / `indexes` の相対パスを
  そこから解決するためです（サブディレクトリへ置くと参照できません）。
- `npm run firebase:config` は `mediaBucket` が既定バケットを指していたら
  専用バケット名へ書き換えます。
- 既定バケットを使うと分かったうえで配信する場合だけ
  `npm run rules:deploy -- --allow-default-bucket` を使います
  （既存アプリの Storage ルールを引き継ぐ責任が生じます）。

#### API キーを分ける理由

Firebase が自動生成する「Browser key」は既存アプリのもので、
**HTTP リファラー制限が既存アプリのドメインに限定されている**ことが多くあります。
これを流用すると、ブラウザからのログインが次で拒否されます。

```text
Requests from referer https://q.iefainavi.net/ are blocked.
```

このエラーはブラウザ側では未定義のコードになり、画面には
「ログインできませんでした / 時間をおいて、もう一度お試しください」としか出ません。
`npm run firebase:config` は既存のキーを流用せず、
`SmileQ Live Web` という専用キーだけを使います。

制限に当たっているかは次で確認できます（**既存アプリのキーは変更しません**）。

```bash
npm run firebase:auth -- production      # 「公開 API キーの疎通確認」を見る
npm run firebase:config -- --new-api-key # 専用キーを作り直す
npm run deploy -- production             # 新しいキーを反映
```

#### 共有される部分（Authentication）

Firebase Authentication は**プロジェクト単位**なので既存アプリと共有します。
影響は次のとおりです。

- 匿名認証を有効にすると、プロジェクト全体で有効になる
- 利用者アカウントの一覧は共通になる
- SmileQ Live の司会者判定は `profiles/{uid}` の存在のみで行うため、
  既存アプリの利用者が管理画面へ入れるわけではない（docs/HOST_ACCESS.md）

既存アプリが Authentication を使っていない場合は、匿名認証の有効化による影響はありません。

---

### Firebase プロジェクトと Cloud Run プロジェクトは分けてもよい

同じ Google Cloud プロジェクトにすると ADC の権限付与が 1 か所で済むため**推奨**ですが、
**必須ではありません**。既存プロジェクトへ Firebase を追加する権限が無い場合、
自分が管理できる別プロジェクトで Firebase を使う構成でも動きます。

```bash
# 自分がオーナーになる新しい Firebase プロジェクトを作る
npx --yes firebase-tools@15 projects:create smileq-live --display-name "SmileQ Live"
npm run firebase:config -- --project=smileq-live
```

この場合、`deploy/cloud-run.production.json` は次のように**別々の ID**になります。

```jsonc
{
  "projectId": "idl-application",        // Cloud Run を動かす GCP プロジェクト
  "firebaseProjectId": "smileq-live",    // Firestore / Auth / Storage のプロジェクト
  "serviceAccount": "smileq-live-runtime@idl-application.iam.gserviceaccount.com"
}
```

**追加で必要な作業**は 1 つだけです。Cloud Run の実行サービスアカウントへ、
Firebase 側プロジェクトの権限を付与します。

```bash
FB=smileq-live
SA=smileq-live-runtime@idl-application.iam.gserviceaccount.com

for ROLE in roles/datastore.user roles/firebaseauth.admin roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$FB" \
    --member="serviceAccount:$SA" --role="$ROLE" --condition=None
done
```

> `npm run gcp:bootstrap` は `projectId` 側へ権限を付けます。
> プロジェクトを分ける場合は、上のコマンドで `firebaseProjectId` 側にも付与してください。

---

### プロジェクト側は正常なのに 403 になるとき

`npm run firebase:doctor` で次がすべて ✔ なのに `projects:addfirebase` が 403 を返す場合、
原因は**プロジェクトの外側**にあります。

- API 5 つが有効
- 利用規約に同意済み（他に Firebase プロジェクトを持っている）
- `roles/owner` を保有
- プロジェクト単位の組織ポリシーなし

確認する順序:

| # | 対象 | 確認方法 |
|---|---|---|
| 1 | **Google Workspace の Firebase 設定** | 管理コンソール → アプリ → その他の Google サービス → Firebase が「オン」か |
| 2 | 組織／フォルダの組織ポリシー | `npm run firebase:doctor` が祖先まで遡って表示します |
| 3 | プロジェクト固有か否か | 新規プロジェクトを作れるか試す（下記） |

#### 切り分け: 新規 Firebase プロジェクトを作れるか

```bash
npx --yes firebase-tools@15 projects:create smileq-live-test
```

| 結果 | 意味 |
|---|---|
| 作成できる | Firebase 自体は使える。`idl-application` 固有の問題 |
| 作成できない | 組織または Workspace 側で Firebase が制限されている |

#### Firebase の追加を妨げる代表的な組織ポリシー

| 制約 | 影響 |
|---|---|
| `constraints/gcp.restrictServiceUsage` | Firebase API の利用自体を止める |
| `constraints/iam.disableServiceAccountCreation` | Firebase のサービスエージェントを作れない |
| `constraints/gcp.resourceLocations` | リソース作成先の制限に引っかかる |

これらは**プロジェクト単位の一覧には出ません**（組織・フォルダから継承されるため）。
`npm run firebase:doctor` は祖先をたどって確認します。

---

### 権限が足りないと言われたら

```text
POST .../projects/<id>:addFirebase 403
{"error":{"code":403,"message":"The caller does not have permission"}}
```

`403 PERMISSION_DENIED` は **IAM 権限以外の原因でも返ります**。
オーナー権限があるのに失敗する場合、次の順に確認してください。

| # | 確認 | コマンド |
|---|---|---|
| 1 | Firebase Management API が有効か | `gcloud services enable firebase.googleapis.com --project <ID>` |
| 2 | CLI の認証スコープ | `npx --yes firebase-tools@15 login --reauth` |
| 3 | **Firebase 利用規約への同意** | https://console.firebase.google.com/ を一度開く |
| 4 | 組織ポリシー | `gcloud resource-manager org-policies list --project <ID>` |
| 5 | IAM ロール | 下記 |

> **3 が最も見落とされます。**
> その Google アカウント／Workspace 組織で Firebase を一度も使ったことが無い場合、
> 利用規約の同意が未了で API 側が 403 を返します。
> **コンソールを一度開いて同意すれば解消**し、以後は CLI だけで進められます。
> 「GUI 不要」は設定取得の話で、組織で初めて Firebase を使う場合の
> 初回同意だけは避けられないことがあります。

現在の自分のロールを確認する:

```bash
gcloud projects get-iam-policy <PROJECT_ID> \
  --flatten="bindings[].members" \
  --filter="bindings.members:$(gcloud config get-value account)" \
  --format="value(bindings.role)"
```

管理者に依頼する場合:

```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="user:<あなたのメール>" --role="roles/firebase.admin"
```

権限をもらえない場合は、上の「プロジェクトを分ける」構成が回避策になります。

---

### CLI だけで取得する（GUI 不要・推奨）

上の値は**コンソールを開かずに CLI で取得できます**。1 コマンドで設定ファイルまで書き込みます。

```bash
npm run firebase:login     # 初回のみ（ブラウザが開きます）
npm run firebase:config    # プロジェクトと Web アプリを選び、設定ファイルへ書き込む
```

このコマンドが行うこと:

1. `firebase projects:list` でアクセスできるプロジェクトを一覧表示し、選ばせる
2. `firebase apps:list WEB` で Web アプリを探す
   （**無ければ `firebase apps:create WEB "SmileQ Live"` で作成**するか確認する）
3. `firebase apps:sdkconfig WEB <appId>` で公開設定一式を取得する
4. `deploy/cloud-run.<env>.json` の `firebaseProjectId` / `firebaseApiKey` /
   `firebaseAuthDomain` / `firebaseStorageBucket` / `firebaseAppId` を書き込む
   （ファイルが無ければ `*.example.json` から作成する）
5. `mediaBucket` を **専用バケット `<project>-smileq-media`** に設定する
   （既定バケットのままだと、既存アプリの Storage ルールを上書きしてしまうため）

> 成否は firebase CLI の**終了コードではなく `--json` の出力内容**で判定します。
> CLI は正しい設定を返しながら 0 以外で終了することがあり
> （npx ラッパー経由の終了コード伝播など）、終了コードだけで判断すると
> **取得できている設定を捨ててしまう**ためです。
> 中身が正しく終了コードだけが 0 以外だった場合は ▲ で通知したうえで続行します。

よく使うオプション:

```bash
npm run firebase:config -- --print            # 書き込まず表示だけ
npm run firebase:config -- --project my-proj  # プロジェクトを直接指定
npm run firebase:config -- staging            # staging の設定ファイルへ書き込む
npm run firebase:config -- --app-id 1:...     # 既知の Web アプリを直接指定
```

ブラウザを開けない環境（SSH 越しなど）では:

```bash
npx --yes firebase-tools@15 login --no-localhost
```

#### 手動で同じことをする場合

```bash
# プロジェクト一覧
npx --yes firebase-tools@15 projects:list

# Web アプリ一覧（無ければ作成）
npx --yes firebase-tools@15 apps:list WEB --project <PROJECT_ID>
npx --yes firebase-tools@15 apps:create WEB "SmileQ Live" --project <PROJECT_ID>

# 公開設定一式（apiKey / authDomain / projectId / storageBucket / appId）
npx --yes firebase-tools@15 apps:sdkconfig WEB <APP_ID> --project <PROJECT_ID>
```

#### Web アプリ API が使えないとき

組織の制限や API の無効化により、`apps:list` / `apps:create` が
403 で拒否されることがあります。エラーは画面に出ず
`firebase-debug.log` にだけ書かれるため、`firebase:config` は
ログから HTTP ステータスと応答本文を取り出して表示し、
ログをリポジトリ直下へ残します。

まず切り分けます。

```bash
npm run firebase:doctor -- --project <PROJECT_ID>
```

「5. Web アプリ API が使えるか」で原因が分かります。

| 表示 | 対処 |
|---|---|
| API が無効 | `gcloud services enable apikeys.googleapis.com firebase.googleapis.com --project <PROJECT_ID>` |
| ログインのスコープ不足 | `npx --yes firebase-tools@15 login --reauth` |
| 403（上記以外） | `roles/firebase.developAdmin` の付与、組織ポリシーの確認 |

**登録済みの Web アプリがある場合**は、一覧を経由せず appId を直接指定できます。

```bash
npm run firebase:config -- --project <PROJECT_ID> --app-id 1:000000000000:web:xxxxxxxx
```

#### Web アプリ登録なしでも進められる

`firebase:config` は Web アプリから取得できないと、**gcloud の API キーへ自動で切り替えます**。

```bash
gcloud services api-keys list --project <PROJECT_ID>
gcloud services api-keys get-key-string <KEY_ID> --project <PROJECT_ID>
```

SmileQ Live に必要な値はこれで揃います。

| 値 | 由来 |
|---|---|
| `firebaseApiKey` | API キーの文字列（実体は Google Cloud の API キー） |
| `firebaseAuthDomain` | `<PROJECT_ID>.firebaseapp.com`（プロジェクト ID から決まる） |
| `firebaseProjectId` | プロジェクト ID |
| `firebaseAppId` | **空でよい**（Analytics 用。Auth と Firestore は使わない） |

`appId` が任意なのは、Firebase Authentication と Firestore の Web SDK が
`apiKey` / `authDomain` / `projectId` だけで動くためです
（`src/lib/env/server-env.ts` の `firebaseAppId()` も `null` を許容しています）。

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

500 人規模のイベントでは、開場直後に匿名サインインが集中します。
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
