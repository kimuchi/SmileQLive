# アーキテクチャ — SmileQ Live

---

## 1. 全体構成

```text
参加者スマートフォン ─┐
投影ブラウザ          ├─ HTTPS ─ Cloud Run / Next.js 16 (standalone)
司会ブラウザ          ┘                  │
                                         │  すべての書き込み（Admin SDK / ADC）
                                         ├────────────► Firestore        (唯一の正しい永続状態)
                                         ├────────────► Firebase Auth    (司会=Google / 参加者=匿名)
                                         └────────────► Cloud Storage    (最適化済み画像)

ブラウザ ─ onSnapshot（読み取りのみ）──────────────────► rooms/{id}/public/state
                                                          ※ Security Rules が最終防壁
```

- ブラウザは **Cloud Run 経由で HTTP API** を呼びます。
- **状態の受信だけは Firestore へ直接接続**（`onSnapshot`）します。これにより Cloud Run の各インスタンスが WebSocket 状態を持たず、複数インスタンスへスケールしても動作が一致します。
- **クライアントからの Firestore 書き込みは一切ありません。** 書き込みはすべて Admin SDK 経由です。
- Admin SDK は Cloud Run 実行サービスアカウントの **ADC** で認証します。**サーバー用の秘密情報はありません**（docs/FIRESTORE_MODEL.md §6）。
- Cloud Run のローカルメモリ・ローカルディスクを永続保存先として使いません。

---

## 2. 責任分界

| 層 | 役割 |
|---|---|
| Cloud Run / Next.js | 画面、Route Handler、**認可**、入力検証、画像変換、参加 URL 処理、状態遷移、正誤判定 |
| Firestore | クイズ、ルーム、参加者、回答、監査ログの永続化。トランザクションによる原子性 |
| Firebase Auth | 司会者の Google 認証、参加者の匿名認証、セッションクッキー |
| Cloud Storage | WebP 化された画像（署名付き URL で配信） |
| Security Rules | **最終防壁**。クライアントが直接叩いても正解が漏れないことを担保 |

> **Admin SDK は Security Rules を迂回します。**
> したがって認可は必ずアプリケーション側で行います。
> Rules は「アプリを通らない経路」を塞ぐためのものであり、アプリの認可の代わりにはなりません。

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
├─ infrastructure/           Firebase・ログの実装（差し替え可能に隔離）
│  ├─ firebase/admin.ts      Admin SDK（ADC で初期化）
│  ├─ firebase/client.ts     ブラウザ用 SDK（読み取り専用）
│  ├─ firebase/repositories/ Firestore アクセス
│  └─ logging/               構造化ログとマスク
├─ lib/                      認証、HTTP、検証、暗号、環境変数、音声
└─ types/                    API 契約と Firestore ドキュメント型
```

依存の向きは **app → application → domain**、`infrastructure` は `application` から使われます。
`domain` は Next.js にも Firebase にも依存しません（バックエンドを差し替えてもそのまま使えます）。

---

## 4. 状態機械

ルームにはモードがあり、**ルームを作るときに決めて途中で変えません**
（途中で変えると、参加者が読んだ二次元コードの意味が変わってしまうため）。

| モード | 何をするか | 参加者のスマホ |
|---|---|---|
| `quiz` | 問題を出して答えてもらう | 使う |
| `lottery` | 名簿から当選者を 1 人ずつ引く | 使わない |
| `bingo` | 数字や景品を 1 つずつ引く（カードは紙） | 使わない |
| `roulette` | 円盤を回して止まった扇を出す（外れない） | 使わない |
| `poll` | 全員に投票してもらい、順位を発表する | 使う |

フェーズ名は**モードごとに分けています**。
`draw_ready` / `draw_revealed` は抽選会・ビンゴ・ルーレット専用、
`poll_*` は投票専用、`question_*` はクイズ専用です。
共有すると「クイズのつもりの操作が抽選のルームで通る」事故が起きます。
どの操作を出してよいかは `availableActions(phase, mode)` が決め、
サーバー側でも `actionAllowedInMode()` で二重に弾きます。

### 4.1 クイズ

```text
lobby
  ↓ show_question
question_ready
  ↓ open_question
question_open        ← extend_deadline（回答時間の延長。フェーズは変わらない）
  ↓ lock_question（手動 or 時間切れの自動処理）
question_locked
  ↑ reopen_question（締め切った直後に受付へ戻す。正解発表後は戻せない）
  ↓ reveal_answer
answer_revealed
  ↓ show_scoreboard（任意）
scoreboard
  ↓ show_question（次の問題）
  …
finished
  ↓ reopen_room（再開。得点・回答は残したまま scoreboard／lobby へ戻る）
```

`extend_deadline` は `answer_deadline_at` だけを伸ばします。
伸ばす起点は**サーバー時刻**で、まだ残っていれば残り時間へ足し、
すでに過ぎていれば操作した時点から数え直します（締切直後の救済に使えます）。
締め切ったあとは延長できません（締切を見て回答をやめた人が不利になるため）。
締め切ってしまった直後に戻したいときは `reopen_question` を使います。
こちらは締切時刻を**今から**数え直します。正解を出したあとは戻せません
（答えを見てから回答できてしまうため）。

時間切れの自動処理は司会画面・投影画面のどちらか一方が開いていれば動きます
（`useExpiryLock`）。Cloud Run は状態を持たないため、サーバー側の常駐タイマーは置きません。
判定そのものはサーバー時刻で行うので、クライアントが早めに知らせても締切は早まりません。

`reopen_room` は `finished` から出られる唯一の遷移です。
`finished_at` を消し、終了時に閉じた `join_open` を戻します。
得点・回答・参加者はそのまま残るため、同じ二次元コードで再開できます。

### 4.2 抽選会・ビンゴ

```text
lobby
  ↓ open_draw
draw_ready  ←──────────┐
  ↓ draw_next          │ continue_draw / undo_draw / reset_draws
draw_revealed ─────────┘
  ↓ draw_next（続けて引く。ビンゴはこれを繰り返す）
  …
finished
  ↓ reopen_room（再開。引いた記録は残したまま draw_ready へ戻る）
```

**次に何が出るかは、引く操作を受けたサーバーがその瞬間に決めます。**
候補を先にクライアントへ渡して選ばせることはしません
（正解を発表前に送らない、という §6 と同じ扱いです）。
選び方は偏りの無い乱数（`node:crypto` の `randomInt`）を使います。

引いた記録は `rooms/{roomId}.drawn` に「引いた順」で並びます。
`order` は 1 始まりの連番で、抽選会ではそのまま当選順位になります
（GAS 版がスプレッドシートの「当選」列へ 1,2,3… と書いていたものに相当）。

- `undo_draw` は**末尾の 1 件だけ**を取り消します。連番が歯抜けになりません。
- `reset_draws` は全部戻します（GAS 版の「当選リセット」に相当）。
- 引くものが無くなると `DRAW_POOL_EMPTY` を返し、司会画面は「終了」へ導きます。

引く操作をするのは司会 1 人だけなので、参加登録と違い 1 ドキュメントへの
書き込みが集中しません。配列で持ってよい理由がここにあります。

### 4.3 投票

```text
lobby
  ↓ open_poll
poll_open              ← 参加者が投票する（1 台につき 1 票）
  ↓ close_poll         この瞬間の票を数えて pollTally へ凍らせる
poll_closed            ← 司会が票数を確かめ、必要なら直す
  ↑ reopen_poll（締切の押し間違いから戻す。凍らせた集計は捨てる）
  ↓ start_reveal
poll_revealing
  ↓ reveal_next（下の順位から 1 つずつ。revealedCount が増える）
  …
finished
  ↓ reopen_room（再開。投票と集計は残したまま lobby へ戻る）
```

**発表を始めたら受付へは戻せません**（`reopen_poll` は `poll_closed` からだけ）。
結果を見てから投票できてしまうためです。

1 票は `rooms/{roomId}/votes/{participantId}` へ `create` で書きます。
ドキュメント ID が参加者 ID なので、二度目は Firestore が弾きます。
回答の `{questionId}__{participantId}` と同じ「決定的 ID を一意制約として使う」形です。

**投票中は票の内訳を誰にも渡しません。** 参加者にも投影にも送りません
（途中経過が見えると、あとの人の投票が引っぱられるため）。
発表でも、**出した順位までしか投影へ渡しません**。
全部渡して画面で隠すと、投影の HTML から先に読めてしまいます。

集計を凍らせたあと、司会は**票数だけ**を直せます。点数と順位は毎回そこから計算し直します。
投票の記録そのものは消さないので、いつでも数え直せます。

投影のルーレット（名前が高速に切り替わって減速して止まる）は
**投影画面のローカルだけで完結**します。サーバーは常駐タイマーを持ちません。
`useDrawRoulette` は「画面を開いた直後に見えた結果」では回しません。
後から繋いだときに、いきなり回り出すと「今引いた」ように見えてしまうためです。

| 状態 | 投影 | 参加者 | 回答 API |
|---|---|---|---|
| `lobby` | 二次元コード・参加人数 | 待機 | 拒否 |
| `question_ready` | 「まもなく出題」※ | 待機※ | 拒否 |
| `question_open` | 残り時間・回答数 | 回答可能 | 受付 |
| `question_locked` | 締切表示 | 回答済み／締切 | 拒否 |
| `answer_revealed` | 正解・集計・解説 | 自分の回答と正解 | 拒否 |
| `scoreboard` | 上位ランキング | 自分の順位 | 拒否 |
| `poll_open` | 二次元コード・投票数 | 投票できる | 受付（投票） |
| `poll_closed` | 「集計中」 | 締切の案内 | 拒否 |
| `poll_revealing` | 発表した順位まで | 発表した順位まで | 拒否 |
| `finished` | 終了画面 | 終了画面 | 拒否 |

※ クイズ設定「回答受付を始める前に問題を見せる」をオンにすると、この段階でも問題を表示します。
既定はオフで、**サーバーが問題そのものを送りません**（画面側で隠しているのではない）。
司会画面だけは読み上げのため常に受け取ります。

司会は `nextStep()` が返す 1 つのボタン（「次へ」）を押していくだけで
`lobby → … → finished` まで進められます。個別の操作も残してあります。

必須条件:

- `question_open` へ移る際に **サーバー時刻（Cloud Run の `Date.now()`）** を基準として `answerDeadlineAt` を設定する
- 回答受付可否は Firestore 上の状態と期限で判断する（参加者端末の時計は信用しない）
- 締切操作と時間切れ処理は**冪等**（複数端末から同時に呼ばれても 1 回だけ進む）
- 正解発表は `question_locked` からだけ実行できる
- すべての状態変更で `stateVersion` を 1 増やす
- 司会 API は `expectedVersion` を受け取り、古い画面からの操作を **409**（`STATE_VERSION_CONFLICT`）で拒否する
- `rooms/{id}` と `rooms/{id}/public/state` を**必ず同じトランザクションで**更新する

---

## 5. 状態配信設計（Firestore `onSnapshot`）

Supabase 版では「Realtime は通知だけ、実データは API」でしたが、
Firestore では**購読対象のドキュメントそのものが実データ**です。
そのため「参加者に見せてよい状態」だけを別ドキュメントへ複製しています。

### 原則

1. **書き込みはすべてサーバー（Admin SDK）から**。クライアントは読み取りのみ
2. `rooms/{id}` と `rooms/{id}/public/state` は同じトランザクションで更新する
3. 再接続時・バージョンの飛びを検知したときは Snapshot API を呼ぶ
4. **購読データだけから現在状態を組み立てない**（Snapshot が基準）
5. 公開ドキュメントへ画像バイナリ・参加トークン・正解を含めない
6. 公開ドキュメントは常に `stateVersion` を持つ

### 購読対象と権限

| 役割 | `rooms/{id}` | `public/state` | `staff/progress` | 書き込み |
|---|:---:|:---:|:---:|:---:|
| 参加者 | **不可** | 購読可 | 不可 | 不可 |
| 投影担当 | **不可** | 購読可 | 購読可 | 不可 |
| 司会者 | 所有ルームのみ | 購読可 | 購読可 | 不可（API 経由） |

`rooms/{id}` には `quizSnapshot`（正解・解説・正解画像 URL）が入っています。
Firestore の Security Rules は**フィールド単位の読み取り制限ができない**ため、
ドキュメントを読めれば正解も読めてしまいます。だからドキュメントごと分けています。

対応表の正本は [docs/FIRESTORE_MODEL.md](./FIRESTORE_MODEL.md) §4 と `firebase/firestore.rules` です。

### 接続手順

```text
1. 認証（司会=Google / 参加者=匿名）とセッションクッキー交換を完了
2. rooms/{id}/members への登録を完了
3. rooms/{id}/public/state を onSnapshot で購読
4. Snapshot API を取得
5. Snapshot の stateVersion を現在値とする
6. 以後のスナップショットを反映
7. バージョンの飛びを検知したら Snapshot を再取得
8. 接続エラーは指数バックオフで再接続（SDK が自動再接続する場合も Snapshot は取り直す）
```

---

## 6. 正解を漏らさないための設計

| 場所 | 対策 |
|---|---|
| API レスポンス | 参加者向けは `toPublicQuestion()` を通した DTO のみ返す |
| Snapshot | `phase < answer_revealed` では `reveal` / `breakdown` を `null` |
| 購読データ | `public/state` には phase と questionId だけ。問題文・選択肢・正解を含めない |
| Security Rules | 参加者は `rooms/{id}`（`quizSnapshot`）と `quizzes/**` へ**到達できない** |
| 画像 | 正解解説画像の URL を正解発表まで参加者へ返さない（Storage は直接読み取り不可） |
| ファイル名 | 保存パスに `correct` / `answer` 等の語を含めない |
| テスト | `toPublicQuestion()` の出力を JSON 文字列化して正解語が含まれないことを検査 |
| Rules 検証 | `npm run test:rules` でエミュレータへ実際に適用し、参加者が読めないことを確認 |

**CSS で隠すだけの実装は禁止**です。

---

## 7. 数値問題の扱い

```text
入力 → NFKC 正規化 → 空白・カンマ・アンダースコア除去 → 形式検証（指数表記は拒否）
     → 桁数検証（整数+小数で 30 桁 / 小数 10 桁）→ Decimal 化
     → サーバーへ raw と normalizedText を両方送る
     → Cloud Run 上の decimal.js で最終判定（両端を含む）
     → Firestore へ **文字列のまま**保存（numberRaw / numberNormalized）
```

| 判定方法 | 条件 |
|---|---|
| 完全一致 | `answer = correct` |
| 許容誤差 | `abs(answer - correct) <= tolerance` |
| 範囲指定 | `answer between min and max` |

- **JavaScript の `number` で正誤を決めません。** 判定は `judgeNumberAnswer()`（decimal.js）だけが行います。
- **Firestore の number 型へ入れません。** Firestore の数値は倍精度浮動小数点しか持たず、
  `numeric(30,10)` 相当の精度を保てないためです。必ず文字列で保存します。
- 生の入力文字列と正規化後の値を両方保存し、本人の結果画面には生入力を表示、投影集計には正規化値を使います。

> **PostgreSQL 版から失われた多層防御**
> Supabase 版は「サーバーの decimal.js」と「DB の `numeric`」で二重に判定していました。
> Firebase 版はサーバー側の 1 回だけです。
> ただし参加者は回答ドキュメントを直接書き込めない（Rules で拒否）ため、
> 「クライアントが正誤を詐称する」経路は残りません。
> これは Firebase 採用に伴う既知のトレードオフです（docs/FIRESTORE_MODEL.md §1）。

---

## 8. 回答登録

Firestore の `runTransaction` で原子的に処理します。Route Handler で読み取りと書き込みを素朴に並べません。

```text
1. セッションクッキーから uid を特定
2. rooms/{roomId}/members/{uid} が有効な participant か確認
3. rooms/{roomId} を読み、phase='question_open' を確認
4. currentQuestionId の一致を確認
5. サーバー時刻（Date.now()）が answerDeadlineAt 以前か確認
6. quizSnapshot から現在問題を取得
7. 問題型と送信値の組合せを確認（クライアントの answerType は使わない）
8. 選択式なら choiceId が現在問題の選択肢か確認
9. 数値式なら文字列として正規化・検証（Decimal 化）
10. スナップショットの正解条件で正誤を判定（decimal.js）
11. elapsedMs をサーバー時刻で計算
12. 得点を計算（正解 → points / 不正解 → 0）
13. answers/{questionId}__{participantId} を create()（既存なら二重回答）
14. 同じトランザクションで members/{uid} の得点合計を加算
15. 回答済み人数を返す
```

### 1 参加者・1 問につき 1 回答

ドキュメント ID を `${questionId}__${participantId}` に固定し、`create()` で書き込みます。
既に存在すれば `ALREADY_EXISTS` になるため、`UNIQUE` 制約と同じ強さの保証が
**追加の読み取りなしで**得られます。

参加者端末の時計・表示状態・送信された正解情報を信用しません。

---

## 9. タイマー

- サーバーが `answerDeadlineAt` を設定し、Snapshot と `public/state` へ `serverTime` を含める
- クライアントは `serverOffsetMs = serverTime - localNow` を推定し、表示だけをローカル更新
- **毎秒の Firestore 書き込みを行わない**（書き込み回数がそのまま費用と遅延になります）
- 残り 0 秒で投影／司会画面が冪等な締切 API を呼ぶ
- 締切 API が呼ばれなくても、回答 API がサーバー時刻で期限切れ回答を拒否する

---

## 10. 性能と費用の設計

- 回答は 1 人 1 問 1 ドキュメント作成
- 回答受付中は内訳を計算・送信しない（合計回答数のみ）
- 締切／正解発表時に問題型別の集計を 1 回だけ計算
- 参加者画面から定期ポーリングしない（購読が切れたときだけ Snapshot 再取得）
- 画像は WebP・長辺 1600px 以下（選択肢は 1000px 以下）
- 投影画面は次に使う画像と効果音を事前読込
- 複合インデックスは `firebase/firestore.indexes.json` で管理する（コンソールで手作業に作らない）
- **進捗ドキュメントへの書き込み集中を避ける**（Firestore は 1 ドキュメントあたりの書き込み頻度に上限があります）
  - `answeredCount` の更新は 400ms のスロットリングで間引く
  - 正確な件数が要る場面（締切・正解発表・司会 Snapshot）では `count()` 集計クエリでその場で数える
  - 参加者ごとの得点合計は `members/{memberId}` へ回答と同じトランザクションで加算する

---

## 11. プラットフォーム非依存

- Windows / macOS / Linux で同じ `npm run` / `pnpm` コマンドを使う
- Bash 専用・PowerShell 専用のデプロイスクリプトを作らない
- デプロイ処理は Node.js の `.mjs` から実行し、子プロセスは配列引数 + `shell: false`
- 本番ビルドは Cloud Build で行い、開発 PC の CPU アーキテクチャに依存しない
- Vercel 固有 API / Vercel KV / Vercel Edge Runtime へ依存しない
- Next.js は標準 Node.js サーバーとして動作させる
- Firestore / Auth / Storage へのアクセスは `infrastructure` 層へ隔離する
- Firebase Hosting / Cloud Functions へ依存しない（アプリ本体は Cloud Run で動かす）

---

## 12. 禁止している実装

- 回答数取得のための 1 秒間隔ポーリング
- カウントダウンの毎秒 Firestore 書き込み
- Cloud Run インスタンスのメモリだけにルーム状態を保持する実装
- **クライアントから Firestore へ書き込む実装**（書き込みは Admin SDK 経由のみ）
- **参加者に `rooms/{id}` や `quizzes/**` を購読させる実装**（正解が入っています）
- サービスアカウントの秘密鍵をリポジトリ・コンテナ・ブラウザへ置く実装
- 参加者へ正解情報を先送りし CSS だけで隠す実装
- 参加者画面と投影画面で音声モジュールを共用する実装
- ルームコード入力を参加の標準導線に戻す実装
- JavaScript の `number` だけで小数の正誤判定を行う実装
- 数値回答を Firestore の number 型で保存する実装
