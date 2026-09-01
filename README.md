# SmileQ Live

会場イベント向けリアルタイムクイズシステム。

参加者は**二次元コードを読むだけ**で参加できます。ルームコードの手入力はありません。
効果音は会場の投影用パソコンからだけ鳴り、参加者のスマートフォンからは一切音が出ません。

| | |
|---|---|
| 実行環境 | Google Cloud Run（Node.js 24 / Next.js 16 standalone） |
| データ | Cloud Firestore / Firebase Auth / Cloud Storage |
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
  - 判定はサーバー上の `decimal.js` のみ。数値は**文字列で保存**し、浮動小数点で正誤を決めない
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
# .env.local に Firebase の公開設定（projectId / apiKey / authDomain など）を設定

# サーバー側の認証は ADC を使う（秘密鍵ファイルは作らない）
gcloud auth application-default login

pnpm dev
# http://localhost:3000
```

Firebase の準備は [docs/FIREBASE_SETUP.md](docs/FIREBASE_SETUP.md) を参照してください。

エミュレータだけでも動かせます（Java が必要）。

```bash
pnpm emulators     # Firestore / Auth / Storage / UI(http://127.0.0.1:4000)
```

効果音は**同梱済み**です（`public/sounds/default/*.wav`）。自家生成音なので権利の確認は不要で、
デプロイした時点でそのまま鳴ります。

```bash
npm run sounds:generate                         # 同梱音を作り直す
npm run sounds:install                          # 効果音ラボの音源へ差し替える（手順を表示）
npm run sounds:check                            # 音源が揃っているか確かめる
npm run sounds:check -- --url https://<公開URL> # 公開中のサイトを確かめる
```

効果音ラボは**素材の再配布が禁止**されているため、その音源だけはリポジトリに含めていません。
差し替える場合のみ `npm run sounds:install` を実行してください
（出典は `public/sounds/LICENSE.md` へ自動記録されます）。

**差し替えた音源は Git に入りません。** そのため取り込んだ端末から `npm run deploy` する必要があります。
公開先に音源が載っているかは `npm run sounds:check -- --url https://<公開URL>` で確かめられます。
投影画面の「投影準備」でも、読み込めた件数と足りない音が表示されます。

---

## デプロイ

```bash
npm run deploy:doctor    # デプロイできる状態か診断
npm run deploy           # Cloud Run へデプロイ
```

初回は次の順で進めます。

```bash
cp deploy/cloud-run.production.example.json deploy/cloud-run.production.json
# 編集（プロジェクト ID、ドメイン、Firebase の公開設定）

npm run firebase:login                    # ログイン（期限切れ時もこれで取り直します）
npm run firebase:config                   # Firebase の公開設定をCLIで取得し設定ファイルへ書き込む
npm run gcp:bootstrap -- production       # API 有効化・SA 作成・Firebase 権限付与
npm run firebase:auth -- production       # Authentication の初期化（Google 有効化のみ GUI）
npm run rules:deploy -- production        # Security Rules とインデックスを反映
npm run deploy -- production
npm run host:add -- you@example.com --name "あなたの名前"   # 最初の司会者
npm run domain:map -- production          # カスタムドメイン
npm run seed:demo                         # 動作確認用のデモクイズ（任意）
```

> **Secret Manager の手順はありません。** Cloud Run 上の Admin SDK は実行サービスアカウントの
> ADC で認証するため、サーバー用の秘密情報が存在しません（[docs/FIRESTORE_MODEL.md](docs/FIRESTORE_MODEL.md) §6）。
> Turnstile を使う場合だけ Secret Manager が必要になります。

詳細:

- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — デプロイ手順・オプション・トラブルシューティング
- **[docs/CUSTOM_DOMAIN.md](docs/CUSTOM_DOMAIN.md)** — カスタムドメイン（ドメインマッピング / ロードバランサ）
- **[docs/FIREBASE_SETUP.md](docs/FIREBASE_SETUP.md)** — Firebase プロジェクトの設定・バックアップ
- **[docs/FIRESTORE_MODEL.md](docs/FIRESTORE_MODEL.md)** — データモデルと設計判断（**最上位の基準**）
- **[docs/HOST_ACCESS.md](docs/HOST_ACCESS.md)** — 司会者アクセスの管理
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — 会場運用・監視・費用調整
- **[docs/DRAW_MODES.md](docs/DRAW_MODES.md)** — 抽選会・ビンゴ・ルーレットの進め方
- **[docs/POLL_MODE.md](docs/POLL_MODE.md)** — 投票モードの進め方
- **[docs/ROULETTE.md](docs/ROULETTE.md)** — URL だけで回すルーレット（ログイン不要・`/roulette`）
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
| `pnpm verify` | lint → typecheck → test → build → 成果物検査 |
| `npm run verify:bundle` | ビルド成果物に秘密鍵・音声処理・コード入力が無いことを検査 |
| `npm run deploy` | Cloud Run へデプロイ |
| `npm run deploy -- staging` | ステージングへデプロイ |
| `npm run deploy -- --dry-run` | 実行される gcloud コマンドの確認 |
| `npm run deploy:doctor` | デプロイ前診断（変更しない） |
| `npm run rules:deploy` | Security Rules とインデックスを反映 |
| `npm run test:rules` | Rules をエミュレータへ適用して検証（Java 必要） |
| `npm run test:emulator` | トランザクションの不変条件を実測（Java 必要） |
| `npm run emulators` + `pnpm test` | 参加者の再参加テストはエミュレータ接続時のみ実行（未接続ならスキップ） |
| `npm run emulators` | ローカルエミュレータを起動 |
| `npm run host:list` / `host:add` / `host:remove` | 司会者の確認・登録・削除 |
| `npm run domain:map` / `domain:status` | カスタムドメイン設定・確認 |
| `npm run firebase:config` | Firebase の公開設定を CLI で取得し設定ファイルへ書き込む（GUI 不要） |
| `npm run firebase:auth` | Authentication の初期化・匿名認証の有効化・承認済みドメインの追加 |
| `npm run seed:demo` | 動作確認用のデモクイズを作成（画像つき 6 問） |
| `npm run sounds:generate` | 同梱の効果音（自家生成）を作り直す |
| `npm run sounds:install` | 効果音の入手手順を表示 / ダウンロード済みの音源を取り込む |
| `npm run sounds:check` | 効果音が揃っているか確かめる（`--url` で公開先も検査） |
| `npm run firebase:doctor` | Firebase が使える状態か診断（変更しない） |
| `npm run gcp:bootstrap` | Google Cloud 初期設定（冪等） |

> `npm` / `pnpm` どちらからでも実行できます。デプロイスクリプトは呼び出し元のパッケージマネージャを自動判定します。
>
> `verify` に `test:rules` / `test:emulator` は**含めていません**（エミュレータと Java が必須のため）。
> Rules を変更したときは必ず手動で実行してください。

---

## 設計の要点

1. **参加は二次元コードからの直接 URL に統一**し、コード入力をなくす。
2. **2〜5 択と数値入力を判別可能な問題型**として実装する。
3. **数値判定はサーバー上の Decimal のみ**で行い、Firestore へは**文字列で保存**する。
4. **Firestore を正とし、参加者へは公開状態ドキュメントだけを購読させる**。
5. **正解を正解発表前の参加者へ送らない**（API・HTML・props・購読データすべて）。
6. **効果音を投影画面の専用モジュールへ隔離**する。
7. **Cloud Run 上の Node.js コンテナをステートレス**にする。
8. **Windows / macOS / Linux から同じ Node.js デプロイスクリプト**を使う。

---

## セキュリティ

- **クライアントからの Firestore 書き込みは一切なし**（書き込みは Admin SDK 経由のみ）
- Security Rules で `rooms/{id}` と `quizzes/**` を参加者から到達不能にする（正解の最終防壁）
- **サーバー用の秘密情報を持たない**（Cloud Run 実行サービスアカウントの ADC で認証。秘密鍵ファイルを作らない）
- 参加トークンは SHA-256 ハッシュのみ保存（平文は再発行時に 1 回だけ返す）
- `/j/*` は `no-store` / `no-referrer` / `noindex`。ログではパスを `/j/[redacted]` へマスク
- 画像は magic bytes 判定後に sharp で再エンコード（SVG は受け付けない）。Storage は直接読み取り不可
- 決定的ドキュメント ID + `create()` で二重回答を防止
- 管理画面を使えるのは `profiles/{uid}` がある利用者だけ（自己登録は不可 — [docs/HOST_ACCESS.md](docs/HOST_ACCESS.md)）
- クイズの共有は閲覧とルーム作成まで。編集・公開・削除・共有設定は所有者だけ
- コンテナは非 root で実行

---

## ライセンス

[LICENSE](LICENSE) を参照してください。
`public/sounds/` に配置する効果音は各自で用意し、`public/sounds/LICENSE.md` に出典とライセンスを記録してください。
