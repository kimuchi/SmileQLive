# Supabase セットアップ手順 — SmileQ Live

SmileQ Live は永続状態のすべてを Supabase PostgreSQL に置きます。
Realtime は通知手段であり、状態の保存先ではありません。

---

## 1. プロジェクト作成

1. https://supabase.com でプロジェクトを作成
2. リージョンは会場に近いもの（日本国内なら **Northeast Asia (Tokyo)**）
3. データベースパスワードは安全に保管（マイグレーション適用に使います）

環境は分けることを推奨します。

| 環境 | Supabase プロジェクト |
|---|---|
| 本番 | `smileq-live-production` |
| ステージング | `smileq-live-staging` |

---

## 2. キーの確認

**Project Settings → API Keys**

| キー | 用途 | 扱い |
|---|---|---|
| Project URL | `SUPABASE_URL` | 公開してよい |
| Publishable key (`sb_publishable_...`) | `SUPABASE_PUBLISHABLE_KEY` | ブラウザへ渡る。**RLS が必須** |
| Secret key (`sb_secret_...`) | `SUPABASE_SECRET_KEY` | **サーバー専用。Secret Manager にのみ置く** |

> Secret key はリポジトリ・`deploy/*.json`・`.env.example`・CI ログのどこにも書かないでください。

---

## 3. 認証の設定

**Authentication → Providers / Sign In-Up**

| 設定 | 値 | 理由 |
|---|---|---|
| Email provider | 有効 | 司会者ログインに使う |
| **Allow new users to sign up** | **無効** | 一般公開の自己登録を許可しない（§18.1） |
| **Anonymous sign-ins** | **有効** | 参加者の匿名認証に使う（§18.2） |
| Confirm email | 運用に応じて | 招待運用なら有効のままでよい |

**Authentication → URL Configuration**

| 項目 | 値 |
|---|---|
| Site URL | `https://quiz.example.jp`（正式ドメイン） |
| Redirect URLs | `https://quiz.example.jp/**`, `https://<cloud-run-url>/**`, `http://localhost:3000/**` |

> ドメインを変更したら必ずここも更新してください。

### 匿名認証のレート制限

**Authentication → Rate Limits** で匿名サインインの上限を確認してください。
200 人規模のイベントでは、既定値だと会場での同時参加が制限に当たることがあります。

---

## 4. Storage バケット

**Storage → New bucket**

| 項目 | 値 |
|---|---|
| 名前 | `quiz-media` |
| Public | 用途に応じて（下記参照） |
| ファイルサイズ上限 | 10 MB |
| 許可 MIME | `image/webp` |

### Public にするか Private にするか

| | Public バケット | Private バケット |
|---|---|---|
| 配信 | 公開 URL（高速・キャッシュ可） | 署名付き URL（有効期限あり） |
| 正解画像の秘匿 | **URL を知られれば見える** | URL 自体に期限がある |
| 実装上の扱い | どちらでも、正解・解説画像の URL は **正解発表まで API から返さない** | 同左 |

いずれの場合も、アプリケーションは**正解発表前に正解・解説画像 URL を参加者へ返しません**。
より厳格に運用したい場合は Private バケット + 署名付き URL を選んでください。

書き込み・削除は Cloud Run のサーバー処理（Secret Key）だけが行います。クライアントから直接アップロードさせません。

---

## 5. マイグレーション適用

### 5.1 ローカルで確認する場合

```bash
# Supabase CLI（未インストールなら pnpm dlx でも可）
supabase start
npm run db:migrate -- --local
```

`supabase start` には Docker が必要です。ローカル DB を使わない場合はこの手順を飛ばせます。

### 5.2 リモートへ適用する

```bash
supabase login
npm run db:migrate -- --project-ref <your-project-ref>
```

`<your-project-ref>` は `https://<ref>.supabase.co` の `<ref>` 部分です。

適用状況の確認:

```bash
npm run db:migrate -- --status
```

### 5.3 マイグレーションの中身

| ファイル | 内容 |
|---|---|
| `20260810000100_initial_schema.sql` | 列挙型・テーブル・索引・トリガー・制約 |
| `20260810000200_rls.sql` | 全テーブルの RLS ポリシー |
| `20260810000300_functions.sql` | 状態遷移・回答登録・集計などの PostgreSQL 関数 |
| `20260810000400_realtime.sql` | private Realtime channel の認可 |

### 5.4 DB 関数の検証

Supabase を起動しなくても、素の PostgreSQL 上で状態遷移・回答登録・数値判定・集計を検証できます。

```bash
createdb smileq_sqltest
npm run db:test
```

詳細は [supabase/tests/README.md](../supabase/tests/README.md) を参照してください。
DB 関数を変更したら必ず実行してください。

### 5.5 運用ルール

- **本番 DB を管理画面から手動変更しない。** 必ずマイグレーションファイルを残す。
- 反映順序は「後方互換の DB 変更 → アプリデプロイ → 動作確認 → 次回リリースで旧列削除」。
- 破壊的変更にはバックアップとロールバック手順を添える。

---

## 6. 最初の司会者ユーザーを作る

自己登録は無効にしているため、管理者が作成します。

**Authentication → Users → Add user**

- Email / Password を設定
- `Auto Confirm User` を有効にする

作成すると、`auth.users` へのトリガーで `public.profiles` に行が自動作成されます（匿名ユーザーには作られません）。

確認:

```sql
select id, display_name, created_at from public.profiles;
```

`profiles` に行があるユーザーだけが管理画面を利用できます。

---

## 7. Realtime の確認

**Database → Replication** で `supabase_realtime` パブリケーションを確認します。

SmileQ Live は **Broadcast（private channel）** を使います。テーブルの変更をそのまま流す Postgres Changes には依存していません。

チャンネル:

| チャンネル | 購読できる役割 |
|---|---|
| `room:<roomId>:public` | 参加者 / 投影担当 / 司会者 |
| `room:<roomId>:staff` | 投影担当 / 司会者のみ |

- クライアントからの Broadcast 送信ポリシーは**作りません**。イベント送信は Cloud Run のサーバー処理からのみ行います。
- 参加者が `staff` チャンネルを購読できないことを、統合テストで確認しています。

---

## 8. バックアップと保存期間

**Database → Backups**

| 項目 | 推奨 |
|---|---|
| 自動バックアップ | 有効（プランに依存） |
| Point-in-time recovery | 本番では有効を推奨 |

参加者のニックネームは個人情報になりうるため、保存期間の方針を決めてください。
イベント終了後の削除・匿名化は [docs/OPERATIONS.md](./OPERATIONS.md) の開催後チェックリストに含めています。

---

## 9. 型定義の再生成

スキーマを変更したら、TypeScript の型定義も更新してください。

```bash
supabase gen types typescript --project-id <ref> --schema public > src/types/database.generated.ts
```

現在の `src/types/database.ts` は手書きで管理しています。生成結果と差分がないか確認し、必要な部分を反映してください。

---

## 10. 確認チェックリスト

- [ ] 匿名認証が有効
- [ ] 一般ユーザーの自己登録が無効
- [ ] Site URL / Redirect URLs に正式ドメインが入っている
- [ ] `quiz-media` バケットが存在する
- [ ] 4 つのマイグレーションがすべて適用済み
- [ ] `public.profiles` に司会者が 1 人以上いる
- [ ] 全テーブルで RLS が有効（`Database → Tables` の RLS 列を確認）
- [ ] 匿名ユーザーで `questions` / `choices` / `rooms` を SELECT できないことを確認
- [ ] バックアップ設定を確認した
