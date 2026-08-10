#!/usr/bin/env node
/**
 * SmileQ Live — Cloud Run デプロイスクリプト
 *
 *   npm run deploy                 … 設定ファイルから対象を自動判定（両方あれば production）
 *   npm run deploy -- staging      … ステージングへ
 *   npm run deploy -- production   … 本番へ
 *   pnpm deploy:staging / pnpm deploy:production も同じ処理を呼ぶ
 *
 * オプション:
 *   --yes           確認プロンプトを省略（CI 用）
 *   --skip-verify   lint/typecheck/test/build を省略（非推奨）
 *   --skip-domain   カスタムドメインの確認を省略
 *   --dry-run       実行せずコマンドだけ表示
 *   --no-traffic    トラフィックを移さずリビジョンだけ作成
 *
 * Windows / macOS / Linux で同じ手順で動く（Bash / PowerShell へ依存しない）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { execSync } from 'node:child_process';
import {
  buildRuntimeEnv,
  loadDeployConfig,
  parseArgs,
  resolveEnvironment,
  toGcloudDict,
} from './lib/config.mjs';
import {
  ensureGcloud,
  ensureLoggedIn,
  ensureProjectAccessible,
  runWithOptionalFlags,
  secretExists,
  secretHasVersion,
  serviceExists,
  serviceUrl,
} from './lib/gcloud.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { run, runPackageScript } from './lib/proc.mjs';
import { confirmExact, isInteractive } from './lib/prompt.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const { positional, flags } = parseArgs(process.argv.slice(2));
const skipConfirm = flags.has('yes') || flags.has('y') || process.env.CI === 'true';
const skipVerify = flags.has('skip-verify');
const skipDomain = flags.has('skip-domain');
const dryRun = flags.has('dry-run');
const noTraffic = flags.has('no-traffic');

const { environment, inferred } = resolveEnvironment(positional, flags);
const config = loadDeployConfig(environment);

heading(`SmileQ Live デプロイ — ${environment}`);
if (inferred) {
  info(
    color.dim(
      `対象を自動判定しました。明示するには: npm run deploy -- ${environment === 'production' ? 'staging' : 'production'}`,
    ),
  );
}
info(`プロジェクト : ${config.projectId}`);
info(`リージョン   : ${config.region}`);
info(`サービス     : ${config.serviceName}`);
info(`公開URL      : ${config.appBaseUrl || '(Cloud Run の既定 URL を使用)'}`);
if (config.customDomain) {
  info(`カスタムドメイン: ${config.customDomain} (${config.domainMode})`);
}

// ---------------------------------------------------------------------------
step('前提コマンドと認証を確認');
ensureGcloud();
const account = ensureLoggedIn();
success(`gcloud アカウント: ${account}`);
ensureProjectAccessible(config.projectId);
success(`プロジェクトへアクセスできます: ${config.projectId}`);

// ---------------------------------------------------------------------------
step('Git の状態を確認');
const git = gitInfo();
if (git) {
  info(`ブランチ: ${git.branch} / コミット: ${git.commit.slice(0, 8)}`);
  if (environment === 'production') {
    if (config.requireCleanTree && git.dirty) {
      fatal(
        '作業ツリーに未コミットの変更があります。',
        '本番デプロイ前にコミットまたは stash してください。\n' +
          '（この確認を無効にするには設定へ "requireCleanTree": false を追加）',
      );
    }
    if (config.allowedBranches.length > 0 && !config.allowedBranches.includes(git.branch)) {
      fatal(
        `本番デプロイが許可されていないブランチです: ${git.branch}`,
        `許可ブランチ: ${config.allowedBranches.join(', ')}\n` +
          '（設定の "allowedBranches" で変更できます）',
      );
    }
    success('本番デプロイの Git 条件を満たしています');
  }
} else {
  warn('Git リポジトリではないため、ブランチ・作業ツリーの確認を省略しました。');
}

// ---------------------------------------------------------------------------
step('Secret Manager を確認');
if (!secretExists(config.projectId, config.supabaseSecretName)) {
  fatal(
    `Secret が存在しません: ${config.supabaseSecretName}`,
    [
      '先に初期設定を実行してください:',
      `  npm run gcp:bootstrap -- ${environment}`,
      '',
      'その後、Supabase の Secret Key を登録してください（値はリポジトリへ書かないこと）:',
      `  gcloud secrets versions add ${config.supabaseSecretName} --project ${config.projectId} --data-file=-`,
    ].join('\n'),
  );
}
if (!secretHasVersion(config.projectId, config.supabaseSecretName)) {
  fatal(
    `Secret に値が登録されていません: ${config.supabaseSecretName}`,
    [
      'Supabase のサーバー専用 Secret Key を登録してください:',
      `  gcloud secrets versions add ${config.supabaseSecretName} --project ${config.projectId} --data-file=-`,
      '（実行後、値を貼り付けて Ctrl+D / Windows は Ctrl+Z Enter）',
    ].join('\n'),
  );
}
success(`Secret を確認しました: ${config.supabaseSecretName}`);

// ---------------------------------------------------------------------------
step('デプロイ前チェック (lint / typecheck / test / build)');
if (skipVerify || !config.runVerifyBeforeDeploy) {
  warn('検証をスキップしました (--skip-verify)。本番では推奨されません。');
} else if (dryRun) {
  info('dry-run のため検証をスキップします。');
} else {
  runPackageScript('verify');
  success('すべての検証に成功しました');
}

// ---------------------------------------------------------------------------
step('デプロイ内容の最終確認');
const existingUrl = serviceExists(config.projectId, config.region, config.serviceName);
if (existingUrl) {
  info(`既存サービスを更新します: ${existingUrl}`);
} else {
  info('新規サービスを作成します。');
}

if (environment === 'production' && !skipConfirm) {
  if (!isInteractive()) {
    fatal(
      '本番デプロイには確認が必要です。',
      '非対話環境（CI など）から実行する場合は --yes を付けてください:\n' +
        '  npm run deploy -- production --yes',
    );
  }
  const confirmed = await confirmExact(
    `\n  本番環境 (${config.projectId} / ${config.serviceName}) へデプロイします。`,
    'production',
  );
  if (!confirmed) {
    fatal('確認できなかったため中止しました。');
  }
  success('確認しました');
}

// ---------------------------------------------------------------------------
step('Cloud Run へデプロイ');

// APP_BASE_URL は「カスタムドメイン → 設定値 → 既存サービス URL」の順で決める。
const resolvedAppBaseUrl = config.appBaseUrl || existingUrl || '';
const runtimeEnv = buildRuntimeEnv(config, resolvedAppBaseUrl);

const secrets = { SUPABASE_SECRET_KEY: `${config.supabaseSecretName}:latest` };
if (config.turnstileSecretName) {
  secrets.TURNSTILE_SECRET_KEY = `${config.turnstileSecretName}:latest`;
}

const baseArgs = [
  'run',
  'deploy',
  config.serviceName,
  '--project',
  config.projectId,
  '--region',
  config.region,
  '--platform',
  'managed',
  '--execution-environment',
  'gen2',
  '--source',
  '.',
  '--allow-unauthenticated',
  '--ingress',
  config.ingress,
  '--service-account',
  config.serviceAccount,
  '--port',
  '8080',
  '--cpu',
  String(config.cpu),
  '--memory',
  String(config.memory),
  '--concurrency',
  String(config.concurrency),
  '--min-instances',
  String(config.minInstances),
  '--max-instances',
  String(config.maxInstances),
  '--timeout',
  String(config.timeout),
  '--set-env-vars',
  toGcloudDict(runtimeEnv),
  '--set-secrets',
  toGcloudDict(secrets),
  '--labels',
  `app=smileq-live,env=${environment}`,
];

if (noTraffic) {
  baseArgs.push('--no-traffic');
}

// gcloud のバージョン差で未対応の可能性があるフラグは分離しておく。
const optionalArgs = [];
if (config.optionalFlags.cpuBoost) {
  optionalArgs.push('--cpu-boost');
}
if (config.optionalFlags.startupProbe) {
  optionalArgs.push(
    '--startup-probe',
    'httpGet.path=/api/health,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=5,failureThreshold=12',
  );
}

if (dryRun) {
  info(color.dim('dry-run: 次のコマンドを実行します'));
  console.log(`\n  gcloud ${[...baseArgs, ...optionalArgs].join(' ')}\n`);
} else {
  runWithOptionalFlags(baseArgs, optionalArgs, { secrets: [config.supabasePublishableKey] });
  success('デプロイが完了しました');
}

// ---------------------------------------------------------------------------
step('公開 URL を確定');
let finalUrl = config.appBaseUrl;

if (!dryRun) {
  const deployedUrl = serviceUrl(config.projectId, config.region, config.serviceName);
  info(`Cloud Run URL: ${deployedUrl}`);

  if (!config.appBaseUrl) {
    // カスタムドメインを使わない場合は、Cloud Run が払い出した URL を APP_BASE_URL にする。
    run('gcloud', [
      'run',
      'services',
      'update',
      config.serviceName,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--update-env-vars',
      `APP_BASE_URL=${deployedUrl}`,
    ]);
    finalUrl = deployedUrl;
    success(`APP_BASE_URL を ${deployedUrl} に設定しました`);
  } else {
    finalUrl = config.appBaseUrl;
  }
}

// ---------------------------------------------------------------------------
if (config.customDomain && !skipDomain && !dryRun) {
  step('カスタムドメインの状態を確認');
  const mapped = run(
    'gcloud',
    [
      'beta',
      'run',
      'domain-mappings',
      'describe',
      '--domain',
      config.customDomain,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--format=value(status.conditions[0].status)',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );

  if (config.domainMode === 'load-balancer') {
    info('domainMode が load-balancer のため、ドメインマッピングは確認しません。');
    info('ロードバランサの状態確認: npm run domain:status');
  } else if (mapped.ok) {
    success(`ドメインマッピングは構成済みです: ${config.customDomain}`);
  } else {
    warn(`${config.customDomain} のドメインマッピングがまだありません。`);
    info('次のコマンドで作成し、表示される DNS レコードを登録してください:');
    info(`  npm run domain:map -- ${environment}`);
    info('詳細は docs/CUSTOM_DOMAIN.md を参照してください。');
  }
}

// ---------------------------------------------------------------------------
if (!dryRun) {
  step('ヘルスチェック');
  const healthBase = finalUrl || serviceUrl(config.projectId, config.region, config.serviceName);
  const ok = await checkHealth(`${healthBase}/api/health`);
  if (ok) {
    success(`/api/health が正常に応答しました`);
  } else {
    warn(
      'ヘルスチェックに応答がありませんでした。カスタムドメインの DNS 反映待ちの可能性があります。',
    );
    const cloudRunUrl = serviceUrl(config.projectId, config.region, config.serviceName);
    if (cloudRunUrl && cloudRunUrl !== healthBase) {
      const fallbackOk = await checkHealth(`${cloudRunUrl}/api/health`);
      if (fallbackOk) {
        success(`Cloud Run 既定 URL では正常です: ${cloudRunUrl}/api/health`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
heading('完了');
console.log(`  環境        : ${environment}`);
console.log(`  サービス    : ${config.serviceName} (${config.region})`);
console.log(`  公開 URL    : ${finalUrl || '(未確定)'}`);
console.log(`  ヘルス      : ${(finalUrl || '') + '/api/health'}`);
console.log(`  管理画面    : ${(finalUrl || '') + '/admin/login'}`);
console.log(`  ログ        : gcloud run services logs tail ${config.serviceName} --project ${config.projectId} --region ${config.region}`);
console.log('');
console.log(color.dim('  Supabase Auth の Redirect URL に上記ドメインが登録されているか確認してください。'));
console.log('');

// ---------------------------------------------------------------------------

function gitInfo() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const commit = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { branch, commit, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

async function checkHealth(url, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.status === 'ok') {
          return true;
        }
      }
    } catch {
      // 起動直後や DNS 反映待ちは失敗しうるのでリトライする。
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return false;
}
