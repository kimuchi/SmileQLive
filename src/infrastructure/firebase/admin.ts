import 'server-only';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';

/**
 * Firebase Admin SDK。
 *
 * Cloud Run 上では **実行サービスアカウントの ADC（Application Default Credentials）**で
 * 認証するため、秘密鍵ファイルも Secret Manager も不要。
 * これは Supabase の SUPABASE_SECRET_KEY 運用からの明確な改善点。
 *
 * ローカル開発では次のどちらかを使う。
 *   1. Firebase Emulator（FIRESTORE_EMULATOR_HOST 等を設定）
 *   2. gcloud auth application-default login による ADC
 *   3. どうしても鍵が必要な場合のみ GOOGLE_APPLICATION_CREDENTIALS にパスを渡す
 *
 * Admin SDK は Security Rules を迂回する。
 * したがって認可は必ずアプリケーション側（src/lib/auth/session.ts）で行うこと。
 */

let cachedApp: App | null = null;

function firebaseProjectId(): string {
  const value =
    process.env.FIREBASE_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT;
  if (!value || value.trim().length === 0) {
    throw new Error('MISSING_ENV: FIREBASE_PROJECT_ID');
  }
  return value;
}

function storageBucketName(): string {
  const value = process.env.FIREBASE_STORAGE_BUCKET;
  if (value && value.trim().length > 0) {
    return value;
  }
  // Firebase の既定バケット名
  return `${firebaseProjectId()}.firebasestorage.app`;
}

export function getFirebaseAdminApp(): App {
  if (cachedApp) {
    return cachedApp;
  }

  const existing = getApps();
  if (existing.length > 0 && existing[0]) {
    cachedApp = existing[0];
    return cachedApp;
  }

  const projectId = firebaseProjectId();
  const storageBucket = storageBucketName();

  // サービスアカウント鍵を JSON 文字列で渡す運用も一応許容するが、
  // Cloud Run では設定せず ADC を使うことを推奨する。
  const inlineCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (inlineCredentials && inlineCredentials.trim().length > 0) {
    const parsed = JSON.parse(inlineCredentials) as {
      project_id: string;
      client_email: string;
      private_key: string;
    };
    cachedApp = initializeApp({
      credential: cert({
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        // 環境変数経由だと改行がエスケープされることがある。
        privateKey: parsed.private_key.replace(/\\n/g, '\n'),
      }),
      projectId,
      storageBucket,
    });
    return cachedApp;
  }

  cachedApp = initializeApp({ projectId, storageBucket });
  return cachedApp;
}

let cachedFirestore: Firestore | null = null;

export function getDb(): Firestore {
  if (cachedFirestore) {
    return cachedFirestore;
  }
  const db = getFirestore(getFirebaseAdminApp());
  // undefined のフィールドを書き込みエラーにせず無視する。
  // 省略可能な項目（画像なしなど）を毎回 null 埋めしなくてよくなる。
  db.settings({ ignoreUndefinedProperties: true });
  cachedFirestore = db;
  return cachedFirestore;
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getAdminStorage(): Storage {
  return getStorage(getFirebaseAdminApp());
}

export function getMediaBucket() {
  return getAdminStorage().bucket(storageBucketName());
}

/** テスト用にキャッシュを破棄する。 */
export function resetFirebaseAdmin(): void {
  cachedApp = null;
  cachedFirestore = null;
}

/** 起動時の構成確認（管理画面の診断で使う）。 */
export function checkFirebaseConfiguration(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (
    !process.env.FIREBASE_PROJECT_ID &&
    !process.env.GOOGLE_CLOUD_PROJECT &&
    !process.env.GCLOUD_PROJECT
  ) {
    missing.push('FIREBASE_PROJECT_ID');
  }
  if (!process.env.FIREBASE_API_KEY) {
    missing.push('FIREBASE_API_KEY');
  }
  if (!process.env.FIREBASE_AUTH_DOMAIN) {
    missing.push('FIREBASE_AUTH_DOMAIN');
  }
  return { ok: missing.length === 0, missing };
}
