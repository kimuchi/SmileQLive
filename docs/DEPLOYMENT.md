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
開発PC                          Google Cloud                     Supabase
  │                                  │                              │
  │  npm run deploy                  │                              │
  ├─ ① 事前チェック                  │                              │
  │   （gcloud/Git/Secret/lint等）   │                              │
  ├─ ② gcloud run deploy --source . │                              │
  │      └─ ソースを Cloud Build へ  │                              │
  │            └─ Dockerfile で      │                              │
  │               Linux イメージ作成 │                              │
  │                  └─ Artifact Registry へ push                   │
  │                     └─ Cloud Run へリビジョン作成               │
  ├─ ③ APP_BASE_URL の確定           │                              │
  ├─ ④ カスタムドメイン状態の確認    │                              │
  └─ ⑤ /api/health で疎通確認 ───────┴──── ブラウザ ──────────────► DB / Auth / Realtime / Storage
```

- **ローカルに Docker は不要**です。イメージは Cloud Build 上で作られるため、開発 PC の CPU アーキテクチャに依存しません。
- 同じコンテナイメージをステージング／本番で使い回せるよう、`NEXT_PUBLIC_*` によるビルド時埋め込みを使っていません。Supabase の URL と Publishable Key は**実行時環境変数**から読み込みます。

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

### 2.3 Supabase の準備

先に **[docs/SUPABASE_SETUP.md](./SUPABASE_SETUP.md)** を実施してください。
デプロイには次の 3 つが必要です。

| 値 | 用途 | 置き場所 |
|---|---|---|
| Project URL (`https://xxx.supabase.co`) | 公開設定 | `deploy/cloud-run.*.json` |
| Publishable Key (`sb_publishable_...`) | 公開設定（ブラウザへ渡る） | `deploy/cloud-run.*.json` |
| Secret Key (`sb_secret_...`) | **サーバー専用** | **Secret Manager のみ**。ファイルへ書かない |

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

  "supabaseUrl": "https://xxxx.supabase.co",
  "supabasePublishableKey": "sb_publishable_....",
  "supabaseSecretName": "smileq-live-supabase-secret-key-production", // ← 名前だけ

  "mediaBucket": "quiz-media",
  "minInstances": 1,                             // ← 本番は 1 以上を推奨
  "maxInstances": 10,
  "concurrency": 80
}
```

> **重要**
> - `deploy/cloud-run.*.json`（実値ファイル）は `.gitignore` 済みで、`.gcloudignore` / `.dockerignore` にも入っているため、Git にも Cloud Build のソースにも最終コンテナにも含まれません。
> - `supabaseSecretName` には **Secret Manager 上の「名前」だけ**を書きます。Secret の値を書くとスクリプトが検出して停止します。

### 2.5 Google Cloud の初期設定

```bash
npm run gcp:bootstrap -- production
```

このスクリプトが行うこと（**冪等**。既存リソースは壊しません）:

1. 必要な API の有効化
   `run` / `cloudbuild` / `artifactregistry` / `secretmanager` / `iam` / `logging` / `monitoring`
2. Cloud Run 実行用サービスアカウントの作成（デフォルトの広い権限は使いません）
3. Secret Manager のシークレット（空の箱）の作成
4. 実行用サービスアカウントへ `roles/secretmanager.secretAccessor` を付与
5. Cloud Build 用サービスアカウントへ、ビルドとデプロイに必要なロールを付与
6. 実行者へ `roles/iam.serviceAccountUser` を付与

権限が足りずに失敗した場合は、**必要なロールと実行すべきコマンドを表示して終了**します。管理者へその内容をそのまま依頼してください。

### 2.6 Secret の値を登録する

スクリプトは「箱」だけを作ります。値は安全な経路で登録してください。

```bash
gcloud secrets versions add smileq-live-supabase-secret-key-production \
  --project my-gcp-project \
  --data-file=-
```

実行後に Supabase の Secret Key を貼り付け、
- macOS / Linux: `Ctrl+D`
- Windows: `Ctrl+Z` → `Enter`

で確定します。

> Secret の値をソース・JSON・`.env.example`・CI ログへ書かないでください。

Google Cloud Console から登録する場合は
**Security → Secret Manager → 対象シークレット → 新しいバージョン** です。

### 2.7 データベースのマイグレーション

```bash
npm run db:migrate -- --project-ref <supabase-project-ref>
```

詳細は [docs/SUPABASE_SETUP.md](./SUPABASE_SETUP.md) を参照してください。

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
4. 両方あるなら **production**（本番は必ず確認プロンプトが出ます）

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
| 3 | Secret の存在と値の有無を確認 | 登録コマンドを表示して停止 |
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

- 未認証アクセスを許可するのは、参加者がログインなしで参加ページを開くためです。**認可はアプリケーション内部（Supabase Auth + 役割チェック）で行います。**
- `minInstances` は費用に直結します。イベントが無い期間は 0 へ戻せます（[docs/OPERATIONS.md](./OPERATIONS.md) 参照）。

環境変数として渡されるもの:

```text
NODE_ENV=production
APP_ENV=production|staging
HOSTNAME=0.0.0.0
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
APP_BASE_URL=https://quiz.example.jp
QUIZ_MEDIA_BUCKET=quiz-media
PRESENTATION_LINK_TTL_MINUTES=480
LOG_LEVEL=info
```

シークレットとしてマウントされるもの:

```text
SUPABASE_SECRET_KEY = <supabaseSecretName>:latest
```

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
2. Supabase Auth の許可 URL / Redirect URL へ正式ドメインを追加
3. **既存ルームの参加用二次元コードを再発行**（古い QR は旧ドメインを指しています）

---

## 5. CI からデプロイする

ローカルと CI で**同じスクリプト**を使います。デプロイロジックを二重に持ちません。

`.github/workflows/deploy.yml` を用意済みです。必要な設定:

| GitHub 側の設定 | 値 |
|---|---|
| Variables: `GCP_PROJECT_ID` | プロジェクト ID |
| Variables: `GCP_REGION` | `asia-northeast1` |
| Variables: `GCP_SERVICE_ACCOUNT` | 実行用サービスアカウント |
| Variables: `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity 連携のプロバイダ |
| Variables: `SUPABASE_URL` | Supabase の URL |
| Variables: `SUPABASE_PUBLISHABLE_KEY` | Publishable Key |
| Variables: `APP_BASE_URL` / `CUSTOM_DOMAIN` | 正式ドメイン |

ワークフローは設定 JSON を実行時に生成し、`node scripts/deploy-cloud-run.mjs production --yes` を呼びます。
サービスアカウントキー（JSON 鍵）は使わず、Workload Identity 連携を推奨します。

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

DB マイグレーションを伴うリリースでは、**後方互換のある DB 変更 → アプリデプロイ → 動作確認 → 次回リリースで旧列削除**の順を守ってください。アプリだけ戻せば復旧できる状態を保ちます。

---

## 7. トラブルシューティング

### `Secret が存在しません` と表示される
`npm run gcp:bootstrap -- <env>` を先に実行してください。既に実行済みなら、設定ファイルの `supabaseSecretName` と実際のシークレット名が一致しているか確認してください。

### `Secret に値が登録されていません`
「[2.6 Secret の値を登録する](#26-secret-の値を登録する)」を実施してください。箱だけでは起動できません。

### `本番デプロイが許可されていないブランチです`
`main` 以外から本番へ出そうとしています。意図的な場合は設定の `allowedBranches` に追加してください。

### `作業ツリーに未コミットの変更があります`
本番デプロイでは、実際に動くコードとリポジトリの内容を一致させるためコミットを必須にしています。緊急時は設定の `requireCleanTree` を `false` にできますが、常用しないでください。

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
構造化ログ（JSON）に `errorCode` が出ます。`MISSING_ENV: SUPABASE_...` の場合は環境変数／シークレットの設定漏れです。

### ヘルスチェックだけ通って画面が真っ白
`/api/health` は DB へ接続しません。DB 側の問題は管理者用の `/api/diagnostics`（要ログイン）で確認してください。

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
npm run db:migrate -- --status
npm run db:test                    # DB 関数のスモークテスト（ローカル PostgreSQL）

npm run verify                     # lint + typecheck + test + build + 成果物検査
npm run verify:bundle              # ビルド成果物の安全性検査のみ
npm run test:e2e                   # E2E（docs/E2E.md 参照）
```
