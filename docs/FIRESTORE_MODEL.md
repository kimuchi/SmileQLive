# Firestore データモデル — SmileQ Live

Supabase PostgreSQL から Firebase へ移行するにあたり、
**「正解を正解発表前に参加者へ渡さない」** という最重要要件をどう担保するかを中心に設計しています。

---

## 1. 移行にあたっての前提と、失われるもの

| 項目 | PostgreSQL 版 | Firebase 版 |
|---|---|---|
| 数値の正誤判定 | サーバー(`decimal.js`) と DB(`numeric`) の**二重判定** | **サーバーの `decimal.js` のみ** |
| 回答の一意性 | `UNIQUE (room_id, question_id, participant_id)` | **決定的ドキュメントID + `create()`**（同等の保証） |
| 状態遷移の原子性 | `SELECT ... FOR UPDATE` + トランザクション | `runTransaction`（同等） |
| 行レベルの秘匿 | RLS ポリシー | Security Rules + **ドキュメント分割** |
| リアルタイム | Realtime Broadcast（通知のみ） | `onSnapshot`（DB の実データを直接購読） |
| サーバー時刻 | `now()` を DB が決定 | Cloud Run のサーバー時刻（クライアント時刻は不使用） |

> **重要な設計変更**
> Firestore の数値型は倍精度浮動小数点しか持たないため、`numeric(30,10)` 相当の再判定ができません。
> そこで数値回答は **必ず文字列として保存**し（`numberRaw` / `numberNormalized`）、
> 判定は信頼されたサーバー（Cloud Run）上の `decimal.js` だけで行います。
> 参加者は回答ドキュメントを直接書き込めない（Security Rules で拒否）ため、
> 「クライアントが正誤を詐称する」経路は残りません。
> 一方で「DB 側でも再判定する」多層防御は失われます。これは Firebase 採用に伴う既知のトレードオフです。

---

## 2. コレクション構造

```text
profiles/{uid}
    司会者・管理者。Google Workspace アカウントで作成される。
    ここに行がある利用者だけが管理画面を使える。

mediaAssets/{assetId}
    画像メタデータ（WebP へ変換済みのもののみ）。

quizzes/{quizId}
    クイズ本体。questions は配列ではなくサブコレクション。
    sharedWith: 閲覧・利用を許可した司会者の uid（所有者は 1 人のまま）。
    └─ questions/{questionId}
           選択肢は最大 5 件なので、ドキュメント内に配列として埋め込む
           （1 問の更新が 1 回の書き込みで原子的に済む）。

rooms/{roomId}                      ★ 司会者のみ読める（正解を含む）
    quizSnapshot（正解・解説・正解画像を含む開催時点の固定コピー）
    joinTokenHash / phase / stateVersion / currentQuestionId / answerDeadlineAt ...
    │
    ├─ public/state                 ★ 参加者・投影担当が購読する「公開状態」
    │      phase / stateVersion / serverTime / currentQuestionId
    │      currentQuestionPosition / answerDeadlineAt / joinOpen / participantCount
    │      ※ 正解情報・問題文・選択肢を一切含めない
    │
    ├─ staff/progress               ★ 司会・投影のみ
    │      answeredCount / participantCount / onlineCount
    │      breakdown（締切後のみ）
    │
    ├─ members/{memberId}           参加者・司会・投影担当
    │      role / nickname / joinedAt / lastSeenAt / isActive
    │      totalPoints / correctCount / correctElapsedMsTotal（集計を随時更新）
    │
    ├─ answers/{questionId}__{participantId}   ★ 決定的ID = 二重回答の防止
    │      answerType / choiceId / numberRaw / numberNormalized
    │      answeredAt / elapsedMs / isCorrect / pointsAwarded
    │
    └─ events/{stateVersion}        状態変更の監査ログ

presentationLinks/{linkId}
    投影用一時リンク（トークンは SHA-256 ハッシュのみ保存）。
```

### なぜ `rooms/{roomId}` を直接購読させないか

`rooms/{roomId}` には `quizSnapshot`（正解・解説・正解画像 URL）が入っています。
Firestore の Security Rules は**フィールド単位の読み取り制限ができない**ため、
ドキュメントを読めれば正解も読めてしまいます。

そこで **公開してよい状態だけを `rooms/{roomId}/public/state` へ複製**し、
参加者にはそちらだけを購読させます。
この分割は、PostgreSQL 版の `room:<id>:public` / `room:<id>:staff` チャンネル分割と同じ考え方です。

---

## 3. 重要な不変条件の担保方法

### 3.1 1 参加者・1 問につき 1 回答

ドキュメント ID を `${questionId}__${participantId}` に固定し、
`create()`（既存なら失敗）で書き込みます。

```ts
await answerRef.create({ ... });   // 既に存在すれば ALREADY_EXISTS
```

`UNIQUE` 制約と同じ強さの保証が、追加の読み取りなしで得られます。

### 3.2 状態遷移の競合検出

```ts
await firestore.runTransaction(async (tx) => {
  const room = await tx.get(roomRef);
  if (room.data().stateVersion !== expectedVersion) throw STATE_VERSION_CONFLICT;
  if (!canTransition(room.data().phase, action)) throw INVALID_TRANSITION;
  tx.update(roomRef, { phase: next, stateVersion: expectedVersion + 1, ... });
  tx.set(publicStateRef, { ... });     // 公開状態も同じトランザクションで更新
  tx.create(eventRef, { ... });        // 監査ログ
});
```

`rooms/{roomId}` と `rooms/{roomId}/public/state` が**必ず同じバージョンで更新**されます。

### 3.3 締切の判定

回答受付は Cloud Run 上のサーバー時刻で判定します。
参加者端末の時計は一切信用しません。

```ts
const now = Date.now();                       // Cloud Run のサーバー時刻
if (now > room.answerDeadlineAt.toMillis()) throw ANSWER_DEADLINE_PASSED;
```

`answerDeadlineAt` は `open_question` 時にサーバーが決定して保存します。

### 3.4 回答進捗の書き込み集中を避ける

200 人が 10 秒で回答すると、進捗ドキュメントへの書き込みが毎秒 20 回になり、
Firestore の 1 ドキュメントあたりの書き込み上限に当たります。

対策:

- 回答ごとの `answeredCount` 更新は **400ms のスロットリング**で間引く
- 正確な件数が要る場面（締切・正解発表・司会 Snapshot）では
  **`count()` 集計クエリ**でその場で数える
- 参加者ごとの得点合計は `members/{memberId}` へ回答と同じトランザクションで加算する
  （ランキング算出時に全回答を読まなくて済む）

---

## 4. Security Rules の考え方

**すべての書き込みは Cloud Run（Admin SDK）経由**とし、クライアントからの直接書き込みは全面的に拒否します。
Admin SDK は Security Rules を迂回するため、認可はアプリケーション側で行います。
Rules は「万一クライアントが直接叩いても何も漏れない」ための最終防壁です。

| パス | 参加者 | 投影担当 | 司会者 |
|---|---|---|---|
| `rooms/{id}` | ✗ | ✗ | 所有者のみ読み取り |
| `rooms/{id}/public/state` | 読み取り可 | 読み取り可 | 読み取り可 |
| `rooms/{id}/staff/progress` | ✗ | 読み取り可 | 読み取り可 |
| `rooms/{id}/members/{mid}` | 自分の行のみ | 自分の行のみ | 全件 |
| `rooms/{id}/answers/{aid}` | 自分の回答のみ | ✗ | 全件 |
| `quizzes/**` | ✗ | ✗ | 所有者と共有相手のみ |
| `mediaAssets/**` | ✗ | ✗ | 所有者のみ |
| すべての書き込み | ✗ | ✗ | ✗ |

参加者が `quizzes/**` を読めないため、**正解・解説は Rules の層でも到達不能**です。

---

## 5. 認証（Google Workspace）

- 司会者: Firebase Auth の **Google プロバイダ**。`hd`（ホストドメイン）クレームで
  自社 Workspace ドメインのみ許可し、さらに `profiles/{uid}` の存在を確認する。
- 参加者・投影担当: **匿名認証**。
- サーバー側は **セッションクッキー**（`createSessionCookie` / `verifySessionCookie`）で検証する。
  Cookie は `Secure` / `HttpOnly` / `SameSite=Lax`。

---

## 6. 認証情報の扱い（Supabase 版からの改善）

Cloud Run 上の Admin SDK は**サービスアカウントの ADC** を使うため、
**秘密鍵ファイルも Secret Manager も不要**になります。

| | Supabase 版 | Firebase 版 |
|---|---|---|
| サーバー用の秘密情報 | `SUPABASE_SECRET_KEY` を Secret Manager から注入 | **不要**（Cloud Run の実行サービスアカウントの権限で認証） |
| クライアントへ渡す設定 | URL + Publishable Key | Firebase Web 設定（apiKey 等。公開前提） |

Firebase の `apiKey` は秘密情報ではありません（公開しても安全な識別子）。
実際の保護は Security Rules と、サーバー側の認可で行います。
