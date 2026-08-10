#!/usr/bin/env node
/**
 * カスタムドメインの設定と確認。
 *
 *   npm run domain:map -- production          … 設定を作成／更新する
 *   npm run domain:status -- production       … 現在の状態と必要な DNS レコードを表示する
 *
 * 2 つの方式に対応する（deploy/cloud-run.<env>.json の "domainMode" で選ぶ）。
 *
 *   domain-mapping  (既定)
 *     Cloud Run のドメインマッピング。設定が簡単で追加費用がかからない。
 *     ただし対応リージョンが限られ、事前にドメイン所有権の確認が必要。
 *
 *   load-balancer
 *     グローバル外部アプリケーション ロードバランサ + サーバーレス NEG。
 *     すべてのリージョンで使え、Google マネージド証明書・Cloud CDN・Cloud Armor を併用できる。
 *     固定の IPv4 アドレスへ A レコードを向ける。月額の固定費がかかる。
 *
 * どちらの場合も、DNS レコードの登録は利用者が行う（このスクリプトは DNS を変更しない）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadDeployConfig, parseArgs, resolveEnvironment } from './lib/config.mjs';
import { ensureGcloud, ensureLoggedIn, ensureProjectAccessible } from './lib/gcloud.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { run } from './lib/proc.mjs';
import { confirmYesNo, isInteractive } from './lib/prompt.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));
const statusOnly = flags.has('status');
const autoYes = flags.has('yes') || process.env.CI === 'true';
const { environment } = resolveEnvironment(positional, flags);
const config = loadDeployConfig(environment);

if (!config.customDomain) {
  fatal(
    `deploy/cloud-run.${environment}.json に customDomain が設定されていません。`,
    [
      '例:',
      '  "customDomain": "quiz.example.jp",',
      '  "appBaseUrl": "https://quiz.example.jp",',
      '  "domainMode": "domain-mapping"   // または "load-balancer"',
      '',
      '詳細は docs/CUSTOM_DOMAIN.md を参照してください。',
    ].join('\n'),
  );
}

const domain = config.customDomain;
const slug = config.serviceName.replace(/[^a-z0-9-]/g, '-');

heading(`カスタムドメイン — ${domain} (${environment} / ${config.domainMode})`);

ensureGcloud();
ensureLoggedIn();
ensureProjectAccessible(config.projectId);

if (config.domainMode === 'load-balancer') {
  await loadBalancerFlow();
} else {
  await domainMappingFlow();
}

// ---------------------------------------------------------------------------
// 方式 1: Cloud Run ドメインマッピング
// ---------------------------------------------------------------------------
async function domainMappingFlow() {
  step('既存のドメインマッピングを確認');
  const describe = run(
    'gcloud',
    [
      'beta',
      'run',
      'domain-mappings',
      'describe',
      '--domain',
      domain,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--format=json',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );

  if (describe.ok) {
    success('ドメインマッピングは作成済みです。');
    printMappingStatus(describe.stdout);
    return;
  }

  if (statusOnly) {
    warn('ドメインマッピングはまだ作成されていません。');
    info(`作成するには: npm run domain:map -- ${environment}`);
    return;
  }

  step('ドメイン所有権の確認状況をチェック');
  const verified = run('gcloud', ['domains', 'list-user-verified', '--format=value(id)'], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  const verifiedDomains = verified.ok ? verified.stdout.split(/\r?\n/).filter(Boolean) : [];
  const apex = domain.split('.').slice(-2).join('.');
  const isVerified = verifiedDomains.some((d) => d === domain || d === apex);

  if (isVerified) {
    success(`所有権確認済みのドメインです: ${verifiedDomains.join(', ')}`);
  } else {
    warn('このアカウントで所有権が確認されたドメインが見つかりませんでした。');
    info('未確認の場合、次のコマンドで Search Console の確認フローを開けます:');
    info(`  gcloud domains verify ${apex}`);
    info('確認後、もう一度このコマンドを実行してください。');
    if (isInteractive() && !autoYes) {
      const proceed = await confirmYesNo('確認済みとして作成を試みますか？', false);
      if (!proceed) {
        return;
      }
    }
  }

  step('ドメインマッピングを作成');
  const created = run(
    'gcloud',
    [
      'beta',
      'run',
      'domain-mappings',
      'create',
      '--service',
      config.serviceName,
      '--domain',
      domain,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--format=json',
    ],
    { capture: true, allowFailure: true },
  );

  if (!created.ok) {
    const message = created.stderr ?? '';
    if (/not supported|not available|does not support/i.test(message)) {
      fatal(
        `リージョン ${config.region} ではドメインマッピングを利用できません。`,
        [
          'ロードバランサ方式へ切り替えてください:',
          `  deploy/cloud-run.${environment}.json の "domainMode" を "load-balancer" にする`,
          `  npm run domain:map -- ${environment}`,
          '',
          '詳細は docs/CUSTOM_DOMAIN.md を参照してください。',
        ].join('\n'),
      );
    }
    console.error(message);
    fatal('ドメインマッピングの作成に失敗しました。');
  }

  success('ドメインマッピングを作成しました。');
  printMappingStatus(created.stdout);
}

function printMappingStatus(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    info('（状態を JSON として解釈できませんでした）');
    return;
  }

  const records = parsed?.status?.resourceRecords ?? [];
  const conditions = parsed?.status?.conditions ?? [];

  heading('DNS レコードを登録してください');
  if (records.length === 0) {
    info('必要な DNS レコードがまだ払い出されていません。数分後に再確認してください:');
    info(`  npm run domain:status -- ${environment}`);
  } else {
    console.log('');
    console.log('  種別   名前                          値');
    console.log('  ----   --------------------------    -------------------------------');
    for (const record of records) {
      const name = record.name && record.name !== '' ? record.name : '@';
      console.log(
        `  ${String(record.type).padEnd(6)} ${String(name).padEnd(28)}  ${record.rrdata}`,
      );
    }
    console.log('');
    info('DNS 伝播と証明書の発行に最大数十分かかります。');
  }

  if (conditions.length > 0) {
    console.log('');
    info('現在の状態:');
    for (const condition of conditions) {
      const mark = condition.status === 'True' ? color.green('✔') : color.yellow('…');
      console.log(`    ${mark} ${condition.type}: ${condition.status} ${condition.message ?? ''}`);
    }
  }

  console.log('');
  info(`確認: curl -sS https://${domain}/api/health`);
}

// ---------------------------------------------------------------------------
// 方式 2: グローバル外部アプリケーション ロードバランサ
// ---------------------------------------------------------------------------
async function loadBalancerFlow() {
  const names = {
    neg: `${slug}-neg-${config.region}`,
    backend: `${slug}-backend`,
    urlMap: `${slug}-urlmap`,
    cert: `${slug}-cert`,
    httpsProxy: `${slug}-https-proxy`,
    httpProxy: `${slug}-http-proxy`,
    redirectMap: `${slug}-redirect`,
    address: `${slug}-ip`,
    httpsRule: `${slug}-https-rule`,
    httpRule: `${slug}-http-rule`,
  };

  if (statusOnly) {
    step('ロードバランサの状態');
    const ip = describeValue(
      ['compute', 'addresses', 'describe', names.address, '--global', '--format=value(address)'],
    );
    const certState = describeValue([
      'compute',
      'ssl-certificates',
      'describe',
      names.cert,
      '--global',
      '--format=value(managed.status)',
    ]);
    info(`固定 IP           : ${ip || '(未作成)'}`);
    info(`マネージド証明書  : ${certState || '(未作成)'}`);
    if (ip) {
      console.log('');
      console.log(`  DNS: ${domain} の A レコードを ${ip} へ向けてください。`);
      console.log('');
      info(`確認: curl -sS https://${domain}/api/health`);
    }
    return;
  }

  step('必要な API を有効化');
  run('gcloud', ['services', 'enable', 'compute.googleapis.com', '--project', config.projectId], {
    allowFailure: true,
  });

  step('サーバーレス NEG を作成');
  ensureResource(
    ['compute', 'network-endpoint-groups', 'describe', names.neg, '--region', config.region],
    [
      'compute',
      'network-endpoint-groups',
      'create',
      names.neg,
      '--region',
      config.region,
      '--network-endpoint-type',
      'serverless',
      '--cloud-run-service',
      config.serviceName,
    ],
    'サーバーレス NEG',
  );

  step('バックエンドサービスを作成');
  ensureResource(
    ['compute', 'backend-services', 'describe', names.backend, '--global'],
    [
      'compute',
      'backend-services',
      'create',
      names.backend,
      '--global',
      '--load-balancing-scheme',
      'EXTERNAL_MANAGED',
      '--protocol',
      'HTTPS',
    ],
    'バックエンドサービス',
  );

  const backends = describeValue([
    'compute',
    'backend-services',
    'describe',
    names.backend,
    '--global',
    '--format=value(backends[].group)',
  ]);
  if (!backends.includes(names.neg)) {
    run('gcloud', [
      'compute',
      'backend-services',
      'add-backend',
      names.backend,
      '--global',
      '--network-endpoint-group',
      names.neg,
      '--network-endpoint-group-region',
      config.region,
      '--project',
      config.projectId,
    ]);
    success('NEG をバックエンドへ追加しました');
  } else {
    success('NEG は既にバックエンドへ追加済みです');
  }

  step('URL マップを作成');
  ensureResource(
    ['compute', 'url-maps', 'describe', names.urlMap, '--global'],
    [
      'compute',
      'url-maps',
      'create',
      names.urlMap,
      '--default-service',
      names.backend,
      '--global',
    ],
    'URL マップ',
  );

  step('Google マネージド SSL 証明書を作成');
  ensureResource(
    ['compute', 'ssl-certificates', 'describe', names.cert, '--global'],
    ['compute', 'ssl-certificates', 'create', names.cert, '--domains', domain, '--global'],
    'マネージド証明書',
  );

  step('HTTPS プロキシを作成');
  ensureResource(
    ['compute', 'target-https-proxies', 'describe', names.httpsProxy, '--global'],
    [
      'compute',
      'target-https-proxies',
      'create',
      names.httpsProxy,
      '--url-map',
      names.urlMap,
      '--ssl-certificates',
      names.cert,
      '--global',
    ],
    'HTTPS プロキシ',
  );

  step('固定 IP アドレスを確保');
  ensureResource(
    ['compute', 'addresses', 'describe', names.address, '--global'],
    ['compute', 'addresses', 'create', names.address, '--global', '--ip-version', 'IPV4'],
    '固定 IP',
  );
  const ipAddress = describeValue([
    'compute',
    'addresses',
    'describe',
    names.address,
    '--global',
    '--format=value(address)',
  ]);

  step('転送ルールを作成 (HTTPS)');
  ensureResource(
    ['compute', 'forwarding-rules', 'describe', names.httpsRule, '--global'],
    [
      'compute',
      'forwarding-rules',
      'create',
      names.httpsRule,
      '--global',
      '--target-https-proxy',
      names.httpsProxy,
      '--address',
      names.address,
      '--ports',
      '443',
      '--load-balancing-scheme',
      'EXTERNAL_MANAGED',
    ],
    'HTTPS 転送ルール',
  );

  step('HTTP → HTTPS リダイレクトを作成');
  const redirectExists = describeOk(['compute', 'url-maps', 'describe', names.redirectMap, '--global']);
  if (!redirectExists) {
    // リダイレクト用 URL マップは YAML インポートが必要なため一時ファイルを使う。
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'smileq-lb-'));
    const yamlPath = join(dir, 'redirect.yaml');
    writeFileSync(
      yamlPath,
      [
        `name: ${names.redirectMap}`,
        'defaultUrlRedirect:',
        '  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT',
        '  httpsRedirect: true',
        '  stripQuery: false',
        '',
      ].join('\n'),
      'utf8',
    );
    run('gcloud', [
      'compute',
      'url-maps',
      'import',
      names.redirectMap,
      '--source',
      yamlPath,
      '--global',
      '--quiet',
      '--project',
      config.projectId,
    ]);
    try {
      unlinkSync(yamlPath);
    } catch {
      /* 一時ファイルの削除失敗は無視 */
    }
    success('リダイレクト用 URL マップを作成しました');
  } else {
    success('リダイレクト用 URL マップは作成済みです');
  }

  ensureResource(
    ['compute', 'target-http-proxies', 'describe', names.httpProxy, '--global'],
    [
      'compute',
      'target-http-proxies',
      'create',
      names.httpProxy,
      '--url-map',
      names.redirectMap,
      '--global',
    ],
    'HTTP プロキシ',
  );

  ensureResource(
    ['compute', 'forwarding-rules', 'describe', names.httpRule, '--global'],
    [
      'compute',
      'forwarding-rules',
      'create',
      names.httpRule,
      '--global',
      '--target-http-proxy',
      names.httpProxy,
      '--address',
      names.address,
      '--ports',
      '80',
      '--load-balancing-scheme',
      'EXTERNAL_MANAGED',
    ],
    'HTTP 転送ルール',
  );

  heading('DNS レコードを登録してください');
  console.log('');
  console.log('  種別   名前                          値');
  console.log('  ----   --------------------------    -------------------------------');
  console.log(`  A      ${domain.padEnd(28)}  ${ipAddress}`);
  console.log('');
  info('DNS を登録すると Google マネージド証明書が自動発行されます（最大 60 分程度）。');
  info(`状態確認: npm run domain:status -- ${environment}`);
  console.log('');
  info(`確認: curl -sS https://${domain}/api/health`);
  console.log('');
  warn(
    'ロードバランサ経由になるため、Cloud Run の既定 URL への直接アクセスを制限したい場合は ' +
      'Cloud Run の ingress を internal-and-cloud-load-balancing へ変更してください。',
  );

  function ensureResource(describeArgs, createArgs, label) {
    if (describeOk(describeArgs)) {
      success(`${label}は作成済みです`);
      return;
    }
    run('gcloud', [...createArgs, '--project', config.projectId]);
    success(`${label}を作成しました`);
  }

  function describeOk(args) {
    return run('gcloud', [...args, '--project', config.projectId], {
      capture: true,
      quiet: true,
      allowFailure: true,
    }).ok;
  }
}

function describeValue(args) {
  const result = run('gcloud', [...args, '--project', config.projectId], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  return result.ok ? result.stdout.trim() : '';
}
