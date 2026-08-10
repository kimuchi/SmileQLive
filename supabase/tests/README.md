# DB 関数のテスト

Supabase を起動せず、素の PostgreSQL 上でマイグレーションと DB 関数を検証します。

```bash
createdb smileq_sqltest
npm run db:test
# 接続先を変える場合
npm run db:test -- --url postgres://postgres@localhost:5432/smileq_sqltest
```

## 仕組み

| ファイル | 役割 |
|---|---|
| `_supabase_stubs.sql` | `auth` / `realtime` / `storage` スキーマ、`auth.uid()`、`auth.users`、Supabase の組み込みロールを最小構成で再現する |
| `functions_smoke.sql` | 全マイグレーション適用後に、実際のシナリオを 1 本流して検証する |

`scripts/test-sql.mjs` が次の順で実行します。

```text
public / auth / realtime スキーマを作り直す
  → _supabase_stubs.sql
  → supabase/migrations/*.sql（ファイル名順）
  → functions_smoke.sql
```

> **注意**: 指定したデータベースのスキーマを作り直します。Supabase の本番・ステージング DB を指定しないでください（`*.supabase.co` を含む URL は明示的に拒否します）。

## 検証している内容

- `auth.users` トリガーで `profiles` が作られ、**匿名ユーザーには作られない**こと
- 数値式問題に選択肢を作れないこと / 選択式に数値条件を設定できないこと
- 範囲指定の `min > max`、負の許容誤差が CHECK 制約で拒否されること
- `validate_quiz_for_publish` が正解 0 件・選択肢 1 件を「第N問: …」形式で検出すること
- `build_quiz_snapshot` が正解情報を含むスナップショットを生成すること
  （＝参加者へ返す前に DTO 変換が必須であることの裏付け）
- `register_participant` が冪等で、ニックネーム重複を `NICKNAME_TAKEN` で拒否すること
- `transition_room` が
  - 参加者からの実行を `FORBIDDEN` で拒否
  - 古い `expectedVersion` を `STATE_VERSION_CONFLICT` で拒否
  - 不正な遷移を `INVALID_TRANSITION` で拒否
  - `open_question` で `answer_deadline_at` を DB 時刻から設定
- `submit_answer` が
  - 受付前 (`ANSWER_NOT_OPEN`) / 締切後 / 二重回答 (`ANSWER_ALREADY_EXISTS`) を拒否
  - 問題型の不一致 (`ANSWER_TYPE_MISMATCH`) と他問題の選択肢 (`INVALID_CHOICE`) を拒否
  - **レスポンスへ正誤を含めない**
- 数値の範囲判定が**両端を含む**こと（9.5 / 10.5 は正解、10.51 は不正解）
- `room_answer_breakdown` が選択式・数値式それぞれ仕様どおりの形状を返すこと
- `room_leaderboard` の順位規則
- `lock_question_if_expired` が冪等（2 回呼んでも `state_version` が 1 回しか進まない）
- `room_events` に監査ログが残ること

## CI での扱い

GitHub Actions の標準ジョブには含めていません（PostgreSQL サービスコンテナが必要なため）。
DB 関数を変更したときは、ローカルで `npm run db:test` を実行してください。

CI へ組み込む場合は、`services: postgres:16` を追加して
`DATABASE_URL` を渡し、`npm run db:test` を実行します。
