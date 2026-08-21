#!/usr/bin/env node
/**
 * デプロイ前の環境診断。
 *
 *   npm run deploy:doctor
 *   npm run deploy:doctor -- production
 *
 * 変更は一切行わず、「今デプロイできる状態か」だけを確認して表示する。
 * 会場当日の朝や、初めてデプロイする人の詰まりどころ確認に使う。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { existsSync } from 'node:fs';
import {
  configExists,
  ENVIRONMENTS,
  loadDeployConfig,
  parseArgs,
  resolveEnvironment,
} from './lib/config.mjs';
import { activeAccount, secretExists, secretHasVersion, serviceExists } from './lib/gcloud.mjs';
import { checkDependencies } from './lib/deps.mjs';
import { color, heading, info } from './lib/log.mjs';
import { probeCommand, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

heading('SmileQ Live デプロイ診断');

// --- ローカル環境 ------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node.js 24 系', nodeMajor === 24, `検出: v${process.versions.node}`);

// gcloud は「PATH にあるか」ではなく「このスクリプトから起動できるか」を見る。
// 失敗したときは理由（未インストール／PATH 未反映／エイリアス等）を必ず表示する。
const gcloudProbe = probeCommand('gcloud');
check(
  'gcloud CLI',
  gcloudProbe.ok,
  gcloudProbe.ok
    ? gcloudProbe.version
    : gcloudProbe.via === 'shell-only'
      ? gcloudProbe.detail
      : `${gcloudProbe.detail} — 未インストールなら https://cloud.google.com/sdk/docs/install`,
);

const gitProbe = probeCommand('git');
check('Git', gitProbe.ok, gitProbe.ok ? gitProbe.version : gitProbe.detail);
const lockExists = existsSync(new URL('../pnpm-lock.yaml', import.meta.url));
check('pnpm-lock.yaml', lockExists, lockExists ? '' : 'ロックファイルをコミットしてください');

// パッケージマネージャ。pnpm 推奨だが npm でも動く。
// Windows では corepack enable が管理者権限を要求して失敗しやすいので、
// pnpm が無い場合に具体的な回避策を出す。
const pnpmProbe = probeCommand('pnpm');
const npmProbe = probeCommand('npm');
check(
  'パッケージマネージャ',
  pnpmProbe.ok || npmProbe.ok,
  pnpmProbe.ok
    ? `pnpm ${pnpmProbe.version}`
    : npmProbe.ok
      ? `npm ${npmProbe.version}（pnpm 未導入。npm でも動作します。pnpm を使う場合は npm install -g pnpm）`
      : 'pnpm も npm も起動できません。Node.js を再インストールしてください。',
);
// 依存パッケージ。未導入だと deploy は verify（lint/typecheck/test/build）で失敗する。
// ここを見ていなかったため「診断は全部 ✔ なのにデプロイが落ちる」状態になっていた。
const deps = checkDependencies();
check(
  '依存パッケージ',
  deps.ok,
  deps.ok
    ? '導入済み'
    : deps.installed
      ? `不足: ${deps.missing.join(', ')} — ${deps.command}`
      : `node_modules がありません — ${deps.command}`,
);

const dockerfileExists = existsSync(new URL('../Dockerfile', import.meta.url));
check(
  'Dockerfile',
  dockerfileExists,
  dockerfileExists ? '' : 'Cloud Build が使う Dockerfile がありません',
);

// --- 設定ファイル ------------------------------------------------------------
const available = ENVIRONMENTS.filter(configExists);
check(
  'デプロイ設定ファイル',
  available.length > 0,
  available.length > 0
    ? `見つかった環境: ${available.join(', ')}`
    : 'deploy/cloud-run.production.example.json をコピーして作成してください',
);

let config = null;
if (available.length > 0) {
  const { environment } = resolveEnvironment(positional, flags);
  config = loadDeployConfig(environment);
  info(`診断対象: ${environment} (${config.projectId} / ${config.serviceName})`);

  check('firebaseProjectId', Boolean(config.firebaseProjectId), config.firebaseProjectId);
  // apiKey は公開前提の識別子。ここでは「秘密鍵を貼っていないか」だけを見る。
  const apiKeyOk =
    config.firebaseApiKey.length > 0 && !config.firebaseApiKey.includes('BEGIN PRIVATE KEY');
  check(
    'firebaseApiKey が公開用の識別子であること',
    apiKeyOk,
    apiKeyOk
      ? ''
      : 'サービスアカウントの秘密鍵を JSON へ書かないでください（Cloud Run は ADC で認証）',
  );
  const authDomainOk = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(config.firebaseAuthDomain);
  check(
    'firebaseAuthDomain',
    authDomainOk,
    authDomainOk
      ? config.firebaseAuthDomain
      : `${config.firebaseAuthDomain} — 例: ${config.firebaseProjectId}.firebaseapp.com`,
  );
  // 既存アプリと同じ Firebase プロジェクトへ同居しても壊さないための 2 点
  // （docs/FIREBASE_SETUP.md「分離のしくみ」）。
  const usesNamedDatabase = config.firestoreDatabaseId !== '(default)';
  check(
    'Firestore は専用データベース',
    usesNamedDatabase,
    usesNamedDatabase
      ? config.firestoreDatabaseId
      : '(default) は既存アプリのルールとインデックスを上書きします',
  );
  const defaultBuckets = [
    `${config.firebaseProjectId}.firebasestorage.app`,
    `${config.firebaseProjectId}.appspot.com`,
  ];
  const usesDedicatedBucket = !defaultBuckets.includes(config.mediaBucket);
  check(
    'Storage は専用バケット',
    usesDedicatedBucket,
    usesDedicatedBucket
      ? config.mediaBucket
      : `${config.mediaBucket} は Firebase 既定バケットです — 例: ${config.firebaseProjectId}-smileq-media`,
  );
  check(
    '司会ログインの許可ドメイン',
    true,
    config.allowedAuthDomains.length > 0
      ? config.allowedAuthDomains.join(', ')
      : '制限なし（管理画面を使えるのは profiles/{uid} がある利用者だけ — docs/HOST_ACCESS.md）',
  );
  check(
    'appBaseUrl',
    Boolean(config.appBaseUrl) || config.environment !== 'production',
    config.appBaseUrl || '未設定（Cloud Run の既定 URL を使用）',
  );
  if (config.customDomain) {
    check(
      'customDomain と appBaseUrl の一致',
      config.appBaseUrl === `https://${config.customDomain}`,
      `${config.appBaseUrl} / https://${config.customDomain}`,
    );
  }
  const minInstancesOk = config.environment !== 'production' || config.minInstances >= 1;
  check(
    '本番の最小インスタンス',
    minInstancesOk,
    minInstancesOk
      ? `minInstances=${config.minInstances}`
      : `minInstances=${config.minInstances} — 会場開催時は 1 以上にしてください`,
  );
}

// --- Google Cloud ------------------------------------------------------------
if (config && gcloudProbe.ok) {
  const account = activeAccount();
  check('gcloud ログイン', Boolean(account), account || 'gcloud auth login を実行してください');

  if (account) {
    const projectOk = run(
      'gcloud',
      ['projects', 'describe', config.projectId, '--format=value(projectId)'],
      { capture: true, quiet: true, allowFailure: true },
    ).ok;
    check('プロジェクトへのアクセス', projectOk, config.projectId);

    if (projectOk) {
      // Firebase 版はサーバー用の秘密情報を持たない。Secret Manager は Turnstile 利用時のみ。
      if (config.turnstileSecretName) {
        check(
          'Secret が存在する',
          secretExists(config.projectId, config.turnstileSecretName),
          config.turnstileSecretName,
        );
        const hasSecretValue = secretHasVersion(config.projectId, config.turnstileSecretName);
        check(
          'Secret に値がある',
          hasSecretValue,
          hasSecretValue
            ? ''
            : `gcloud secrets versions add ${config.turnstileSecretName} --project ${config.projectId} --data-file=-`,
        );
      } else {
        check('Secret Manager', true, '不要（Cloud Run の実行サービスアカウントで認証）');
      }

      // 実行サービスアカウントの権限。
      //
      // gcp:bootstrap の権限付与は失敗しても続行する作りなので、
      // 「作成もデプロイも成功したのに実行時だけ失敗する」状態になりうる。
      // とくに serviceAccountTokenCreator が無いと、ログインの最後で
      // セッションクッキーを発行できず 500 になる（画面には原因が出ない）。
      const projectRoles = run(
        'gcloud',
        [
          'projects',
          'get-iam-policy',
          config.projectId,
          '--flatten=bindings[].members',
          `--filter=bindings.members:serviceAccount:${config.serviceAccount}`,
          '--format=value(bindings.role)',
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
      const selfRoles = run(
        'gcloud',
        [
          'iam',
          'service-accounts',
          'get-iam-policy',
          config.serviceAccount,
          '--project',
          config.projectId,
          '--flatten=bindings[].members',
          `--filter=bindings.members:serviceAccount:${config.serviceAccount}`,
          '--format=value(bindings.role)',
        ],
        { capture: true, quiet: true, allowFailure: true },
      );

      if (projectRoles.ok) {
        const granted = new Set(
          `${projectRoles.stdout}\n${selfRoles.ok ? selfRoles.stdout : ''}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
        const required = [
          ['roles/datastore.user', 'Firestore の読み書き'],
          ['roles/firebaseauth.admin', 'セッションクッキー発行・ユーザー管理'],
          ['roles/storage.objectAdmin', '画像の読み書き'],
          ['roles/iam.serviceAccountTokenCreator', '署名付き URL の発行'],
        ];
        const missingRoles = required.filter(([role]) => !granted.has(role));
        check(
          '実行サービスアカウントの権限',
          missingRoles.length === 0,
          missingRoles.length === 0
            ? config.serviceAccount
            : `未付与: ${missingRoles.map(([role, why]) => `${role}（${why}）`).join(' / ')} — npm run gcp:bootstrap -- ${config.environment}`,
        );
      }

      // Firestore が作られていないと、デプロイは通っても起動直後に必ず失敗する。
      // --database を省くと (default) を見てしまう。既存アプリの (default) は
      // 常に存在するため、専用データベースが無くても ✔ になってしまう。
      const firestoreOk = run(
        'gcloud',
        [
          'firestore',
          'databases',
          'describe',
          '--database',
          config.firestoreDatabaseId,
          '--project',
          config.firebaseProjectId,
          '--format=value(name)',
        ],
        { capture: true, quiet: true, allowFailure: true },
      ).ok;
      check(
        'Firestore データベース',
        firestoreOk,
        firestoreOk
          ? `${config.firebaseProjectId} / ${config.firestoreDatabaseId}`
          : `${config.firestoreDatabaseId} がありません — npm run gcp:bootstrap -- ${config.environment}`,
      );

      /*
        画像の保存先バケットが実在するか。

        ここを見ていなかったため、名前を間違えたまま（あるいは設定を渡し忘れたまま）
        デプロイでき、当日「画像だけアップロードできない」で気づく形になっていた。
        バケットは初回デプロイでは作られないので、無ければここで言う。
      */
      const bucketOk = run(
        'gcloud',
        [
          'storage',
          'buckets',
          'describe',
          `gs://${config.mediaBucket}`,
          '--project',
          config.projectId,
          '--format=value(name)',
        ],
        { capture: true, quiet: true, allowFailure: true },
      ).ok;
      check(
        '画像の保存先バケット',
        bucketOk,
        bucketOk
          ? config.mediaBucket
          : `${config.mediaBucket} がありません — Firebase の Storage を有効にするか、設定の mediaBucket を実在する名前へ直してください`,
      );

      const url = serviceExists(config.projectId, config.region, config.serviceName);
      check('Cloud Run サービス', Boolean(url), url || '未作成（初回デプロイで作成されます）');

      /*
        動いているサービスが見ている保存先。
        設定ファイルを直してもデプロイし直すまで反映されないため、食い違いをここで見つける。
      */
      if (url) {
        const deployedBucket = run(
          'gcloud',
          [
            'run',
            'services',
            'describe',
            config.serviceName,
            '--project',
            config.projectId,
            '--region',
            config.region,
            '--format=value(spec.template.spec.containers[0].env.filter("name:MEDIA_BUCKET").extract("value").flatten())',
          ],
          { capture: true, quiet: true, allowFailure: true },
        );
        const deployed = deployedBucket.ok ? deployedBucket.stdout.trim() : '';
        check(
          '稼働中の MEDIA_BUCKET',
          deployed === config.mediaBucket,
          deployed === config.mediaBucket
            ? deployed
            : deployed.length === 0
              ? '未設定 — デプロイし直すと設定の mediaBucket が渡ります'
              : `設定 ${config.mediaBucket} と食い違っています（稼働中: ${deployed}）`,
        );
      }
    }
  }
}

// --- 結果表示 ----------------------------------------------------------------
console.log('');
let failures = 0;
for (const result of results) {
  const mark = result.ok ? color.green('✔') : color.yellow('▲');
  if (!result.ok) failures += 1;
  const detail = result.detail ?? '';
  if (detail.length <= 60) {
    console.log(`  ${mark} ${result.name.padEnd(30)} ${color.dim(detail)}`);
  } else {
    // 原因の説明が長い場合は折り返して読めるようにする。
    console.log(`  ${mark} ${result.name}`);
    console.log(`      ${color.dim(detail)}`);
  }
}

console.log('');
if (failures === 0) {
  console.log(`  ${color.green('デプロイできる状態です。')} → npm run deploy`);
} else {
  console.log(
    `  ${color.yellow(`${failures} 件の確認事項があります。`)} 上の ▲ を解消してください。`,
  );
  console.log(`  ${color.dim('詳細: docs/DEPLOYMENT.md')}`);
}
console.log('');

// 診断はデプロイを止めないので、常に 0 で終了する。
process.exit(0);
