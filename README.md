# SmileQ Live

会場イベント向けリアルタイムクイズシステム。

参加者は**二次元コードを読むだけ**で参加できます。ルームコードの手入力はありません。
効果音は会場の投影用パソコンからだけ鳴り、参加者のスマートフォンからは一切音が出ません。

| | |
|---|---|
| 実行環境 | Google Cloud Run（Node.js 24 / Next.js 16 standalone） |
| データ | Supabase PostgreSQL / Auth / Realtime / Storage |
| デプロイ | `npm run deploy`（Windows / macOS / Linux 共通） |

---

## 3 つの画面

| 画面 | URL | 役割 |
|---|---|---|
| 司会・管理 | `/admin/quizzes`, `/host/[roomId]` | クイズ作成、ルーム作成、進行操作 |
| 会場投影 | `/present/[roomId]` | 二次元コード、問題、集計、効果音 |
| 参加者 | `/j/[joinToken]` → `/play/[roomId]` | ニックネーム登録、回答、結果確認 |

---

## 主な機能

- **2〜5 択の選択式問題**（各選択肢に画像を 1 枚まで／文章のみ・画像のみ・両方）
- **数値入力問題**（完全一致 / 許容誤差 / 範囲指定）
  - 全角数字・桁区切り・小数・負数を正規化
  - 指数表記や単位付き入力は拒否
  - 判定は `decimal.js` と PostgreSQL `numeric` で行い、浮動小数点で正誤を決めない
- 問題画像・選択肢画像・正解解説画像（WebP へ自動変換、EXIF 除去）
- 二次元コードによる直接参加（推測困難なトークン、失効・再発行に対応）
- リアルタイム出題・回答受付・締切・正解発表
- 選択式の人数／割合集計、数値式の正解率・代表回答値集計
- 固定点方式の得点とランキング
- 投影画面だけで鳴る効果音
- 再接続と状態復元（ページ更新・通信断・画面復帰）

初期版に含まれないもの: 複数正解、自由記述、並び替え、早押し、チーム戦、動画問題、参加者端末の音・振動、参加コードの手入力。

---

## クイックスタート（ローカル開発）

```bash
corepack enable
pnpm install --frozen-lockfile

cp .env.example .env.local
# .env.local に Supabase の URL / Publishable Key / Secret Key を設定

pnpm dev
# http://localhost:3000
```

Supabase の準備は [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) を参照してください。

効果音のプレースホルダを生成する場合（自家生成 WAV。ライセンス問題なし）:

```bash
node scripts/generate-placeholder-sounds.mjs
```

本番用の効果音は各自で用意し、`public/sounds/LICENSE.md` に出典を記録してください。

---

## デプロイ

```bash
npm run deploy:doctor    # デプロイできる状態か診断
npm run deploy           # Cloud Run へデプロイ
```

初回は次の順で進めます。

```bash
cp deploy/cloud-run.production.example.json deploy/cloud-run.production.json
# 編集（プロジェクト ID、ドメイン、Supabase の URL / Publishable Key など）

npm run gcp:bootstrap -- production      # API 有効化・SA 作成・Secret の箱作成
gcloud secrets versions add smileq-live-supabase-secret-key-production \
  --project <PROJECT> --data-file=-      # Secret の値を登録
npm run db:migrate -- --project-ref <REF>  # DB マイグレーション
npm run deploy -- production
npm run domain:map -- production          # カスタムドメイン
```

詳細:

- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — デプロイ手順・オプション・トラブルシューティング
- **[docs/CUSTOM_DOMAIN.md](docs/CUSTOM_DOMAIN.md)** — カスタムドメイン（ドメインマッピング / ロードバランサ）
- **[docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)** — Supabase の設定
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — 会場運用・監視・費用調整
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 設計方針とディレクトリ構成
- **[docs/E2E.md](docs/E2E.md)** — E2E テストの実行方法

---

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバー |
| `pnpm build` | 本番ビルド（standalone 出力） |
| `pnpm start` | ローカルで本番ビルドを起動 |
| `pnpm lint` / `pnpm typecheck` | 静的検査 |
| `pnpm test` / `pnpm test:coverage` | 単体・統合テスト |
| `pnpm test:e2e` | E2E テスト |
| `pnpm verify` | lint → typecheck → test → build |
| `npm run deploy` | Cloud Run へデプロイ |
| `npm run deploy -- staging` | ステージングへデプロイ |
| `npm run deploy -- --dry-run` | 実行される gcloud コマンドの確認 |
| `npm run deploy:doctor` | デプロイ前診断（変更しない） |
| `npm run domain:map` / `domain:status` | カスタムドメイン設定・確認 |
| `npm run gcp:bootstrap` | Google Cloud 初期設定（冪等） |
| `npm run db:migrate` | Supabase マイグレーション |
| `npm run db:test` | DB 関数のスモークテスト（ローカル PostgreSQL） |

> `npm` / `pnpm` どちらからでも実行できます。デプロイスクリプトは呼び出し元のパッケージマネージャを自動判定します。

---

## 設計の要点

1. **参加は二次元コードからの直接 URL に統一**し、コード入力をなくす。
2. **2〜5 択と数値入力を判別可能な問題型**として実装する。
3. **数値判定は Decimal と PostgreSQL `numeric`** で行う。
4. **DB を正とし、Realtime は通知に限定**する。
5. **正解を正解発表前の参加者へ送らない**（API・HTML・props・Realtime すべて）。
6. **効果音を投影画面の専用モジュールへ隔離**する。
7. **Cloud Run 上の Node.js コンテナをステートレス**にする。
8. **Windows / macOS / Linux から同じ Node.js デプロイスクリプト**を使う。

---

## セキュリティ

- 公開スキーマの全テーブルで RLS を有効化
- Supabase Secret Key は Secret Manager のみに保存し、`server-only` モジュールからだけ参照
- 参加トークンは DB へ SHA-256 ハッシュのみ保存（平文は再発行時に 1 回だけ返す）
- `/j/*` は `no-store` / `no-referrer` / `noindex`。ログではパスを `/j/[redacted]` へマスク
- 画像は magic bytes 判定後に sharp で再エンコード（SVG は受け付けない）
- 同一参加者・同一問題の UNIQUE 制約で二重回答を防止
- コンテナは非 root で実行

---

## ライセンス

[LICENSE](LICENSE) を参照してください。
`public/sounds/` に配置する効果音は各自で用意し、`public/sounds/LICENSE.md` に出典とライセンスを記録してください。
