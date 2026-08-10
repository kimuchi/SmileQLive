#!/usr/bin/env node
/**
 * Google Cloud の初期設定（冪等）。
 *
 *   npm run gcp:bootstrap -- staging
 *   npm run gcp:bootstrap -- production
 *
 * 実行内容:
 *   1. 必要な API の有効化
 *   2. Cloud Run 実行用サービスアカウントの作成
 *   3. Secret Manager のシークレット（箱）の作成
 *   4. 実行用サービスアカウントへ Secret Accessor 権限を付与
 *   5. Cloud Build 用サービスアカウントへビルド／デプロイに必要な権限を付与
 *
 * 既存リソースは破壊しない。IAM 変更権限が無い場合は、必要なロールを提示して終了する。
 * Secret の「値」はこのスクリプトでは登録しない（Console か gcloud で別途登録する）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadDeployConfig, parseArgs, resolveEnvironment } from './lib/config.mjs';
import {
  ensureGcloud,
  ensureLoggedIn,
  ensureProjectAccessible,
  projectNumber,
  secretExists,
  secretHasVersion,
} from './lib/gcloud.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));
const { environment } = resolveEnvironment(positional, flags);
const config = loadDeployConfig(environment);

heading(`Google Cloud 初期設定 — ${environment}`);
info(`プロジェクト: ${config.projectId}`);
info(`リージョン  : ${config.region}`);

step('gcloud の確認');
ensureGcloud();
const account = ensureLoggedIn();
success(`ログイン中: ${account}`);
ensureProjectAccessible(config.projectId);

// ---------------------------------------------------------------------------
step('必要な API を有効化');
const apis = [
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'iam.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
];
const enabled = run('gcloud', ['services', 'enable', ...apis, '--project', config.projectId], {
  allowFailure: true,
});
if (!enabled.ok) {
  fatal(
    'API の有効化に失敗しました。',
    [
      '実行アカウントに次の権限が必要です:',
      '  roles/serviceusage.serviceUsageAdmin',
      '管理者へ依頼するか、権限のあるアカウントで実行してください。',
      '',
      '手動で有効化する場合:',
      `  gcloud services enable ${apis.join(' ')} --project ${config.projectId}`,
    ].join('\n'),
  );
}
success('API を有効化しました');

// ---------------------------------------------------------------------------
step('Cloud Run 実行用サービスアカウント');
const saEmail = config.serviceAccount;
const saName = saEmail.split('@')[0];

const saDescribe = run(
  'gcloud',
  ['iam', 'service-accounts', 'describe', saEmail, '--project', config.projectId],
  { capture: true, quiet: true, allowFailure: true },
);

if (saDescribe.ok) {
  success(`既存のサービスアカウントを使用します: ${saEmail}`);
} else {
  const created = run(
    'gcloud',
    [
      'iam',
      'service-accounts',
      'create',
      saName,
      '--display-name',
      'SmileQ Live runtime',
      '--description',
      'Cloud Run で SmileQ Live を実行する最小権限アカウント',
      '--project',
      config.projectId,
    ],
    { allowFailure: true },
  );
  if (!created.ok) {
    fatal(
      `サービスアカウントを作成できませんでした: ${saEmail}`,
      [
        '実行アカウントに roles/iam.serviceAccountAdmin が必要です。',
        '管理者へ次の作成を依頼してください:',
        `  gcloud iam service-accounts create ${saName} --project ${config.projectId}`,
      ].join('\n'),
    );
  }
  success(`サービスアカウントを作成しました: ${saEmail}`);
}

// ---------------------------------------------------------------------------
step('Secret Manager のシークレットを準備');
const secretNames = [config.supabaseSecretName];
if (config.turnstileSecretName) {
  secretNames.push(config.turnstileSecretName);
}

for (const secretName of secretNames) {
  if (secretExists(config.projectId, secretName)) {
    success(`既存のシークレット: ${secretName}`);
  } else {
    const created = run(
      'gcloud',
      [
        'secrets',
        'create',
        secretName,
        '--replication-policy',
        'automatic',
        '--labels',
        `app=smileq-live,env=${environment}`,
        '--project',
        config.projectId,
      ],
      { allowFailure: true },
    );
    if (!created.ok) {
      fatal(
        `シークレットを作成できませんでした: ${secretName}`,
        '実行アカウントに roles/secretmanager.admin が必要です。',
      );
    }
    success(`シークレットを作成しました: ${secretName}`);
  }

  const binding = run(
    'gcloud',
    [
      'secrets',
      'add-iam-policy-binding',
      secretName,
      '--member',
      `serviceAccount:${saEmail}`,
      '--role',
      'roles/secretmanager.secretAccessor',
      '--project',
      config.projectId,
      '--condition=None',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (binding.ok) {
    success(`アクセス権限を付与しました: ${secretName} → ${saEmail}`);
  } else {
    warn(`シークレットへの権限付与に失敗しました: ${secretName}`);
    info('管理者へ次を依頼してください:');
    info(
      `  gcloud secrets add-iam-policy-binding ${secretName} --member serviceAccount:${saEmail} --role roles/secretmanager.secretAccessor --project ${config.projectId}`,
    );
  }
}

// ---------------------------------------------------------------------------
step('Cloud Build（ソースデプロイ）用の権限');
const number = projectNumber(config.projectId);
const buildAccounts = [
  `${number}-compute@developer.gserviceaccount.com`,
  `${number}@cloudbuild.gserviceaccount.com`,
];

// gcloud run deploy --source . は Cloud Build でイメージを作り、
// Artifact Registry へ push し、Cloud Run へデプロイする。
const buildRoles = [
  'roles/run.builder',
  'roles/artifactregistry.writer',
  'roles/logging.logWriter',
  'roles/storage.objectAdmin',
];

for (const member of buildAccounts) {
  for (const role of buildRoles) {
    const result = run(
      'gcloud',
      [
        'projects',
        'add-iam-policy-binding',
        config.projectId,
        '--member',
        `serviceAccount:${member}`,
        '--role',
        role,
        '--condition=None',
      ],
      { capture: true, quiet: true, allowFailure: true },
    );
    if (!result.ok) {
      warn(`権限付与をスキップ: ${member} → ${role}`);
    }
  }
}
success('Cloud Build 用の権限付与を試行しました');

// Cloud Run 実行時に実行用 SA を使うため、デプロイ実行者に actAs 権限が要る。
const actAs = run(
  'gcloud',
  [
    'iam',
    'service-accounts',
    'add-iam-policy-binding',
    saEmail,
    '--member',
    `user:${account}`,
    '--role',
    'roles/iam.serviceAccountUser',
    '--project',
    config.projectId,
    '--condition=None',
  ],
  { capture: true, quiet: true, allowFailure: true },
);
if (actAs.ok) {
  success(`${account} に serviceAccountUser を付与しました`);
} else {
  warn('serviceAccountUser の付与に失敗しました（既に付与済みの場合は問題ありません）。');
}

// ---------------------------------------------------------------------------
heading('次の手順');
if (!secretHasVersion(config.projectId, config.supabaseSecretName)) {
  console.log(`  ${color.yellow('1.')} Supabase の Secret Key を登録してください（値はリポジトリへ書かない）:`);
  console.log(
    `       gcloud secrets versions add ${config.supabaseSecretName} --project ${config.projectId} --data-file=-`,
  );
  console.log('       （実行後に値を貼り付け、Ctrl+D / Windows は Ctrl+Z Enter）\n');
} else {
  console.log(`  ${color.green('1.')} Secret の値は登録済みです。\n`);
}
console.log(`  2. Supabase 側のマイグレーションを適用（docs/SUPABASE_SETUP.md）\n`);
console.log(`  3. デプロイ:`);
console.log(`       npm run deploy -- ${environment}\n`);
if (config.customDomain) {
  console.log(`  4. カスタムドメインの設定:`);
  console.log(`       npm run domain:map -- ${environment}\n`);
}
