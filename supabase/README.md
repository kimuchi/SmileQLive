# SmileQ Live / Supabase

会場イベント向けリアルタイムクイズ **SmileQ Live** のデータベース定義。
PostgreSQL を唯一の正とし、締切判定・正誤判定・順位付けはすべて DB 側の関数で行う。
Realtime は「状態が変わった」ことを伝える通知だけに使う。

## ディレクトリ

| ファイル | 内容 |
| --- | --- |
| `migrations/20260810000100_initial_schema.sql` | 列挙型・テーブル・制約・トリガー |
| `migrations/20260810000200_rls.sql` | RLS 有効化・ポリシー・テーブル権限 |
| `migrations/20260810000300_functions.sql` | スナップショット生成・公開前検証・状態遷移・回答受付・集計 |
| `migrations/20260810000400_realtime.sql` | private channel の購読制御 |
| `seed.sql` | ローカル開発用サンプルクイズ |
| `config.toml` | Supabase CLI（ローカル環境）の設定 |

マイグレーションはファイル名の昇順で適用される。**適用済みのファイルは書き換えず、新しいファイルを足す。**

## ローカル起動

```bash
# 1. Docker Desktop / Docker Engine を起動しておく
supabase start

# 2. 出力された URL とキーを .env.local へ書き写す
supabase status
#   API URL       → SUPABASE_URL
#   publishable   → SUPABASE_PUBLISHABLE_KEY
#   secret        → SUPABASE_SECRET_KEY（サーバー専用。ブラウザへ渡さない）

# 3. Studio
open http://127.0.0.1:54323
```

`supabase start` は `migrations/` を昇順に適用し、最後に `seed.sql` を実行する。

停止・完全初期化は次のとおり。

```bash
supabase stop            # 停止（データは残る）
supabase stop --no-backup # 停止してデータも破棄
supabase db reset        # マイグレーションを最初から適用し直し、seed も再実行
```

## マイグレーションの追加と適用

```bash
# 新しいマイグレーションファイルを作る
supabase migration new add_something

# ローカルへ適用（既存データを保ったまま未適用分だけ流す）
supabase migration up

# ローカルを作り直して全マイグレーションを検証する（推奨）
supabase db reset
```

リモート（ステージング／本番）へ反映する場合。

```bash
supabase link --project-ref <project-ref>
supabase db push            # 未適用のマイグレーションを流す
supabase migration list     # ローカルとリモートの適用状況を突き合わせる
```

`supabase db push` は破壊的変更を自動では止めない。本番へ流す前に
`supabase db diff --linked` で差分を必ず確認すること。

## 型生成

`src/types/database.ts` は Supabase の型出力に合わせて手書きしている。
スキーマを変更したら、生成結果と突き合わせて手で更新する。

```bash
# ローカル DB から生成
supabase gen types typescript --local --schema public > /tmp/database.generated.ts

# リンク済みのリモートから生成
supabase gen types typescript --linked --schema public > /tmp/database.generated.ts

# 差分を確認して src/types/database.ts へ反映する
diff -u src/types/database.ts /tmp/database.generated.ts
```

`--schema public` を必ず付ける。`auth` や `storage` の型をアプリへ持ち込まない。

## 認証の設定（匿名認証を有効・自己登録を無効）

司会者は招待制、参加者と投影担当は匿名ユーザーとして認証する。
参加は QR コードの URL 直行のみで、ルームコード入力画面は用意しない。

### ローカル

`config.toml` に設定済み。変更したら `supabase stop && supabase start` で反映する。

```toml
[auth]
enable_signup = false             # 自己登録を無効（司会者アカウントは管理者が作成）
enable_anonymous_sign_ins = true  # 参加者・投影担当は匿名サインイン

[auth.email]
enable_signup = false
```

### ステージング・本番（Supabase ダッシュボード）

1. **Authentication → Sign In / Providers → Email**
   - `Allow new users to sign up` を **オフ**
   - `Confirm email` は運用に合わせて設定
2. **Authentication → Sign In / Providers → Anonymous Sign-ins**
   - `Allow anonymous sign-ins` を **オン**
3. **Authentication → Rate Limits**
   - `Anonymous sign-ins` を会場規模に合わせて引き上げる
     （会場 Wi-Fi は NAT で同一 IP になりやすく、既定の 30 件/時/IP では参加者が詰まる）
4. **Authentication → URL Configuration**
   - `Site URL` と `Redirect URLs` にアプリの公開 URL を登録

### 司会者ユーザーの作成

自己登録が無効なので、管理者が作成する。

```bash
# ローカル
curl -sS -X POST 'http://127.0.0.1:54321/auth/v1/admin/users' \
  -H "apikey: $(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
  -H "Authorization: Bearer $(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
  -H 'Content-Type: application/json' \
  -d '{"email":"host@example.com","password":"smileq-local","email_confirm":true,
       "user_metadata":{"display_name":"デモ司会者"}}'
```

`auth.users` へ行が入ると `on_auth_user_created` トリガーが `public.profiles` を作る。
**匿名ユーザーには `profiles` を作らない**ため、参加者が管理画面へ入ることはできない。

Studio から作る場合は Authentication → Add user で `Auto Confirm User` を有効にする。

## Storage

問題画像は `quiz-media` バケット（非公開）へ WebP だけを保存する。
オブジェクトパスは `<ownerId>/<quizId>/<assetId>.webp`。正解を推測できる語をパスに含めない。
配信 URL はアプリ側で署名 URL として解決する。DB のスナップショットには
`storage://<bucket>/<object_path>` という論理 URL だけを保持する。

## セキュリティモデル

### 権限

- **anon**（未認証）: `public` スキーマのテーブル・関数へ一切アクセスできない。
- **authenticated**: RLS で自分の行に絞られた `SELECT` のみ。書き込みは
  `transition_room` / `lock_question_if_expired` / `register_participant` / `submit_answer`
  の 4 関数だけを RPC で呼べる。
- **service_role**（Cloud Run の Route Handler）: 通常の CRUD と集計関数を実行する。
  `SUPABASE_SECRET_KEY` は `server-only` を付けたモジュールからのみ読む。

### 参加者から見えるもの

| テーブル | 参加者 |
| --- | --- |
| `room_members` | 自分の行のみ |
| `answers` | 自分の回答のみ |
| `rooms` / `questions` / `choices` / `quizzes` / `media_assets` / `profiles` | **1 行も見えない** |

`rooms.quiz_snapshot` には正解値・許容誤差・解説・正解画像が入っている。
参加者へ渡すデータは必ずアプリ側で `toPublicQuestion()` を通し、
正解発表前は正解情報を一切含めない。

投影担当（`presenter`）も自分の `room_members` 行しか見えず、状態変更はできない。

### Realtime

- `room:<uuid>:public` … そのルームの participant / presenter / host が購読できる
- `room:<uuid>:staff` … presenter / host のみ購読できる

`realtime.messages` に **INSERT ポリシーを作っていない**ため、クライアントから
Broadcast を送ることはできない（偽の正解発表・なりすましを防ぐ）。
送信は Route Handler が service_role で行う。

`postgres_changes` は使わない。`answers` や `rooms` の行変更をそのまま配信すると
正解情報や他人の回答が漏れるため、`supabase_realtime` パブリケーションへ
テーブルを追加しないこと。

Broadcast の payload には「状態が変わった」ことだけを載せる。
実データはクライアントが Snapshot API から取り直す。

## DB 関数

| 関数 | 実行できるロール | 用途 |
| --- | --- | --- |
| `build_quiz_snapshot(quiz_id)` | service_role | ルーム作成時のクイズ固定化 |
| `validate_quiz_for_publish(quiz_id)` | service_role | 公開前検証（`{ok, issues[]}`） |
| `transition_room(room_id, action, expected_version, question_id)` | authenticated / service_role | フェーズ遷移（司会者のみ・楽観ロック） |
| `lock_question_if_expired(room_id)` | authenticated / service_role | 締切超過時の締切処理（冪等） |
| `register_participant(room_id, nickname)` | authenticated / service_role | 参加登録（再訪時は既存行を返す） |
| `submit_answer(room_id, question_id, choice_id, number_raw, number_value)` | authenticated / service_role | 回答受付・正誤判定 |
| `room_answer_breakdown(room_id, question_id)` | service_role | 回答集計（締切後にだけ配信する） |
| `room_leaderboard(room_id, limit)` | service_role | ランキング |
| `room_participant_stats(room_id, question_id)` | service_role | 参加者数・回答数 |

エラーは `raise exception '<CODE>'`（SQLSTATE `P0001`）で返す。
`CODE` は `src/lib/errors/app-error.ts` の `AppErrorCode` と一致するので、
Route Handler では `error.message` をそのままコードとして扱える。

主なコード: `FORBIDDEN` / `STATE_VERSION_CONFLICT` / `INVALID_TRANSITION` /
`ROOM_FINISHED` / `ROOM_FULL` / `NICKNAME_TAKEN` / `NICKNAME_INVALID` / `JOIN_CLOSED` /
`NOT_A_PARTICIPANT` / `ANSWER_NOT_OPEN` / `ANSWER_QUESTION_MISMATCH` /
`ANSWER_DEADLINE_PASSED` / `ANSWER_TYPE_MISMATCH` / `INVALID_CHOICE` /
`ANSWER_ALREADY_EXISTS` / `QUESTION_NOT_FOUND` / `ROOM_NOT_FOUND` / `QUIZ_NOT_FOUND`

### 数値の扱い

- 正誤判定は PostgreSQL の `numeric` だけで行う。`double precision` へ落とさない。
- 判定は両端を含む（`exact` は `=`、`absolute_tolerance` は `abs(v - c) <= t`、
  `range` は `v between min and max`）。
- スナップショットの `numberRule` は `trim_scale(...)::text` で**文字列**として持つ。
  JavaScript 側は `decimal.js` で受け取り、`number` へ暗黙変換しない。

### 締切と経過時間

`answer_deadline_at` は `open_question` の時点で `now() + timeLimitSeconds` として
サーバー時刻で確定する。`submit_answer` の締切判定・`elapsed_ms` の計算はすべて DB 時刻。
クライアントの時計は一切信用しない。

締切超過は `lock_question_if_expired()` で締める。`rooms` 行を `FOR UPDATE` で
ロックするため、複数端末から同時に呼ばれても `state_version` は 1 しか進まない。

## 検証のヒント

`psql` で直接叩くときは、`auth.uid()` が読む設定値を自分でセットする。

```sql
-- 司会者として
select set_config('request.jwt.claim.sub', '<host user id>', false);
select public.transition_room('<room id>', 'show_question', 0, '<question id>');

-- 参加者として（RLS も確認するなら set role も付ける）
set role authenticated;
select set_config('request.jwt.claim.sub', '<participant auth user id>', false);
select public.submit_answer('<room id>', '<question id>', '<choice id>', null, null);
reset role;
```
