# アーキテクチャ — SmileQ Live

---

## 1. 全体構成

```text
参加者スマートフォン ─┐
投影ブラウザ          ├─ HTTPS ─ Cloud Run / Next.js 16 (standalone)
司会ブラウザ          ┘                  │
                                          ├─ Supabase PostgreSQL   (唯一の正しい永続状態)
ブラウザ ─ Supabase Realtime ────────────┤  Supabase Auth          (司会=恒久 / 参加者=匿名)
                                          ├─ Supabase Storage      (最適化済み画像)
Cloud Run ────────────────────────────────┘  Secret Manager        (サーバー用シークレット)
```

- ブラウザは **Cloud Run 経由で HTTP API** を呼びます。
- **Realtime だけは Supabase へ直接接続**します。これにより Cloud Run の各インスタンスが WebSocket 状態を持たず、複数インスタンスへスケールしても動作が一致します。
- Cloud Run のローカルメモリ・ローカルディスクを永続保存先として使いません。

---

## 2. 責任分界

| 層 | 役割 |
|---|---|
| Cloud Run / Next.js | 画面、Route Handler、認可、入力検証、画像変換、参加 URL 処理、状態遷移の呼び出し |
| PostgreSQL | クイズ、ルーム、参加者、回答、監査ログの永続化。**状態遷移と回答登録の最終判定** |
| Supabase Auth | 司会者の恒久認証、参加者の匿名認証 |
| Supabase Realtime | 状態変更・回答進捗の通知（**保存先ではない**） |
| Supabase Storage | WebP 化された画像 |
| Secret Manager | `SUPABASE_SECRET_KEY` |

---

## 3. ディレクトリ構成

```text
src/
├─ app/                      画面と Route Handler
│  ├─ (admin)/               管理・司会画面
│  ├─ (participant)/         参加者画面   ← 音声モジュールを import しない
│  ├─ present/               会場投影画面 ← ここだけが音声を扱う
│  └─ api/                   HTTP API
├─ components/
│  ├─ admin/ participant/ presentation/ shared/
├─ domain/                   フレームワーク非依存の純粋ロジック（テストの中心）
│  ├─ quiz/                  問題型、公開検証、公開用 DTO
│  ├─ room/                  状態機械、イベント、得点、タイマー、Snapshot 型
│  ├─ answer/                数値正規化、正誤判定、回答 DTO
│  └─ media/                 画像ポリシー
├─ application/              ユースケース（サービス層）
├─ infrastructure/           Supabase・ログの実装（差し替え可能に隔離）
├─ lib/                      認証、HTTP、検証、暗号、環境変数、音声
└─ types/                    API 契約と DB 型
```

依存の向きは **app → application → domain**、`infrastructure` は `application` から使われます。
`domain` は Next.js にも Supabase にも依存しません。

---

## 4. 状態機械

```text
lobby
  ↓ show_question
question_ready
  ↓ open_question
question_open
  ↓ lock_question（手動 or 時間切れ）
question_locked
  ↓ reveal_answer
answer_revealed
  ↓ show_scoreboard（任意）
scoreboard
  ↓ show_question（次の問題）
  …
finished
```

| 状態 | 投影 | 参加者 | 回答 API |
|---|---|---|---|
| `lobby` | 二次元コード・参加人数 | 待機 | 拒否 |
| `question_ready` | 問題・開始待ち | 問題（回答無効） | 拒否 |
| `question_open` | 残り時間・回答数 | 回答可能 | 受付 |
| `question_locked` | 締切表示 | 回答済み／締切 | 拒否 |
| `answer_revealed` | 正解・集計・解説 | 自分の回答と正解 | 拒否 |
| `scoreboard` | 上位ランキング | 自分の順位 | 拒否 |
| `finished` | 終了画面 | 終了画面 | 拒否 |

必須条件:

- `question_open` へ移る際に **DB 時刻**を基準として `answer_deadline_at` を設定する
- 回答受付可否は DB 上の状態と期限で判断する
- 締切操作と時間切れ処理は**冪等**（複数端末から同時に呼ばれても 1 回だけ進む）
- 正解発表は `question_locked` からだけ実行できる
- すべての状態変更で `state_version` を 1 増やす
- 司会 API は `expectedVersion` を受け取り、古い画面からの操作を **409** で拒否する

---

## 5. Realtime 設計

### 原則

1. **DB 更新を先に成功させ、その後に Realtime を送る**
2. Broadcast 送信に失敗しても DB 状態を失わない（ロールバックしない）
3. 再接続時は必ず Snapshot API を呼ぶ
4. **Broadcast だけから現在状態を組み立てない**
5. イベントへ画像バイナリ・参加トークンを含めない
6. 各状態イベントへ `stateVersion` を含める

### チャンネルと権限

| 役割 | `room:<id>:public` | `room:<id>:staff` | Broadcast 送信 |
|---|:---:|:---:|:---:|
| 参加者 | 購読可 | 不可 | 不可 |
| 投影担当 | 購読可 | 購読可 | 不可 |
| 司会者 | 購読可 | 購読可 | サーバーのみ |

クライアント用の Broadcast 送信ポリシーは作りません。

### 接続手順

```text
1. 認証と room_members 登録を完了
2. private channel へ subscribe
3. SUBSCRIBED を確認
4. Snapshot API を取得
5. Snapshot の stateVersion を現在値とする
6. 以後のイベントを反映
7. バージョンの飛びを検知したら Snapshot を再取得
8. CHANNEL_ERROR / TIMED_OUT / CLOSED は指数バックオフで再接続
```

---

## 6. 正解を漏らさないための設計

| 場所 | 対策 |
|---|---|
| API レスポンス | 参加者向けは `toPublicQuestion()` を通した DTO のみ返す |
| Snapshot | `phase < answer_revealed` では `reveal` / `breakdown` を `null` |
| Realtime | public イベントには phase と questionId だけ。詳細は Snapshot で取得 |
| RLS | 参加者は `questions` / `choices` / `rooms.quiz_snapshot` を SELECT できない |
| 画像 | 正解解説画像の URL を正解発表まで参加者へ返さない |
| ファイル名 | 保存パスに `correct` / `answer` 等の語を含めない |
| テスト | `toPublicQuestion()` の出力を JSON 文字列化して正解語が含まれないことを検査 |

**CSS で隠すだけの実装は禁止**です。

---

## 7. 数値問題の扱い

```text
入力 → NFKC 正規化 → 空白・カンマ・アンダースコア除去 → 形式検証（指数表記は拒否）
     → 桁数検証（整数+小数で 30 桁 / 小数 10 桁）→ Decimal 化
     → サーバーへ raw と normalizedText を両方送る
     → PostgreSQL numeric(30,10) で最終判定（両端を含む）
```

| 判定方法 | 条件 |
|---|---|
| 完全一致 | `answer = correct` |
| 許容誤差 | `abs(answer - correct) <= tolerance` |
| 範囲指定 | `answer between min and max` |

- **JavaScript の `number` で正誤を決めません。**
- 生の入力文字列と正規化後の値を両方保存し、本人の結果画面には生入力を表示、投影集計には正規化値を使います。

---

## 8. 回答登録

PostgreSQL 関数 `submit_answer()` で原子的に処理します。Route Handler で SELECT と INSERT を並べません。

```text
1. auth.uid() から参加者を特定
2. 対象ルームの有効な participant か確認
3. rooms 行を FOR UPDATE でロックし phase='question_open' を確認
4. current_question_id の一致を確認
5. DB 時刻が answer_deadline_at 以前か確認
6. quiz_snapshot から現在問題を取得
7. 問題型と送信値の組合せを確認（クライアントの answer_type は使わない）
8. 選択式なら choice_id が現在問題の選択肢か確認
9. 数値式なら numeric として検証
10. スナップショットの正解条件で正誤を判定
11. elapsed_ms を DB 時刻で計算
12. 得点を計算（正解 → points / 不正解 → 0）
13. answers へ INSERT（UNIQUE 違反は二重回答）
14. 回答済み人数を返す
```

参加者端末の時計・表示状態・送信された正解情報を信用しません。

---

## 9. タイマー

- サーバーが `answer_deadline_at` を設定し、Snapshot とイベントへ `serverTime` を含める
- クライアントは `serverOffsetMs = serverTime - localNow` を推定し、表示だけをローカル更新
- **毎秒の DB 更新・Realtime 送信を行わない**
- 残り 0 秒で投影／司会画面が冪等な締切 API を呼ぶ
- 締切 API が呼ばれなくても、回答 API が DB 時刻で期限切れ回答を拒否する

---

## 10. 性能と費用の設計

- 回答は 1 人 1 問 1 INSERT
- 回答受付中は内訳を計算・送信しない（合計回答数のみ）
- 締切／正解発表時に問題型別の集計を 1 回だけ計算
- 参加者画面から定期ポーリングしない（Realtime 切断時だけ Snapshot 再取得）
- 画像は WebP・長辺 1600px 以下（選択肢は 1000px 以下）
- 投影画面は次に使う画像と効果音を事前読込
- `answers(room_id, question_id)` などへ索引を配置
- 200 人を超える場合は回答進捗イベントを 250〜500ms 単位で集約

---

## 11. プラットフォーム非依存

- Windows / macOS / Linux で同じ `npm run` / `pnpm` コマンドを使う
- Bash 専用・PowerShell 専用のデプロイスクリプトを作らない
- デプロイ処理は Node.js の `.mjs` から実行し、子プロセスは配列引数 + `shell: false`
- 本番ビルドは Cloud Build で行い、開発 PC の CPU アーキテクチャに依存しない
- Vercel 固有 API / Vercel KV / Vercel Edge Runtime へ依存しない
- Next.js は標準 Node.js サーバーとして動作させる
- DB / Realtime / Storage へのアクセスは `infrastructure` 層へ隔離する

---

## 12. 禁止している実装

- 回答数取得のための 1 秒間隔ポーリング
- カウントダウンの毎秒 DB 書き込み
- Cloud Run インスタンスのメモリだけにルーム状態を保持する実装
- ブラウザへ Supabase Secret Key を渡す実装
- 参加者へ正解情報を先送りし CSS だけで隠す実装
- 参加者画面と投影画面で音声モジュールを共用する実装
- ルームコード入力を参加の標準導線に戻す実装
- JavaScript の `number` だけで小数の正誤判定を行う実装
