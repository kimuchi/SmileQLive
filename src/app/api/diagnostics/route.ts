import { headers } from 'next/headers';
import { getDb, getMediaBucket } from '@/infrastructure/firebase/admin';
import { requireHostUser } from '@/lib/auth/session';
import {
  appBaseUrl,
  appEnvironment,
  checkServerConfiguration,
  mediaBucket as configuredMediaBucket,
} from '@/lib/env/server-env';
import { jsonOk } from '@/lib/errors/api-response';
import { isCaptchaConfigured } from '@/lib/http/captcha';
import { withRoute } from '@/lib/http/route-helpers';
import type { DiagnosticsResponse } from '@/types/api';

/**
 * 構成診断（司会・管理者専用）。
 *
 * - /api/health とは別物。health は Cloud Run の起動プローブ用で DB へ接続しない。
 *   こちらは Firestore / Cloud Storage への軽い疎通確認まで行う。
 * - 失敗しても 200 で返し、checks の ok=false と status='degraded' で伝える
 *   （運用者が原因を切り分けられるようにするため）。
 * - Secret Key・トークンの値そのものは絶対に返さない。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Check = DiagnosticsResponse['checks'][number];

function check(name: string, ok: boolean, detail?: string): Check {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

/** 例外メッセージを診断用に短く整える（スタックは返さない）。 */
function briefly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * Firestore / Cloud Storage への軽い疎通確認。
 *
 * 行データは読まず、存在確認と件数だけを問い合わせる。
 * Firebase 版はサーバー用の秘密情報を持たないため、
 * 「認証情報が正しいか」ではなく「実行サービスアカウントに権限があるか」を見ることになる。
 */
async function checkFirebase(): Promise<Check[]> {
  const results: Check[] = [];

  try {
    // 1 件も読まずに疎通だけ確認する（count 集計はドキュメントを転送しない）。
    const snapshot = await getDb().collection('rooms').count().get();
    results.push(
      check('firestore_connection', true, `rooms への読み取りに成功しました（${snapshot.data().count} 件）`),
    );
  } catch (error) {
    results.push(
      check(
        'firestore_connection',
        false,
        `Firestore を参照できません: ${briefly(error)}。実行サービスアカウントに roles/datastore.user が必要です`,
      ),
    );
  }

  const bucketName = configuredMediaBucket();
  try {
    const [exists] = await getMediaBucket().exists();
    results.push(
      exists
        ? check('storage_bucket', true, `バケット「${bucketName}」を確認しました`)
        : check('storage_bucket', false, `バケット「${bucketName}」が存在しません`),
    );
  } catch (error) {
    results.push(check('storage_bucket', false, `バケット「${bucketName}」: ${briefly(error)}`));
  }

  return results;
}

export const GET = withRoute<DiagnosticsResponse>('diagnostics', async () => {
  // 構成情報は運用者だけに見せる。
  await requireHostUser();

  const environment = appEnvironment();
  const configuration = checkServerConfiguration();
  const baseUrl = appBaseUrl(await headers());

  const checks: Check[] = [
    check(
      'environment_variables',
      configuration.ok,
      configuration.ok
        ? '必須の環境変数が揃っています'
        : `未設定: ${configuration.missing.join(', ')}`,
    ),
    ...(await checkFirebase()),
    check(
      'app_base_url',
      environment === 'local' || Boolean(process.env.APP_BASE_URL),
      environment === 'local' || process.env.APP_BASE_URL
        ? `参加URLの基準: ${baseUrl}`
        : 'APP_BASE_URL が未設定です。二次元コードの URL がリクエスト由来になります',
    ),
    // CAPTCHA は任意機能。未構成でも異常ではない。
    check(
      'captcha',
      true,
      isCaptchaConfigured() ? 'Turnstile 有効' : 'Turnstile 未設定（参加時の人間確認なし）',
    ),
  ];

  const response: DiagnosticsResponse = {
    status: checks.every((entry) => entry.ok) ? 'ok' : 'degraded',
    checks,
    environment,
    appBaseUrl: baseUrl,
  };

  return jsonOk(response);
});
