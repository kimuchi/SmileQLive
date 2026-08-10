/**
 * 認証まわりの「どこからでも import してよい」共有定義。
 *
 * このファイルは **依存を一切持たない**。
 * middleware（Edge ランタイム）・ブラウザ・Cloud Run のいずれからも読まれるため、
 * firebase-admin / firebase / next/headers などを絶対に import しないこと。
 */

/**
 * セッションクッキー名。
 *
 * `__session` は Firebase Hosting が唯一転送してくれるクッキー名であり、
 * Cloud Run 直結でも問題なく使える。将来 Hosting を挟んでも壊れないようこの名前に固定する。
 */
export const SESSION_COOKIE_NAME = '__session';

/**
 * 司会・管理者のセッション有効期限。
 * Firebase のセッションクッキーは最大 14 日。イベント準備〜当日運営を跨げるようこの上限を使う。
 */
export const HOST_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 参加者・投影担当（匿名認証）のセッション有効期限。
 * 会場イベントは長くても半日で終わるため 12 時間で十分。短いほど端末紛失時の被害が小さい。
 */
export const ANONYMOUS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Firebase Auth のサインイン方式（`firebase.sign_in_provider` クレーム）。 */
export const SIGN_IN_PROVIDER = {
  google: 'google.com',
  anonymous: 'anonymous',
} as const;

/**
 * 認証済み利用者。
 *
 * firebase-admin の DecodedIdToken をアプリ都合の形へ包んだもの。
 * `id` は Supabase 版からの移行互換のために `uid` と同じ値を持たせている。
 * 新しいコードでは必ず `uid` を使うこと。
 */
export type AuthUser = {
  uid: string;
  /** @deprecated 互換用。`uid` と同じ値。新規コードでは uid を使う。 */
  id: string;
  email: string | null;
  isAnonymous: boolean;
  displayName: string | null;
  /** メールアドレスのドメイン部（小文字）。匿名ユーザーは null。 */
  hostedDomain: string | null;
};

// ---------------------------------------------------------------------------
// /api/auth/session の契約
// （src/types/api.ts は HTTP API 契約として凍結されているため、認証用はここへ置く）
// ---------------------------------------------------------------------------

export type CreateSessionRequestBody = {
  /** クライアントの Firebase Auth から取得した ID トークン。ログへ出さないこと。 */
  idToken: string;
};

export type CreateSessionResponse = {
  uid: string;
  isAnonymous: boolean;
  /**
   * 司会者として管理画面を使えるか（profiles/{uid} が存在するか）。
   *
   * サインイン自体は誰でも成功してよい。false のときは画面側で
   * 「この Google アカウントには管理権限がありません」と伝えてサインアウトさせる
   * （docs/HOST_ACCESS.md §2）。
   */
  isHost: boolean;
  /** セッションクッキーの失効時刻 (ISO8601)。 */
  expiresAt: string;
};

export type DeleteSessionResponse = {
  signedOut: true;
};

// ---------------------------------------------------------------------------
// 許可ドメインの判定（サーバー・クライアント双方で同じ規則を使う）
// ---------------------------------------------------------------------------

/** `@example.com` / ` Example.COM ` のような揺れを `example.com` へ揃える。 */
export function normalizeAuthDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

/** カンマ区切りの設定値をドメイン配列へ変換する。空要素は落とす。 */
export function parseAuthDomainList(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map(normalizeAuthDomain)
    .filter((domain) => domain.length > 0);
}

/** メールアドレスのドメイン部を取り出す。取り出せなければ null。 */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) {
    return null;
  }
  return normalizeAuthDomain(email.slice(at + 1));
}

/**
 * 許可ドメインに含まれるか。
 * `allowedDomains` が空のときは制限しない（設定していない環境では素通し）。
 */
export function isAllowedAuthDomain(
  email: string | null | undefined,
  allowedDomains: string[],
): boolean {
  if (allowedDomains.length === 0) {
    return true;
  }
  const domain = emailDomain(email);
  if (!domain) {
    return false;
  }
  return allowedDomains.includes(domain);
}
