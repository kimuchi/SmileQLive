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
import {
  activeAccount,
  secretExists,
  secretHasVersion,
  serviceExists,
} from './lib/gcloud.mjs';
import { color, heading, info } from './lib/log.mjs';
import { commandExists, run } from './lib/proc.mjs';

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
check('gcloud CLI', commandExists('gcloud'), commandExists('gcloud') ? '' : 'https://cloud.google.com/sdk/docs/install');
check('Git', commandExists('git'), '');
check(
  'pnpm-lock.yaml',
  existsSync(new URL('../pnpm-lock.yaml', import.meta.url)),
  'ロックファイルはコミットしてください',
);
check(
  'Dockerfile',
  existsSync(new URL('../Dockerfile', import.meta.url)),
  'Cloud Build がこの Dockerfile を使います',
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

  check('supabaseUrl', /^https:\/\/.+\.supabase\.co$/.test(config.supabaseUrl), config.supabaseUrl);
  check(
    'Publishable Key が公開用キーであること',
    !config.supabasePublishableKey.startsWith('sb_secret') &&
      !config.supabasePublishableKey.startsWith('service_role'),
    'Secret Key を JSON へ書かないでください',
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
  check(
    '本番の最小インスタンス',
    config.environment !== 'production' || config.minInstances >= 1,
    `minInstances=${config.minInstances}（会場開催時は 1 以上を推奨）`,
  );
}

// --- Google Cloud ------------------------------------------------------------
if (config && commandExists('gcloud')) {
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
      check(
        'Secret が存在する',
        secretExists(config.projectId, config.supabaseSecretName),
        config.supabaseSecretName,
      );
      check(
        'Secret に値がある',
        secretHasVersion(config.projectId, config.supabaseSecretName),
        'gcloud secrets versions add ... で登録してください',
      );
      const url = serviceExists(config.projectId, config.region, config.serviceName);
      check('Cloud Run サービス', Boolean(url), url || '未作成（初回デプロイで作成されます）');
    }
  }
}

// --- 結果表示 ----------------------------------------------------------------
console.log('');
let failures = 0;
for (const result of results) {
  const mark = result.ok ? color.green('✔') : color.yellow('▲');
  if (!result.ok) failures += 1;
  console.log(`  ${mark} ${result.name.padEnd(32)} ${color.dim(result.detail ?? '')}`);
}

console.log('');
if (failures === 0) {
  console.log(`  ${color.green('デプロイできる状態です。')} → npm run deploy`);
} else {
  console.log(`  ${color.yellow(`${failures} 件の確認事項があります。`)} 上の ▲ を解消してください。`);
  console.log(`  ${color.dim('詳細: docs/DEPLOYMENT.md')}`);
}
console.log('');

// 診断はデプロイを止めないので、常に 0 で終了する。
process.exit(0);
