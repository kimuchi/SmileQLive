# 司会者アクセスの管理 — SmileQ Live

**この文書は、司会者権限をどう守るかの唯一の基準です。実装はこれに従ってください。**

---

## 1. 決定事項

| 項目 | 設定 |
|---|---|
| アプリの公開 URL | `https://q.iefainavi.net` |
| 司会者ログイン | Firebase Auth の Google プロバイダ |
| **ログイン可能なメールドメインの制限** | **なし**（`ALLOWED_AUTH_DOMAINS` は空） |
| 司会者権限の判定 | **`profiles/{uid}` ドキュメントの存在のみ** |

外部の司会者を招く可能性があるため、メールドメインでは絞りません。

---

## 2. これが意味すること（重要）

ドメイン制限が無いため、**`profiles/{uid}` の作り方だけが管理画面への唯一の関門**です。

> ### やってはいけない実装
>
> ```ts
> // ✖ 危険: Google アカウントを持つ誰でも司会者になれてしまう
> if (!(await profileRef.get()).exists) {
>   await profileRef.set({ uid, email, ... });   // 初回ログインで自動作成
> }
> ```
>
> ログインできること（= Google アカウントを持っていること）と、
> 司会者であることを**混同してはいけません**。
> Firebase Auth は「誰であるか」しか保証しません。
> 「司会者であるか」は `profiles` だけが決めます。

### 正しい実装

1. `/api/auth/session` は **`profiles/{uid}` を絶対に作成しない**。
2. サインイン自体は誰でも成功してよい（Firebase Auth の認証は通る）。
3. `requireHostUser()` が `profiles/{uid}` の非存在を検出したら `AppError('FORBIDDEN')`。
4. 画面には「この Google アカウントには管理権限がありません。管理者に登録を依頼してください」
   と表示し、**サインアウトさせる**（中途半端にログイン状態を残さない）。

匿名ユーザー（参加者・投影担当）には `profiles` を作らない、という原則も同じです。

---

## 3. 司会者の登録方法

司会者の追加は**管理者による明示的な操作**でのみ行います。

### 方法 A: 管理スクリプト（推奨）

```bash
npm run host:add -- user@example.com --name "山田太郎"
npm run host:list
npm run host:remove -- user@example.com
```

このスクリプトは Firebase Admin SDK で次を行います。

1. メールアドレスから Firebase Auth ユーザーを検索（無ければ作成し、招待メールを送るか、
   本人に一度 Google ログインしてもらってから再実行する）
2. `profiles/{uid}` を作成
3. 監査のため作成者と作成日時を記録

> **書き込み先のデータベースを必ず確認してください。**
> SmileQ Live は専用の名前付きデータベース（既定 `smileq-live`）を使います。
> 実行時に対象を表示します。
>
> ```text
> プロジェクト  : idl-application
> データベース  : smileq-live
> ```
>
> 既定 `(default)` へ書き込むと、アプリは `smileq-live` を読むため
> **「登録は成功したのにログインできない」**状態になります。
> 同居している既存アプリのデータベースを汚すことにもなります。
> 別のデータベースを対象にする場合だけ `--database` を使います。
>
> ```bash
> npm run host:list -- --database="(default)"     # 誤登録の確認
> npm run host:remove -- user@example.com --database="(default)"   # 誤登録の削除
> ```

### 方法 B: Firebase コンソール

**Firestore → profiles → ドキュメントを追加**

ドキュメント ID に対象ユーザーの `uid`（Authentication タブで確認）を入れ、
`email` / `displayName` / `createdAt` を設定します。

---

## 4. 運用ルール

- [ ] 司会者を追加したら、誰が誰を追加したかを記録する
- [ ] イベント終了後、一時的に追加した外部司会者の `profiles` を削除する
- [ ] 退職・異動時に `profiles` を削除する（Auth ユーザーの削除だけでは不十分な場合に備え、両方）
- [ ] 定期的に `npm run host:list` で棚卸しする

---

## 5. 後からドメイン制限をかけたくなったら

`deploy/cloud-run.production.json` に次を追加して再デプロイします。

```jsonc
{
  "allowedAuthDomains": ["iefainavi.net"]
}
```

これは `profiles` による制御に**追加する**多層防御であり、置き換えではありません。
両方を満たすアカウントだけが管理画面を使えます。
