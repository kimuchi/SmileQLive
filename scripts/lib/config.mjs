import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fatal, info, warn } from './log.mjs';

/**
 * デプロイ設定ファイルの解決と検証。
 *
 * 対象環境の決定順序:
 *   1. コマンドライン引数        例) npm run deploy -- production
 *   2. 環境変数 SMILEQ_DEPLOY_ENV
 *   3. deploy/ に存在する設定ファイルが 1 つだけならそれ
 *   4. 両方あれば production（本番は必ず確認プロンプトを通す）
 */

export const ENVIRONMENTS = ['staging', 'production'];

export function repoUrl(relative) {
  return new URL(`../../${relative}`, import.meta.url);
}

export function configPath(environment) {
  return repoUrl(`deploy/cloud-run.${environment}.json`);
}

export function configExists(environment) {
  return existsSync(configPath(environment));
}

/**
 * CLI 引数からフラグと位置引数を取り出す。
 * `--key=value` と `--key value` の両方に対応する（後者は値を取るフラグのみ）。
 */
const VALUE_FLAGS = new Set([
  'env',
  'url',
  'mode',
  'service',
  'domain',
  'project', // rules:deploy / host:* で Firebase プロジェクトを直接指定する
  'only', // rules:deploy の対象を絞る
  'name', // host:add の表示名
  'uid', // host:remove で uid を直接指定する
]);

export function parseArgs(argv) {
  const positional = [];
  const flags = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }

    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }

    const next = argv[i + 1];
    if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
      continue;
    }

    flags.set(body, true);
  }

  return { positional, flags };
}

export function resolveEnvironment(positional, flags) {
  const explicit =
    positional.find((value) => ENVIRONMENTS.includes(value)) ??
    (typeof flags.get('env') === 'string' ? flags.get('env') : undefined) ??
    process.env.SMILEQ_DEPLOY_ENV;

  if (explicit) {
    if (!ENVIRONMENTS.includes(explicit)) {
      fatal(
        `不明なデプロイ先です: ${explicit}`,
        `指定できるのは ${ENVIRONMENTS.join(' / ')} です。例: npm run deploy -- staging`,
      );
    }
    return { environment: explicit, inferred: false };
  }

  const available = ENVIRONMENTS.filter(configExists);

  if (available.length === 0) {
    fatal(
      'デプロイ設定ファイルが見つかりません。',
      [
        'まず設定ファイルを作成してください:',
        '  cp deploy/cloud-run.production.example.json deploy/cloud-run.production.json',
        '  （ステージングは cloud-run.staging.example.json）',
        '詳細は docs/DEPLOYMENT.md を参照してください。',
      ].join('\n'),
    );
  }

  if (available.length === 1) {
    return { environment: available[0], inferred: true };
  }

  return { environment: 'production', inferred: true };
}

/**
 * 必須キー。
 *
 * Firebase 版では**サーバー用の秘密情報が存在しない**ため、Secret Manager 関連のキーは必須ではない。
 * Admin SDK は Cloud Run 実行サービスアカウントの ADC で認証する（docs/FIRESTORE_MODEL.md §6）。
 * `firebaseApiKey` は公開前提の識別子であって秘密鍵ではないので、設定ファイルへ書いてよい。
 */
const REQUIRED_KEYS = [
  'projectId',
  'region',
  'serviceName',
  'serviceAccount',
  'firebaseProjectId',
  'firebaseApiKey',
  'firebaseAuthDomain',
  'mediaBucket',
];

export function loadDeployConfig(environment) {
  const path = configPath(environment);

  if (!existsSync(path)) {
    fatal(
      `設定ファイルがありません: deploy/cloud-run.${environment}.json`,
      [
        `  cp deploy/cloud-run.${environment}.example.json deploy/cloud-run.${environment}.json`,
        'を実行し、projectId などを実際の値へ書き換えてください。',
        '（このファイルは .gitignore 済みでコミットされません）',
      ].join('\n'),
    );
  }

  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fatal(
      `設定ファイルを読み込めません: deploy/cloud-run.${environment}.json`,
      `JSON として不正です: ${error.message}`,
    );
  }

  const missing = REQUIRED_KEYS.filter((key) => !config[key]);
  if (missing.length > 0) {
    fatal(
      `設定値が不足しています: ${missing.join(', ')}`,
      `deploy/cloud-run.${environment}.json を確認してください。`,
    );
  }

  // Firebase のサービスアカウント秘密鍵を設定ファイルへ貼ってしまう事故を止める。
  // Cloud Run では ADC を使うため、そもそも秘密鍵は不要（docs/FIRESTORE_MODEL.md §6）。
  const serialized = JSON.stringify(config);
  if (serialized.includes('-----BEGIN PRIVATE KEY-----') || serialized.includes('"private_key"')) {
    fatal(
      'デプロイ設定へサービスアカウントの秘密鍵が含まれています。',
      [
        'Cloud Run では秘密鍵を使いません。実行サービスアカウントの ADC で認証します。',
        'この設定ファイルから鍵を削除し、漏洩した鍵は Google Cloud コンソールで無効化してください。',
      ].join('\n'),
    );
  }

  if (config.turnstileSecretName && String(config.turnstileSecretName).length > 60) {
    fatal(
      'turnstileSecretName に Secret の「値」が入っている可能性があります。',
      'ここには Secret Manager 上の「シークレット名」だけを書いてください。値は JSON へ書かないこと。',
    );
  }

  return normalizeConfig(config, environment);
}

/** 文字列配列として正規化する（未設定・不正値は空配列）。 */
function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function normalizeConfig(config, environment) {
  const normalized = {
    environment,
    projectId: String(config.projectId),
    region: String(config.region),
    serviceName: String(config.serviceName),
    serviceAccount: String(config.serviceAccount),
    firebaseProjectId: String(config.firebaseProjectId),
    firebaseApiKey: String(config.firebaseApiKey),
    firebaseAuthDomain: String(config.firebaseAuthDomain),
    firebaseStorageBucket: config.firebaseStorageBucket
      ? String(config.firebaseStorageBucket)
      : `${String(config.firebaseProjectId)}.firebasestorage.app`,
    firebaseAppId: config.firebaseAppId ? String(config.firebaseAppId) : '',
    allowedAuthDomains: toStringArray(config.allowedAuthDomains),
    mediaBucket: String(config.mediaBucket),
    appBaseUrl: config.appBaseUrl ? String(config.appBaseUrl).replace(/\/+$/, '') : '',
    customDomain: config.customDomain ? String(config.customDomain).trim() : '',
    domainMode: config.domainMode === 'load-balancer' ? 'load-balancer' : 'domain-mapping',
    presentationLinkTtlMinutes: Number(config.presentationLinkTtlMinutes ?? 480),
    minInstances: Number(config.minInstances ?? (environment === 'production' ? 1 : 0)),
    maxInstances: Number(config.maxInstances ?? (environment === 'production' ? 10 : 5)),
    concurrency: Number(config.concurrency ?? 80),
    cpu: String(config.cpu ?? '1'),
    memory: String(config.memory ?? '1Gi'),
    timeout: String(config.timeout ?? '60s'),
    logLevel: String(config.logLevel ?? 'info'),
    ingress: String(config.ingress ?? 'all'),
    allowedBranches: Array.isArray(config.allowedBranches)
      ? config.allowedBranches.map(String)
      : ['main'],
    requireCleanTree: config.requireCleanTree !== false,
    runVerifyBeforeDeploy: config.runVerifyBeforeDeploy !== false,
    turnstileSiteKey: config.turnstileSiteKey ? String(config.turnstileSiteKey) : '',
    turnstileSecretName: config.turnstileSecretName ? String(config.turnstileSecretName) : '',
    extraEnv:
      config.extraEnv && typeof config.extraEnv === 'object' ? { ...config.extraEnv } : {},
    optionalFlags: {
      cpuBoost: config.cpuBoost !== false,
      startupProbe: config.startupProbe !== false,
      ...(config.optionalFlags ?? {}),
    },
  };

  if (normalized.customDomain) {
    const expected = `https://${normalized.customDomain}`;
    if (!normalized.appBaseUrl) {
      normalized.appBaseUrl = expected;
      info(`customDomain から appBaseUrl を補完しました: ${expected}`);
    } else if (normalized.appBaseUrl !== expected) {
      warn(
        `appBaseUrl (${normalized.appBaseUrl}) と customDomain (${normalized.customDomain}) が一致していません。` +
          ' 参加用二次元コードは appBaseUrl を使って生成されます。',
      );
    }
  }

  if (normalized.environment === 'production' && !normalized.appBaseUrl) {
    warn(
      '本番の appBaseUrl が未設定です。Cloud Run の既定 URL が使われます。' +
        ' 正式ドメイン運用時は customDomain または appBaseUrl を設定してください。',
    );
  }

  return normalized;
}

/**
 * APP_BASE_URL を含む Cloud Run 実行時環境変数を組み立てる。
 *
 * ここに**サーバー用の秘密情報は入らない**。Firestore / Auth / Storage への認証は
 * Cloud Run 実行サービスアカウントの ADC で行う（docs/FIRESTORE_MODEL.md §6）。
 * FIREBASE_API_KEY は公開前提の識別子なので、環境変数として渡してよい。
 */
export function buildRuntimeEnv(config, appBaseUrl) {
  const env = {
    NODE_ENV: 'production',
    APP_ENV: config.environment,
    HOSTNAME: '0.0.0.0',
    FIREBASE_PROJECT_ID: config.firebaseProjectId,
    FIREBASE_API_KEY: config.firebaseApiKey,
    FIREBASE_AUTH_DOMAIN: config.firebaseAuthDomain,
    FIREBASE_STORAGE_BUCKET: config.firebaseStorageBucket,
    APP_BASE_URL: appBaseUrl ?? '',
    MEDIA_BUCKET: config.mediaBucket,
    PRESENTATION_LINK_TTL_MINUTES: String(config.presentationLinkTtlMinutes),
    LOG_LEVEL: config.logLevel,
    NEXT_TELEMETRY_DISABLED: '1',
    ...(config.firebaseAppId ? { FIREBASE_APP_ID: config.firebaseAppId } : {}),
    // 未設定なら「ドメイン制限なし」。空文字を渡すとその意図が読み取れないため、値がある時だけ渡す
    // （docs/HOST_ACCESS.md — 司会者権限は profiles/{uid} の存在で決まる）。
    ...(config.allowedAuthDomains.length > 0
      ? { ALLOWED_AUTH_DOMAINS: config.allowedAuthDomains.join(',') }
      : {}),
    ...(config.turnstileSiteKey ? { TURNSTILE_SITE_KEY: config.turnstileSiteKey } : {}),
    ...config.extraEnv,
  };

  return env;
}

/**
 * gcloud の辞書型フラグ値を組み立てる。
 *
 * 既定の区切りはカンマだが、値にカンマが含まれると壊れる。
 * その場合は gcloud の代替デリミタ構文 `^<区切り>^key=value<区切り>key=value` を使い、
 * どの値にも現れない文字を区切りとして選ぶ。
 */
const DELIMITER_CANDIDATES = [',', '@', '|', '#', ';', '~', '%'];

export function toGcloudDict(record) {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  const values = entries.map(([, value]) => String(value));

  const delimiter = DELIMITER_CANDIDATES.find(
    (candidate) => !values.some((value) => value.includes(candidate)),
  );

  if (!delimiter) {
    // 候補がすべて使われている場合は、そのままでは安全に渡せない。
    fatal(
      '環境変数の値に特殊文字が多く、gcloud へ安全に渡せません。',
      `対象: ${entries.map(([key]) => key).join(', ')}\n` +
        'extraEnv の値を見直すか、Secret Manager 経由で渡してください。',
    );
  }

  const pairs = entries.map(([key, value]) => `${key}=${value}`);
  return delimiter === ',' ? pairs.join(',') : `^${delimiter}^${pairs.join(delimiter)}`;
}
