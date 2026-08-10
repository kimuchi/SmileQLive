# カスタムドメイン設定手順 — SmileQ Live

会場の二次元コードは `https://<正式ドメイン>/j/<参加トークン>` を指します。
Cloud Run の既定 URL（`https://smileq-live-xxxxx-an.a.run.app`）でも動作しますが、長く覚えにくいため、本番では正式ドメインの利用を推奨します。

---

## 0. 方式の選択

SmileQ Live は 2 つの方式に対応しています。設定ファイルの `domainMode` で選びます。

| | `domain-mapping`（既定） | `load-balancer` |
|---|---|---|
| 仕組み | Cloud Run ドメインマッピング | グローバル外部アプリケーション ロードバランサ + サーバーレス NEG |
| 追加費用 | なし | 転送ルール等の固定費（月額）+ 転送量 |
| 対応リージョン | **限られる**（`asia-northeast1` は対応） | すべて |
| DNS | `A` / `AAAA` / `CNAME`（払い出される値） | `A` レコード 1 本（固定 IP） |
| 証明書 | 自動 | Google マネージド証明書（自動） |
| 事前準備 | **ドメイン所有権の確認が必要** | 不要 |
| Cloud CDN / Cloud Armor | 使えない | 使える |
| 向いている場面 | 単一リージョン・小〜中規模イベント | 本番運用・WAF/CDN を併用したい場合 |

**迷ったら `domain-mapping`** から始めてください。あとから `load-balancer` へ移行できます。

---

## 1. 共通の前準備

### 1.1 設定ファイルを編集

`deploy/cloud-run.production.json`:

```jsonc
{
  "customDomain": "quiz.example.jp",
  "domainMode": "domain-mapping",
  "appBaseUrl": "https://quiz.example.jp"
}
```

- `customDomain` を設定して `appBaseUrl` を空にすると、`https://<customDomain>` が自動的に補完されます。
- 両方書く場合は必ず一致させてください。ずれているとデプロイ時に警告が出ます（**二次元コードは `appBaseUrl` を使って生成されます**）。

### 1.2 サブドメインを推奨

`quiz.example.jp` のようなサブドメインを使ってください。
apex ドメイン（`example.jp`）は CNAME が使えず設定が複雑になります。

---

## 2. 方式 A: Cloud Run ドメインマッピング

### 2.1 ドメイン所有権を確認する

Google に対してドメインの所有権を確認しておく必要があります（1 回だけ）。

```bash
gcloud domains verify example.jp
```

ブラウザで Google Search Console が開くので、指示された TXT レコードを DNS へ登録し、確認を完了させます。

確認済みドメインの一覧:

```bash
gcloud domains list-user-verified
```

> Cloud Domains や Google Workspace で管理しているドメインは、すでに確認済みの場合があります。

### 2.2 マッピングを作成する

```bash
npm run domain:map -- production
```

スクリプトが行うこと:

1. 既存のマッピングがあるか確認（あれば状態を表示して終了）
2. ドメイン所有権の確認状況をチェック
3. `gcloud beta run domain-mappings create` を実行
4. **登録すべき DNS レコードを表形式で表示**

表示例:

```text
=============================
  DNS レコードを登録してください
=============================

  種別   名前                          値
  ----   --------------------------    -------------------------------
  A      quiz.example.jp               216.239.32.21
  A      quiz.example.jp               216.239.34.21
  A      quiz.example.jp               216.239.36.21
  A      quiz.example.jp               216.239.38.21
  AAAA   quiz.example.jp               2001:4860:4802:32::15
  ...
```

### 2.3 DNS へ登録する

表示されたレコードを、ドメインを管理している DNS サービス（お名前.com / Cloudflare / Route 53 / Cloud DNS など）へそのまま登録します。

> **Cloudflare を使う場合**
> プロキシ（オレンジの雲）を **OFF（DNS only）** にしてください。プロキシ有効のままだと Google 側の証明書発行が完了しません。

### 2.4 反映を待つ

```bash
npm run domain:status -- production
```

`CertificateProvisioned` / `Ready` が `True` になれば完了です。DNS 伝播と証明書発行で **最大 60 分程度**かかります。

```bash
curl -sS https://quiz.example.jp/api/health
# {"status":"ok","service":"smileq-live","timestamp":"..."}
```

### 2.5 リージョンが非対応と言われたら

```text
✖ リージョン asia-northeast1 ではドメインマッピングを利用できません。
```

この場合は「[方式 B](#3-方式-b-ロードバランサ)」へ切り替えてください。設定の `domainMode` を `load-balancer` にして再実行するだけです。

---

## 3. 方式 B: ロードバランサ

### 3.1 設定を切り替える

```jsonc
{
  "customDomain": "quiz.example.jp",
  "domainMode": "load-balancer",
  "appBaseUrl": "https://quiz.example.jp"
}
```

### 3.2 構築する

```bash
npm run domain:map -- production
```

スクリプトが**冪等に**次を作成します（既存があればスキップ）。

| # | リソース | 名前の例 |
|---|---|---|
| 1 | サーバーレス NEG | `smileq-live-neg-asia-northeast1` |
| 2 | バックエンドサービス | `smileq-live-backend` |
| 3 | URL マップ | `smileq-live-urlmap` |
| 4 | Google マネージド SSL 証明書 | `smileq-live-cert` |
| 5 | ターゲット HTTPS プロキシ | `smileq-live-https-proxy` |
| 6 | グローバル固定 IPv4 アドレス | `smileq-live-ip` |
| 7 | 転送ルール (443) | `smileq-live-https-rule` |
| 8 | HTTP→HTTPS リダイレクト用 URL マップ + プロキシ + 転送ルール (80) | `smileq-live-redirect` など |

完了すると **A レコードに設定すべき IP アドレス**が表示されます。

```text
  種別   名前                          値
  ----   --------------------------    -------------------------------
  A      quiz.example.jp               34.120.xxx.xxx
```

### 3.3 DNS へ A レコードを登録

上記 IP を `quiz.example.jp` の A レコードとして登録します。

### 3.4 証明書の発行を待つ

```bash
npm run domain:status -- production
```

`マネージド証明書 : ACTIVE` になれば完了です（DNS 登録後 15〜60 分程度）。
`PROVISIONING` の間は HTTPS でアクセスできません。

### 3.5 （任意）Cloud Run への直接アクセスを制限する

ロードバランサ経由のみに絞る場合:

```jsonc
{ "ingress": "internal-and-cloud-load-balancing" }
```

にして再デプロイします。

> **注意**: この設定にすると Cloud Run の既定 URL では動かなくなります。ロードバランサと証明書が正常に動作していることを確認してから切り替えてください。

---

## 4. ドメイン設定後に必ず行うこと

### 4.1 `APP_BASE_URL` を反映して再デプロイ

```bash
npm run deploy -- production
```

参加用二次元コードは `APP_BASE_URL` を基準に生成されます。ここが古いままだと QR が旧 URL を指します。

### 4.2 Supabase Auth の許可 URL を更新

Supabase ダッシュボード → **Authentication → URL Configuration**

| 項目 | 設定値 |
|---|---|
| Site URL | `https://quiz.example.jp` |
| Redirect URLs | `https://quiz.example.jp/**` |

ステージングの URL も併記しておくと開発が楽になります。

### 4.3 既存ルームの二次元コードを再発行

**ドメイン変更後に作られていない古いルームの QR は旧ドメインを指しています。**

司会画面（`/host/[roomId]`）の「参加URLを再発行」を実行してください。

- 新しい参加トークンが発行され、古い URL は即時無効になります
- 投影画面の二次元コードは自動更新されます
- **既に参加済みの参加者は退出しません**（そのまま継続できます）

### 4.4 動作確認

| 確認項目 | 方法 |
|---|---|
| HTTPS でアクセスできる | `curl -sS https://quiz.example.jp/api/health` |
| HTTP が HTTPS へリダイレクトされる | `curl -sSI http://quiz.example.jp/` → `301` |
| 管理画面へログインできる | `https://quiz.example.jp/admin/login` |
| 二次元コードが正式ドメインを指す | 司会画面で参加 URL を確認 |
| スマートフォンから参加できる | 実機で QR を読み取る |

---

## 5. 複数環境でドメインを分ける

| 環境 | ドメイン例 | 設定 |
|---|---|---|
| 本番 | `quiz.example.jp` | `deploy/cloud-run.production.json` |
| ステージング | `quiz-stg.example.jp`（または Cloud Run 既定 URL） | `deploy/cloud-run.staging.json` |

ステージングは `customDomain` を `""`、`appBaseUrl` を `""` にしておくと、デプロイ後に Cloud Run の URL が自動で `APP_BASE_URL` に設定されます。

---

## 6. トラブルシューティング

### `gcloud domains verify` が終わらない
Search Console での TXT レコード確認が必要です。DNS 反映に時間がかかることがあります。`nslookup -type=TXT example.jp` で確認できます。

### 証明書がいつまでも `PROVISIONING`
- DNS が正しく IP / 払い出し値を指しているか確認（`dig quiz.example.jp` / `nslookup quiz.example.jp`）
- Cloudflare のプロキシが ON になっていないか確認
- CAA レコードで `pki.goog` が拒否されていないか確認

### `SSL_ERROR` / `ERR_CERT_COMMON_NAME_INVALID`
証明書発行前にアクセスしています。`npm run domain:status` で `ACTIVE` になるまで待ってください。

### ドメインは開くが参加できない
`APP_BASE_URL` が古いままの可能性があります。再デプロイして、司会画面から参加 URL を再発行してください。

### ドメインを別サービスへ付け替えたい
```bash
# ドメインマッピングの場合
gcloud beta run domain-mappings delete --domain quiz.example.jp --region asia-northeast1 --project <PROJECT>
```
ロードバランサの場合は、転送ルール → プロキシ → URL マップ → バックエンド → NEG の順に削除します（固定 IP は残しておくと再利用できます）。

---

## 7. 費用の目安

| 方式 | 固定費 | 備考 |
|---|---|---|
| `domain-mapping` | なし | Cloud Run の実行費用のみ |
| `load-balancer` | 転送ルール + 固定 IP の月額 | 転送量課金あり。CDN / WAF を使う場合はその費用も |

イベントが無い期間は `minInstances` を 0 に戻すと Cloud Run の待機費用を抑えられます（[docs/OPERATIONS.md](./OPERATIONS.md)）。
ロードバランサの固定費は `minInstances` に関係なく発生します。
