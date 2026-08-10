#!/usr/bin/env node
/**
 * Google Cloud の初期設定（冪等）。
 *
 *   npm run gcp:bootstrap -- staging
 *   npm run gcp:bootstrap -- production
 *
 * 実行内容:
 *   1. 必要な API の有効化（Cloud Run / Cloud Build / Firestore / Firebase / Storage / Identity Toolkit）
 *   2. Cloud Run 実行用サービスアカウントの作成
 *   3. 実行用サービスアカウントへ Firestore / Auth / Storage の権限を付与
 *   4. Secret Manager のシークレット（箱）の作成 — **Turnstile を使う場合のみ**
 *   5. Cloud Build 用サービスアカウントへビルド／デプロイに必要な権限を付与
 *
 * 既存リソースは破壊しない。IAM 変更権限が無い場合は、必要なロールを提示して終了する。
 * Secret の「値」はこのスクリプトでは登録しない（Console か gcloud で別途登録する）。
 *
 * Firebase 版ではサーバー用の秘密情報を持たない。Admin SDK は Cloud Run 実行
 * サービスアカウントの ADC で認証する（docs/FIRESTORE_MODEL.md §6）。
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
  'iamcredentials.googleapis.com', // 署名付き URL（IAM SignBlob）に必要
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  // --- Firebase ---
  'firestore.googleapis.com', // Firestore（唯一の永続状態）
  'firebase.googleapis.com', // Firebase プロジェクト管理
  'firebasestorage.googleapis.com', // Storage バケット（画像）
  'firebaserules.googleapis.com', // Security Rules のデプロイ
  'identitytoolkit.googleapis.com', // Firebase Authentication
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
step('Cloud Run 実行アカウントへ Firebase の権限を付与');

// Admin SDK は ADC（＝この実行サービスアカウント）で認証する。秘密鍵は使わない。
const runtimeRoles = [
  ['roles/datastore.user', 'Firestore の読み書き'],
  ['roles/firebaseauth.admin', 'セッションクッキー発行・ユーザー管理'],
  ['roles/storage.objectAdmin', '画像の読み書き'],
  // 署名付き URL は「秘密鍵での署名」ではなく IAM の signBlob で発行する。
  // 自分自身へ付与する必要があるため、プロジェクトではなく SA 自身へバインドする。
  ['roles/iam.serviceAccountTokenCreator', '署名付き URL の発行'],
];

const missingRuntimeRoles = [];

for (const [role, purpose] of runtimeRoles) {
  // serviceAccountTokenCreator だけは「サービスアカウント自身」に対して付与する。
  const args =
    role === 'roles/iam.serviceAccountTokenCreator'
      ? [
          'iam',
          'service-accounts',
          'add-iam-policy-binding',
          saEmail,
          '--member',
          `serviceAccount:${saEmail}`,
          '--role',
          role,
          '--project',
          config.projectId,
          '--condition=None',
        ]
      : [
          'projects',
          'add-iam-policy-binding',
          config.projectId,
          '--member',
          `serviceAccount:${saEmail}`,
          '--role',
          role,
          '--condition=None',
        ];

  const result = run('gcloud', args, { capture: true, quiet: true, allowFailure: true });
  if (result.ok) {
    success(`${role}（${purpose}）`);
  } else {
    warn(`権限付与に失敗しました: ${role}（${purpose}）`);
    missingRuntimeRoles.push([role, args]);
  }
}

if (missingRuntimeRoles.length > 0) {
  info('管理者へ次の付与を依頼してください:');
  for (const [, args] of missingRuntimeRoles) {
    info(`  gcloud ${args.join(' ')}`);
  }
}

// ---------------------------------------------------------------------------
// Secret Manager は Turnstile を使う場合だけ必要。
// Firebase 版にはサーバー用の秘密情報が無いため、既定では箱すら作らない。
const secretNames = config.turnstileSecretName ? [config.turnstileSecretName] : [];

if (secretNames.length === 0) {
  step('Secret Manager');
  success('不要です（Firebase 版はサーバー用の秘密情報を持ちません）');
} else {
  step('Secret Manager のシークレットを準備');
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

let stepNo = 1;

if (config.turnstileSecretName && !secretHasVersion(config.projectId, config.turnstileSecretName)) {
  console.log(
    `  ${color.yellow(`${stepNo}.`)} Turnstile の Secret Key を登録してください（値はリポジトリへ書かない）:`,
  );
  console.log(
    `       gcloud secrets versions add ${config.turnstileSecretName} --project ${config.projectId} --data-file=-`,
  );
  console.log('       （実行後に値を貼り付け、Ctrl+D / Windows は Ctrl+Z Enter）\n');
  stepNo += 1;
}

console.log(`  ${stepNo}. Firebase 側の設定（docs/FIREBASE_SETUP.md）:`);
console.log('       * Google プロバイダと匿名認証を有効化');
console.log('       * Firestore データベースを作成（ロケーションは後から変更できません）');
console.log('       * Storage バケットを作成');
console.log('       * 承認済みドメインへ公開 URL を追加\n');
stepNo += 1;

console.log(`  ${stepNo}. Security Rules とインデックスを反映:`);
console.log(`       npm run rules:deploy -- ${environment}\n`);
stepNo += 1;

console.log(`  ${stepNo}. デプロイ:`);
console.log(`       npm run deploy -- ${environment}\n`);
stepNo += 1;

console.log(`  ${stepNo}. 最初の司会者を登録（docs/HOST_ACCESS.md）:`);
console.log('       npm run host:add -- you@example.com --name "あなたの名前"\n');
stepNo += 1;

if (config.customDomain) {
  console.log(`  ${stepNo}. カスタムドメインの設定:`);
  console.log(`       npm run domain:map -- ${environment}\n`);
}
