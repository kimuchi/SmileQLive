# デプロイ手順書 — SmileQ Live

Google Cloud Run へ SmileQ Live をデプロイするための手順書です。
**Windows / macOS / Linux のどれでも同じコマンドで実行できます。**
Bash や PowerShell 専用のスクリプトは使いません。すべて Node.js スクリプトが `gcloud` を子プロセスとして呼び出します。

---

## 0. まずこれだけ

すでに初期設定が終わっている環境であれば、デプロイは次の 1 コマンドです。

```bash
npm run deploy
```

初めての場合は「[2. 初回セットアップ](#2-初回セットアップ)」から順に進めてください。

---

## 1. 全体像

```text
開発PC                          Google Cloud                     Firebase
  │                                  │                              │
  │  npm run deploy                  │                              │
  ├─ ① 事前チェック                  │                              │
  │   （gcloud/Git/lint 等）          │                              │
  ├─ ② gcloud run deploy --source . │                              │
  │      └─ ソースを Cloud Build へ  │                              │
  │            └─ Dockerfile で      │                              │
  │               Linux イメージ作成 │                              │
  │                  └─ Artifact Registry へ push                   │
  │                     └─ Cloud Run へリビジョン作成               │
  ├─ ③ APP_BASE_URL の確定           │                              │
  ├─ ④ カスタムドメイン状態の確認    │                              │
  └─ ⑤ /api/health で疎通確認        │                              │
                                     │                              │
  npm run rules:deploy ──────────────┼──────────────────────────────► Security Rules / インデックス
                                     │                              │
                   Cloud Run ────────┴─ ADC（実行サービスアカウント）─► Firestore / Auth / Storage
                   ブラウザ ─────────── onSnapshot（読み取りのみ）──► rooms/{id}/public/state
```

- **ローカルに Docker は不要**です。イメージは Cloud Build 上で作られるため、開発 PC の CPU アーキテクチャに依存しません。
- 同じコンテナイメージをステージング／本番で使い回せるよう、`NEXT_PUBLIC_*` によるビルド時埋め込みを使っていません。Firebase の公開設定（`apiKey` 等）は**実行時環境変数**から読み込みます。
- **アプリのデプロイと Security Rules の反映は別コマンド**です。Rules を変えたら `npm run rules:deploy` を忘れないでください。

---

## 2. 初回セットアップ

### 2.1 開発 PC に必要なもの

| ツール | 確認コマンド | 備考 |
|---|---|---|
| Node.js 24 LTS | `node -v` | `.nvmrc` / `.node-version` に `24` を固定済み |
| Corepack / pnpm | `corepack enable` → `pnpm -v` | `npm` でも動きますが pnpm 推奨 |
| Git | `git --version` | |
| Google Cloud CLI | `gcloud version` | https://cloud.google.com/sdk/docs/install |

まとめて確認するコマンドを用意しています。

```bash
npm run deploy:doctor
```

### 2.2 依存関係のインストール

```bash
corepack enable
pnpm install --frozen-lockfile
```

> `npm install` でも動作しますが、`pnpm-lock.yaml` を正とするため pnpm を推奨します。
> `npm run deploy` 自体は、npm / pnpm どちらから実行しても動きます
> （スクリプトが呼び出し元のパッケージマネージャを自動判定します）。
> `npm install` が作る `package-lock.json` は `.gitignore` 済みです
> （ロックファイルを 2 つ抱えないため。デプロイ前のクリーン判定も汚しません）。

**この手順を飛ばすと `npm run deploy` は検証段階で止まります**
（`'eslint' は認識されていません` のような失敗になります）。
`npm run deploy:doctor` の「依存パッケージ」で導入済みか確認できます。

#### Windows で `corepack enable` が EPERM で失敗する場合

```text
Internal Error: EPERM: operation not permitted, open 'C:\Program Files\nodejs\yarn'
```

Node.js を `C:\Program Files\nodejs` に入れていると、corepack がそこへシムを書き込もうとして
**管理者権限が無いと失敗**します。次のいずれかで解決してください。

**方法 A: pnpm を直接入れる（管理者権限が不要。おすすめ）**

```powershell
npm install -g pnpm
pnpm --version
pnpm install --frozen-lockfile
```

npm のグローバル領域は `%APPDATA%\npm` でユーザー権限のまま書き込めます。

**方法 B: 管理者として実行**

PowerShell を右クリック →「管理者として実行」してから:

```powershell
corepack enable
```

そのあとは通常の PowerShell に戻って `pnpm install --frozen-lockfile` を実行できます。

**方法 C: corepack のシム置き場をユーザー領域にする**

```powershell
mkdir "$env:LOCALAPPDATA\corepack-bin"
corepack enable --install-directory "$env:LOCALAPPDATA\corepack-bin"
# PATH へ追加（現在のセッションのみ）
$env:PATH = "$env:LOCALAPPDATA\corepack-bin;$env:PATH"
```

恒久化する場合は「システム環境変数の編集」→ ユーザーの `Path` に
`%LOCALAPPDATA%\corepack-bin` を追加してください。

**方法 D: pnpm を使わず npm だけで進める**

```powershell
npm install
npm run verify
npm run deploy
```

`pnpm-lock.yaml` の代わりに `package-lock.json` が作られます。依存関係のバージョンは
`package.json` で固定しているため動作しますが、**Cloud Build 側のコンテナビルドは
`pnpm-lock.yaml` を使う**（Dockerfile がそう書かれている）ため、
ロックファイルを更新した場合は pnpm 側も揃えてください。

> npm 11 では次の警告が出ますが、**そのままで問題ありません**。
>
> ```text
> npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:
> npm warn allow-scripts   unrs-resolver@1.12.2 / esbuild@0.28.2
> ```
>
> esbuild はプラットフォーム別パッケージ（optionalDependencies）から解決されるため、
> postinstall を承認しなくても動作します。承認したい場合は
> `npm approve-scripts --allow-scripts-pending` を実行してください。

> どの方法を選んでも `npm run deploy` は動きます。デプロイスクリプトは
> 呼び出し元のパッケージマネージャを自動判定します。

#### `pnpm: The term 'pnpm' is not recognized`

`corepack enable` が失敗した状態です。上の方法 A〜D のいずれかを実施してください。
現在の状態は次のコマンドで確認できます。

```powershell
npm run deploy:doctor
```

### 2.3 Firebase の準備

先に **[docs/FIREBASE_SETUP.md](./FIREBASE_SETUP.md)** を実施してください。
デプロイに必要なのは、**すべて公開してよい設定だけ**です。

| 値 | 用途 | 置き場所 |
|---|---|---|
| `projectId` | Firebase / GCP プロジェクト ID | `deploy/cloud-run.*.json` |
| `apiKey` | ブラウザの Firebase SDK 初期化 | `deploy/cloud-run.*.json` |
| `authDomain` | ログインのリダイレクト先 | `deploy/cloud-run.*.json` |
| `storageBucket` | 画像の保存先 | `deploy/cloud-run.*.json` |
| `appId`（任意） | ウェブアプリ識別子 | `deploy/cloud-run.*.json` |

> ### サーバー用の秘密情報はありません
>
> Supabase 版では `SUPABASE_SECRET_KEY` を Secret Manager から注入していましたが、
> **Firebase 版では不要になりました。**
> Cloud Run 上の Admin SDK は、実行サービスアカウントの
> **ADC（Application Default Credentials）** で Firestore / Auth / Storage を使います。
>
> - Secret Manager の作成・値登録の手順は**不要**です（Turnstile を使う場合のみ必要）
> - **サービスアカウントの秘密鍵（JSON）を作らないでください。** 作れば、それが最大の漏洩経路になります
> - `apiKey` は秘密情報ではありません。公開前提の識別子であり、保護は Security Rules とサーバー側の認可が担います
>
> 詳細: [docs/FIRESTORE_MODEL.md](./FIRESTORE_MODEL.md) §6

### 2.4 デプロイ設定ファイルを作る

```bash
# 本番
cp deploy/cloud-run.production.example.json deploy/cloud-run.production.json

# ステージング（任意）
cp deploy/cloud-run.staging.example.json deploy/cloud-run.staging.json
```

作成したファイルを編集します。

```jsonc
{
  "projectId": "my-gcp-project",                 // ← Google Cloud のプロジェクト ID
  "region": "asia-northeast1",                   // ← 東京
  "serviceName": "smileq-live",
  "serviceAccount": "smileq-live-runtime@my-gcp-project.iam.gserviceaccount.com",

  "customDomain": "quiz.example.jp",             // ← 使わないなら "" にする
  "domainMode": "domain-mapping",                // ← または "load-balancer"
  "appBaseUrl": "https://quiz.example.jp",       // ← customDomain と揃える

  "firebaseProjectId": "my-firebase-project",
  "firebaseApiKey": "AIzaSy....",                // ← 秘密ではない（公開前提の識別子）
  "firebaseAuthDomain": "my-firebase-project.firebaseapp.com",
  "firebaseStorageBucket": "my-firebase-project.firebasestorage.app",
  "firebaseAppId": "1:000000000000:web:....",    // ← 任意
  "firestoreDatabaseId": "smileq-live",          // ← 専用 DB。(default) は使わない

  "allowedAuthDomains": [],                      // ← 空 = ドメイン制限なし
  "mediaBucket": "my-firebase-project-smileq-media",   // ← 専用バケット。既定バケットとは分ける

  "minInstances": 1,                             // ← 本番は 1 以上を推奨
  "maxInstances": 10,
  "concurrency": 80
}
```

> **重要**
> - `deploy/cloud-run.*.json`（実値ファイル）は `.gitignore` 済みで、`.gcloudignore` / `.dockerignore` にも入っているため、Git にも Cloud Build のソースにも最終コンテナにも含まれません。
> - **サービスアカウントの秘密鍵をここへ貼らないでください。** `private_key` や `-----BEGIN PRIVATE KEY-----` を検出するとスクリプトが停止します。
> - `allowedAuthDomains` を空にすると、司会者かどうかは `profiles/{uid}` の存在だけで決まります（[docs/HOST_ACCESS.md](./HOST_ACCESS.md)）。
> - **`your-gcp-project-id` などの雛形の値が残っていると、スクリプトは開始前に停止します。**
>   とくに `projectId` だけ直して `serviceAccount` を直し忘れる事故が起きやすいため、
>   `serviceAccount` は必ず `<name>@<projectId>.iam.gserviceaccount.com` の形にしてください。
>   `npm run firebase:config` を使えば、この 2 つも自動で揃います。

> **firebase CLI の認証は期限切れになります。**
> `Authentication Error: Your credentials are no longer valid.` が出たら取り直してください。
>
> ```bash
> npm run firebase:login
> ```
>
> `npm run rules:deploy` は本番の確認プロンプトより**前**に認証を確かめます
> （「反映しますか？」に答えたあとで失敗しないようにするため）。

### 2.5 Google Cloud の初期設定

```bash
npm run firebase:config -- production
npm run gcp:bootstrap -- production
npm run firebase:auth -- production
```

> `firebase:auth` は Authentication の初期化・匿名認証の有効化・承認済みドメインの追加を行います。
> これを飛ばすと `npm run host:add` が
> `There is no configuration corresponding to the provided identifier.` で失敗します
> （API を有効化しただけでは Auth は使えず、プロジェクトごとの初期化が要るため）。
> **Google プロバイダの有効化だけはコンソールでの操作が必要です**（OAuth クライアントの作成を伴うため）。
> コマンドが該当の URL を表示します。

このスクリプトが行うこと（**冪等**。既存リソースは壊しません）:

1. 必要な API の有効化
   `run` / `cloudbuild` / `artifactregistry` / `iam` / `iamcredentials` / `logging` / `monitoring` /
   **`firestore` / `firebase` / `firebasestorage` / `firebaserules` / `identitytoolkit`**
2. Cloud Run 実行用サービスアカウントの作成（デフォルトの広い権限は使いません）
3. 実行用サービスアカウントへ Firebase の権限を付与

   | ロール | 用途 |
   |---|---|
   | `roles/datastore.user` | Firestore の読み書き |
   | `roles/firebaseauth.admin` | セッションクッキー発行・ユーザー管理 |
   | `roles/storage.objectAdmin` | 画像の読み書き |
   | `roles/iam.serviceAccountTokenCreator` | 署名付き URL の発行（自分自身へ付与） |

4. Cloud Build 用サービスアカウントへ、ビルドとデプロイに必要なロールを付与
5. 実行者へ `roles/iam.serviceAccountUser` を付与
6. Secret Manager のシークレット作成 — **`turnstileSecretName` を設定した場合のみ**

権限が足りずに失敗した場合は、**必要なロールと実行すべきコマンドを表示して終了**します。管理者へその内容をそのまま依頼してください。

> 署名付き URL は「秘密鍵での署名」ではなく **IAM の signBlob** で発行します。
> そのため `roles/iam.serviceAccountTokenCreator` を実行サービスアカウント自身へ付与します。
> これが無いと画像の URL 発行だけが失敗します（起動もヘルスチェックも通るため気付きにくい症状です）。

### 2.6 Secret Manager について

**既定では不要です。** Firebase 版にはサーバー用の秘密情報が存在しません
（Cloud Run の ADC で認証します。[docs/FIRESTORE_MODEL.md](./FIRESTORE_MODEL.md) §6）。

`npm run deploy` も、Secret の存在確認を **`turnstileSecretName` が設定されている場合だけ**行います。

Turnstile（参加登録の CAPTCHA）を使う場合のみ:

```jsonc
// deploy/cloud-run.production.json
{
  "turnstileSiteKey": "0x4AAAA...",                      // 公開キー
  "turnstileSecretName": "smileq-live-turnstile-production"  // ← Secret Manager 上の「名前」だけ
}
```

```bash
npm run gcp:bootstrap -- production        # 箱を作る
gcloud secrets versions add smileq-live-turnstile-production \
  --project my-gcp-project --data-file=-   # 値を登録
```

実行後に値を貼り付け、macOS / Linux は `Ctrl+D`、Windows は `Ctrl+Z` → `Enter` で確定します。

> Secret の値をソース・JSON・`.env.example`・CI ログへ書かないでください。

### 2.7 Security Rules とインデックスの反映

```bash
npm run rules:deploy -- production
```

`firebase/firestore.rules` は **「クライアントが直接 Firestore を叩いても正解が漏れない」ための最終防壁**です。
アプリのデプロイとは独立しているため、**Rules を変更したら必ずこのコマンドを実行**してください。

反映前に検証しておくことを強く推奨します（Java が必要）。

```bash
npm run test:rules       # Rules をエミュレータへ適用して検証
npm run test:emulator    # トランザクションの不変条件を実測
```

> 複合インデックスの構築には数分かかることがあり、**構築中は該当クエリが失敗します**。
> 本番反映はイベント当日ではなく前日までに済ませてください。

詳細は [docs/FIREBASE_SETUP.md](./FIREBASE_SETUP.md) §6 を参照してください。

### 2.8 最初の司会者を登録する

デプロイしただけでは、まだ誰も管理画面を使えません。
**アプリは `profiles/{uid}` を自動作成しません**（[docs/HOST_ACCESS.md](./HOST_ACCESS.md)）。

```bash
gcloud auth application-default login       # 初回のみ
npm run host:add -- you@example.com --name "あなたの名前"
npm run host:list
```

---

## 3. デプロイする

```bash
npm run deploy
```

### 3.1 対象環境の決まり方

`npm run deploy` は次の順で対象を決めます。

1. コマンドライン引数 — `npm run deploy -- staging`
2. 環境変数 — `SMILEQ_DEPLOY_ENV=staging npm run deploy`
3. `deploy/` にある設定ファイルが 1 つだけなら、それ
4. 両方あるなら **production**（本番は Enter で進める確認が 1 回だけ出ます。`--yes` で省けます）

明示的に指定するコマンドも用意しています。

```bash
npm run deploy:staging
npm run deploy:production
```

### 3.2 オプション

| オプション | 意味 |
|---|---|
| `--yes` | 確認プロンプトを省略（CI 用） |
| `--skip-verify` | `lint` / `typecheck` / `test` / `build` を省略（本番では非推奨） |
| `--skip-domain` | カスタムドメインの状態確認を省略 |
| `--dry-run` | 実行せず、発行される `gcloud` コマンドだけ表示 |
| `--no-traffic` | トラフィックを移さずリビジョンだけ作成（カナリア用） |

例:

```bash
npm run deploy -- production --dry-run
npm run deploy -- staging --skip-verify
```

### 3.3 デプロイが行うこと

| 段階 | 内容 | 失敗したら |
|---|---|---|
| 1 | `gcloud` の存在・ログイン・プロジェクトアクセスを確認 | 対処コマンドを表示して停止 |
| 2 | Git の状態確認（**本番のみ**: 作業ツリーがクリーン / 許可ブランチ） | 停止 |
| 3 | Secret の確認（**Turnstile 使用時のみ**。既定では「不要」と表示して通過） | 登録コマンドを表示して停止 |
| 4 | `npm run verify`（lint → typecheck → test → build → 成果物検査） | 停止 |
| 5 | **本番のみ**: `production` と入力させる確認 | 停止 |
| 6 | `gcloud run deploy --source .`（Cloud Build でイメージ作成） | 停止 |
| 7 | `APP_BASE_URL` の確定（カスタムドメイン → 設定値 → Cloud Run URL） | — |
| 8 | カスタムドメインのマッピング状態を確認 | 警告のみ |
| 9 | `/api/health` へリトライ付きで疎通確認 | 警告のみ |

### 3.4 Cloud Run に設定される値

| 項目 | ステージング | 本番 | 設定キー |
|---|---:|---:|---|
| CPU | 1 | 1 | `cpu` |
| メモリ | 1Gi | 1Gi | `memory` |
| 同時実行数 | 80 | 80 | `concurrency` |
| 最小インスタンス | 0 | 1 | `minInstances` |
| 最大インスタンス | 5 | 10 | `maxInstances` |
| リクエストタイムアウト | 60s | 60s | `timeout` |
| ingress | all | all | `ingress` |
| 未認証アクセス | 許可 | 許可 | 固定 |
| 起動プローブ | `/api/health` | `/api/health` | `optionalFlags.startupProbe` |

- 未認証アクセスを許可するのは、参加者がログインなしで参加ページを開くためです。**認可はアプリケーション内部（Firebase Auth のセッションクッキー + 役割チェック）で行います。**
- `minInstances` は費用に直結します。イベントが無い期間は 0 へ戻せます（[docs/OPERATIONS.md](./OPERATIONS.md) 参照）。

環境変数として渡されるもの:

```text
NODE_ENV=production
APP_ENV=production|staging
HOSTNAME=0.0.0.0
FIREBASE_PROJECT_ID=my-firebase-project
FIREBASE_API_KEY=AIzaSy...
FIREBASE_AUTH_DOMAIN=my-firebase-project.firebaseapp.com
FIREBASE_STORAGE_BUCKET=my-firebase-project.firebasestorage.app
FIREBASE_APP_ID=1:000000000000:web:...        （設定した場合のみ）
ALLOWED_AUTH_DOMAINS=example.co.jp            （設定した場合のみ）
APP_BASE_URL=https://quiz.example.jp
MEDIA_BUCKET=my-firebase-project.firebasestorage.app
PRESENTATION_LINK_TTL_MINUTES=480
LOG_LEVEL=info
```

シークレットとしてマウントされるもの:

```text
（既定ではありません）
TURNSTILE_SECRET_KEY = <turnstileSecretName>:latest   ← Turnstile を使う場合のみ
```

Turnstile を使わない場合、デプロイは `--clear-secrets` を付けて実行され、
旧構成のシークレットマウントが残らないようにします。

Firestore / Auth / Storage への認証情報は**環境変数にもシークレットにも現れません**。
Cloud Run が実行サービスアカウントの ADC を自動的に提供します。

`PORT` は **設定しません**。Cloud Run が注入する値をそのまま使います。

---

## 4. カスタムドメイン

カスタムドメインの設定は独立した手順書にまとめています。

→ **[docs/CUSTOM_DOMAIN.md](./CUSTOM_DOMAIN.md)**

要点だけ:

```bash
# 設定ファイルに customDomain を書いてから
npm run domain:map -- production      # 設定を作成し、登録すべき DNS レコードを表示
npm run domain:status -- production   # 現在の状態を確認
```

ドメイン確定後は **必ず** 次を行ってください。

1. `appBaseUrl` を `https://<正式ドメイン>` に設定して再デプロイ
2. **Firebase Authentication → Settings → 承認済みドメイン**へ正式ドメインを追加
   （ここに無いドメインからはログインできません）
3. **既存ルームの参加用二次元コードを再発行**（古い QR は旧ドメインを指しています）

---

## 5. CI からデプロイする

> **いまは自動デプロイを止めています。**
> `.github/workflows/deploy.yml` は **Actions から手動実行したときだけ**動きます
> （GitHub の Actions → Deploy to Cloud Run → Run workflow → デプロイ先を選ぶ）。
> `main` へ push しても本番は入れ替わりません。デプロイは手元の `npm run deploy` か、
> この手動実行で行ってください。
>
> 自動へ戻すには、下の変数をすべて設定したうえで `deploy.yml` の `push:` の
> 2 行のコメントを外します。

ローカルと CI で**同じスクリプト**を使います。デプロイロジックを二重に持ちません。

`.github/workflows/deploy.yml` を用意済みです。必要な設定:

| GitHub 側の設定 | 値 |
|---|---|
| Variables: `GCP_PROJECT_ID` | Google Cloud のプロジェクト ID |
| Variables: `GCP_REGION` | `asia-northeast1` |
| Variables: `CLOUD_RUN_SERVICE` | Cloud Run のサービス名 |
| Variables: `GCP_RUNTIME_SERVICE_ACCOUNT` | 実行用サービスアカウント |
| Variables: `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity 連携のプロバイダ |
| Variables: `GCP_DEPLOYER_SERVICE_ACCOUNT` | デプロイ実行用サービスアカウント |
| Variables: `FIREBASE_PROJECT_ID` | Firebase プロジェクト ID（GCP と同一なら省略可） |
| Variables: `FIREBASE_API_KEY` | ウェブアプリの apiKey |
| Variables: `FIREBASE_AUTH_DOMAIN` / `FIREBASE_STORAGE_BUCKET` / `FIREBASE_APP_ID` | 省略時はプロジェクト ID から補完 |
| Variables: `ALLOWED_AUTH_DOMAINS` | カンマ区切り。空ならドメイン制限なし |
| Variables: `APP_BASE_URL` / `CUSTOM_DOMAIN` | 正式ドメイン |

**すべて Variables（Secrets ではない）で足ります。**
Firebase 版のデプロイに秘密情報は要りません。

ワークフローは設定 JSON を実行時に生成し、
`node scripts/deploy-rules.mjs <env> --yes` → `node scripts/deploy-cloud-run.mjs <env> --yes` の順に呼びます。
サービスアカウントキー（JSON 鍵）は使わず、Workload Identity 連携を推奨します。

### 5.1 依存パッケージの脆弱性検査（CI の `dependency audit`）

CI は `pnpm audit --audit-level moderate` を実行し、moderate 以上の勧告があれば止まります。

**当てはまらないと確認できた勧告だけ**、`package.json` の
`pnpm.auditConfig.ignoreGhsas` へ登録しています。全体を素通しにはしていないので、
登録していない勧告が出れば CI は止まります。

| 勧告 | 経路 | 登録している理由 | 外す条件 |
|---|---|---|---|
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)（uuid < 11.1.1） | `firebase-admin` → `@google-cloud/storage@7` → `gaxios@6` → `uuid@9` | 欠陥は **v3/v5/v6 に呼び出し側のバッファを渡したとき**の境界チェック漏れ。gaxios は `v4()` を引数なしで 1 回だけ呼び、multipart の境界文字列を作るためだけに使っている（`gaxios/build/src/gaxios.js`）。このアプリは uuid を直接使っていない | `@google-cloud/storage` が gaxios 7 系へ上がったとき（gaxios 7 は uuid に依存していない）。`firebase-admin` を上げたら、この行を消して `pnpm audit` を通してみる |

登録を増やすときは、**「なぜ当てはまらないか」を確認した根拠**と**外す条件**を必ずこの表へ書いてください。
理由の書けない勧告は、無視ではなく直してください。

---

## 6. ロールバック

```bash
# リビジョン一覧
gcloud run revisions list --service smileq-live --region asia-northeast1 --project my-gcp-project

# 直前のリビジョンへ 100% 戻す
gcloud run services update-traffic smileq-live \
  --to-revisions smileq-live-00012-abc=100 \
  --region asia-northeast1 --project my-gcp-project
```

Firestore はスキーマレスですが、**アプリを戻してもデータは戻りません**。
ドキュメント構造を変えるリリースでは、次の順を守ってください。

1. 新旧どちらの構造でも読める形でアプリをデプロイする（後方互換）
2. 動作確認
3. 次回リリースで旧フィールドの読み取りを外す

Security Rules も同様に、**新しいルールを先に反映**してからアプリを出します
（`.github/workflows/deploy.yml` もその順序です）。
Rules だけを戻したい場合は、前のコミットをチェックアウトして `npm run rules:deploy` を実行します。

データそのものを戻す必要が出た場合は PITR を使います（[docs/FIREBASE_SETUP.md](./FIREBASE_SETUP.md) §8）。
**復元は必ず別データベースへ行い、中身を確認してから反映**してください。

---

## 7. トラブルシューティング

### `Secret が存在しません` と表示される
Turnstile を使う設定になっています。`npm run gcp:bootstrap -- <env>` を先に実行してください。既に実行済みなら、設定ファイルの `turnstileSecretName` と実際のシークレット名が一致しているか確認してください。
Turnstile を使わないなら `turnstileSecretName` を `""` にすれば、この確認自体がスキップされます。

### `5 NOT_FOUND: The database (default) does not exist`
Firestore をまだ作成していません。デプロイは成功しても、起動直後の最初のリクエストで必ず失敗します。
[docs/FIREBASE_SETUP.md](./FIREBASE_SETUP.md) §4 を実施してください。`npm run deploy:doctor` でも検出されます。

### `PERMISSION_DENIED` が Firestore 操作で出る
実行サービスアカウントに `roles/datastore.user` がありません。`npm run gcp:bootstrap -- <env>` を IAM 変更権限のあるアカウントで実行し直してください。

### 画像をアップロードできない

管理画面のメッセージに原因が添えてあります。それでも分からないときは、
実際に失敗した画像を通して 1 段ずつ確かめてください。

```bash
npm run media:doctor -- --file ./失敗した画像.jpg
```

判定 → 変換（sharp）→ 保存先への書き込み → 署名付き URL の発行、の順に試し、
**どこで落ちたか**と直し方を出します。よくある原因:

| 出るメッセージ | 直し方 |
|---|---|
| **MEDIA_BUCKET が未設定です** | いちばん多い原因。設定ファイルの `mediaBucket` は正しくても、**デプロイし直すまで動いているサービスには渡りません**。`npm run deploy` を実行してください |
| 設定と稼働中で食い違っています | 別の環境（staging / production）へデプロイした可能性があります。`--env` で見る設定を合わせるか、目的の環境へデプロイし直してください |
| バケットが見つかりません | Firebase コンソールで Storage を有効にする。または `mediaBucket` を実在するバケット名へ直す |
| 書き込む権限がありません | 実行サービスアカウントへ「Storage オブジェクト管理者」を付ける |
| 手元の資格情報では署名できません | **手元だけの制限**です（利用者アカウントには署名鍵がありません）。本番側は `npm run deploy:doctor` で実行サービスアカウントの権限を確認してください |
| 変換できません | JPEG・PNG・WebP へ保存し直す（iPhone の HEIC は「互換性優先」で撮る） |

`npm run deploy:doctor` も、バケットが実在するか・**動いているサービスの `MEDIA_BUCKET` が設定と一致しているか**を確認します。
デプロイ前にここが赤いときは、当日「画像だけアップロードできない」になります。

### 画像の表示だけが失敗する（他は正常）
署名付き URL の発行に失敗しています。実行サービスアカウント自身への
`roles/iam.serviceAccountTokenCreator` と `iamcredentials.googleapis.com` の有効化を確認してください。

### `The query requires an index`
複合インデックスが未反映か、構築中です。

```bash
npm run rules:deploy -- <env> --only firestore:indexes
```

### 管理画面が「権限がありません」になる
仕様どおりです。`profiles/{uid}` がまだありません。`npm run host:add -- <email>` で登録してください（[docs/HOST_ACCESS.md](./HOST_ACCESS.md)）。

### `Firebase: Error (auth/unauthorized-domain)`
**Firebase Authentication → Settings → 承認済みドメイン**に、アクセス中のドメインを追加してください。

### 未コミットの変更・ブランチについて
どちらもデプロイを**止めません**。注意として表示するだけです。

配信されるのは作業ツリーそのもの（`gcloud run deploy --source .`）なので、
未コミットの変更があること自体は誤りではありません。
`npm run sounds:install` で取り込んだ音源のように、
コミットできないが配信したいファイルもあります。

チームで運用していて取り違えを止めたい場合だけ、設定へ次を入れてください。

```json
{ "strictGitChecks": true }
```

`true` にすると、未コミットの変更があるとき、また `allowedBranches` 以外のブランチのときに停止します。
（旧 `requireCleanTree` は廃止しました。設定に残っていても停止はしません）

### Cloud Build でビルドが失敗する
```bash
gcloud builds list --project my-gcp-project --limit 5
gcloud builds log <BUILD_ID> --project my-gcp-project
```
`pnpm install --frozen-lockfile` の失敗が多いです。`pnpm-lock.yaml` をコミットしているか確認してください。

### `PERMISSION_DENIED: ... run.builder` など
`npm run gcp:bootstrap` を、IAM 変更権限のあるアカウントで実行し直してください。権限が無い場合、スクリプトが必要なコマンドを表示するので管理者へ依頼してください。

### 起動はするが 500 になる
```bash
gcloud run services logs tail smileq-live --region asia-northeast1 --project my-gcp-project
```
構造化ログ（JSON）に `errorCode` が出ます。`MISSING_ENV: FIREBASE_...` の場合は環境変数の設定漏れです。

### ヘルスチェックだけ通って画面が真っ白
`/api/health` は Firestore へ接続しません。データ層の問題は管理者用の `/api/diagnostics`（要ログイン）で確認してください。

### 二次元コードが古いドメインを指す
`APP_BASE_URL` を正しいドメインに設定して再デプロイし、**司会画面から参加 URL を再発行**してください。既に参加済みの参加者は再発行後も継続できます。

### gcloud のバージョン差でフラグが通らない
デプロイスクリプトは、未対応の任意フラグ（`--cpu-boost` / `--startup-probe`）を検出すると、警告を出してそれらを外して自動リトライします。恒久対応として `gcloud components update` を実行してください。

---

## 8. よく使うコマンド一覧

```bash
npm run deploy:doctor              # デプロイできる状態か診断（変更しない）
npm run deploy                     # デプロイ
npm run deploy -- staging          # ステージングへ
npm run deploy -- production --yes # 本番へ（確認省略。CI 用）
npm run deploy -- --dry-run        # 実行コマンドの確認だけ

npm run domain:map -- production   # カスタムドメイン設定
npm run domain:status -- production

npm run gcp:bootstrap -- production

npm run rules:deploy -- production      # Security Rules とインデックスを反映
npm run rules:deploy -- --dry-run       # 実行コマンドの確認だけ
npm run test:rules                      # Rules をエミュレータで検証（Java 必要）
npm run test:emulator                   # トランザクションの不変条件を実測（Java 必要）
npm run emulators                       # ローカルエミュレータを起動

npm run host:list                       # 司会者の棚卸し
npm run host:add -- you@example.com --name "あなたの名前"

npm run media:doctor               # 画像アップロードが通るか診断（変換・保存先・署名）
npm run media:doctor -- --file ./失敗した画像.jpg

npm run verify                     # lint + typecheck + test + build + 成果物検査
npm run verify:bundle              # ビルド成果物の安全性検査のみ
npm run test:e2e                   # E2E（docs/E2E.md 参照）
```

> `npm run verify` に `test:rules` / `test:emulator` は**含めていません**。
> エミュレータと Java が必須で、環境によっては実行できないためです。
> Rules を変更したときは必ず手動で実行してください。
