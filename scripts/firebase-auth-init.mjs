#!/usr/bin/env node
/**
 * Firebase Authentication をプロジェクトで使える状態にする。
 *
 *   npm run firebase:auth                      … 設定ファイルからプロジェクトを判定
 *   npm run firebase:auth -- --project my-proj … プロジェクトを指定
 *   npm run firebase:auth -- --check           … 変更せず状態だけ表示
 *
 * identitytoolkit.googleapis.com を有効化しただけでは Auth は使えない。
 * プロジェクトごとの初期化が別に要る。未初期化のまま Admin SDK を呼ぶと
 *   There is no configuration corresponding to the provided identifier.
 * という、原因の見当がつかないエラーになる（npm run host:add で発生する）。
 *
 * ここで自動化するもの:
 *   * Identity Platform の初期化
 *   * 匿名認証の有効化（参加者はニックネームのみで参加するため必須）
 *   * 承認済みドメインへ公開 URL を追加（Google ログインに必要）
 *
 * 自動化しないもの:
 *   * Google プロバイダの有効化
 *     OAuth クライアントの作成を伴うため、コンソールでの操作が要る（URL を表示する）。
 *
 * 認証は gcloud のアクセストークンを使う（サーバー用の秘密鍵は作らない）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { configExists, ENVIRONMENTS, parseArgs, resolveEnvironment } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { commandExists, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));
const checkOnly = flags.has('check');

// ---------------------------------------------------------------------------
// 対象の決定
// ---------------------------------------------------------------------------
function loadConfigFile() {
  const target =
    positional.find((value) => ENVIRONMENTS.includes(value)) ??
    (ENVIRONMENTS.filter(configExists).length === 1
      ? ENVIRONMENTS.filter(configExists)[0]
      : resolveEnvironment(positional, flags).environment);
  const path = new URL(`../deploy/cloud-run.${target}.json`, import.meta.url);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const config = loadConfigFile();
const projectId =
  (typeof flags.get('project') === 'string' ? flags.get('project') : '') ||
  process.env.FIREBASE_PROJECT_ID ||
  config?.firebaseProjectId ||
  config?.projectId ||
  '';

if (!projectId) {
  fatal(
    'プロジェクト ID を特定できません。',
    '--project で指定するか、deploy/cloud-run.<env>.json を先に用意してください。',
  );
}

heading(`Firebase Authentication の初期化 — ${projectId}`);

// ---------------------------------------------------------------------------
// アクセストークン
// ---------------------------------------------------------------------------
if (!commandExists('gcloud')) {
  fatal(
    'gcloud が必要です。',
    'https://cloud.google.com/sdk/docs/install からインストールし、gcloud auth login を実行してください。',
  );
}

const tokenResult = run('gcloud', ['auth', 'print-access-token'], {
  capture: true,
  quiet: true,
  allowFailure: true,
});
if (!tokenResult.ok || !tokenResult.stdout.trim()) {
  fatal(
    'gcloud のアクセストークンを取得できません。',
    'gcloud auth login を実行してください。',
  );
}
const accessToken = tokenResult.stdout.trim();

/**
 * Identity Toolkit の管理 API を叩く。
 *
 * 失敗しても投げずに返す。呼び出し側で「未初期化」と「本当のエラー」を分けるため。
 */
async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Goog-User-Project': projectId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // JSON でなければ生のまま扱う。
  }
  return { ok: response.ok, status: response.status, json, text };
}

/** テストで差し替えるためだけの入口。通常は本番エンドポイントを使う。 */
const API_HOST = process.env.SMILEQ_IDENTITY_HOST ?? 'https://identitytoolkit.googleapis.com';
const ADMIN = `${API_HOST}/admin/v2/projects/${projectId}`;

function reportApiError(label, result) {
  const message = result.json?.error?.message ?? result.text?.slice(0, 300) ?? '';
  warn(`${label}（HTTP ${result.status}）`);
  if (message) {
    info(`  ${message}`);
  }
}

// ---------------------------------------------------------------------------
step('Authentication の状態を確認');

let current = await api('GET', `${ADMIN}/config`);
let initialized = current.ok;

if (initialized) {
  success('Authentication は初期化済みです');
} else if (current.status === 404 || /CONFIGURATION_NOT_FOUND/i.test(current.text ?? '')) {
  warn('Authentication がまだ初期化されていません。');

  if (checkOnly) {
    info('--check のため変更しません。');
  } else {
    step('Authentication を初期化');
    const init = await api(
      'POST',
      `${API_HOST}/v2/projects/${projectId}/identityPlatform:initializeAuth`,
      {},
    );
    if (init.ok) {
      success('初期化しました');
      current = await api('GET', `${ADMIN}/config`);
      initialized = current.ok;
    } else {
      reportApiError('初期化に失敗しました', init);
      console.log('');
      info('コンソールから 1 回の操作で有効化できます:');
      info(`  https://console.firebase.google.com/project/${projectId}/authentication`);
      info('  「始める」を押すだけです。そのあとこのコマンドを再実行してください。');
      console.log('');
      process.exit(1);
    }
  }
} else {
  reportApiError('Authentication の状態を取得できませんでした', current);
  console.log('');
  info('権限を確認してください（必要なロール: roles/firebase.admin もしくはオーナー）。');
  info(`  https://console.firebase.google.com/project/${projectId}/authentication`);
  console.log('');
  process.exit(1);
}

if (!initialized) {
  process.exit(checkOnly ? 0 : 1);
}

// ---------------------------------------------------------------------------
step('匿名認証');

// 参加者は二次元コードから入り、ニックネームだけで回答する。
// 端末を跨がない一時的な識別に匿名認証を使うため、これが無いと参加できない。
const anonymousEnabled = current.json?.signIn?.anonymous?.enabled === true;
if (anonymousEnabled) {
  success('有効です');
} else if (checkOnly) {
  warn('無効です（--check のため変更しません）');
} else {
  const patched = await api(
    'PATCH',
    `${ADMIN}/config?updateMask=signIn.anonymous.enabled`,
    { signIn: { anonymous: { enabled: true } } },
  );
  if (patched.ok) {
    success('有効にしました');
    current = patched;
  } else {
    reportApiError('匿名認証を有効にできませんでした', patched);
    info(`  コンソール: https://console.firebase.google.com/project/${projectId}/authentication/providers`);
  }
}

// ---------------------------------------------------------------------------
step('承認済みドメイン');

// Google ログインは、ここに載っていないドメインからは実行できない。
// カスタムドメインを追加し忘れると、デプロイ後に司会者がログインできない。
const desired = new Set(['localhost']);
for (const value of [config?.customDomain, config?.appBaseUrl]) {
  if (!value) continue;
  try {
    desired.add(new URL(value.includes('://') ? value : `https://${value}`).hostname);
  } catch {
    // 形式が不正なものは足さない。
  }
}

// Cloud Run の既定 URL も追加する（カスタムドメイン切り替え前の確認に使うため）。
if (config?.projectId && config?.region && config?.serviceName) {
  const url = run(
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
      '--format=value(status.url)',
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (url.ok && url.stdout.trim()) {
    try {
      desired.add(new URL(url.stdout.trim()).hostname);
    } catch {
      // 取得できなければ足さない。
    }
  }
}

const existingDomains = Array.isArray(current.json?.authorizedDomains)
  ? current.json.authorizedDomains
  : [];
const missingDomains = [...desired].filter((domain) => !existingDomains.includes(domain));

if (missingDomains.length === 0) {
  success(`設定済み: ${existingDomains.join(', ') || '(なし)'}`);
} else if (checkOnly) {
  warn(`追加が必要: ${missingDomains.join(', ')}（--check のため変更しません）`);
} else {
  // 既存のドメインを消さないよう、必ず結合してから送る。
  const merged = [...new Set([...existingDomains, ...missingDomains])];
  const patched = await api('PATCH', `${ADMIN}/config?updateMask=authorizedDomains`, {
    authorizedDomains: merged,
  });
  if (patched.ok) {
    success(`追加しました: ${missingDomains.join(', ')}`);
    current = patched;
  } else {
    reportApiError('承認済みドメインを更新できませんでした', patched);
    info(`  コンソール: https://console.firebase.google.com/project/${projectId}/authentication/settings`);
  }
}

// ---------------------------------------------------------------------------
step('Google プロバイダ');

const idps = await api('GET', `${ADMIN}/defaultSupportedIdpConfigs`);
const google = Array.isArray(idps.json?.defaultSupportedIdpConfigs)
  ? idps.json.defaultSupportedIdpConfigs.find((item) => String(item.name ?? '').endsWith('google.com'))
  : null;

if (google?.enabled) {
  success('有効です');
} else {
  warn('無効です。司会者はログインできません。');
  console.log('');
  info('ここだけはコンソールでの操作が必要です（OAuth クライアントの作成を伴うため）:');
  console.log(
    `  ${color.bold(`https://console.firebase.google.com/project/${projectId}/authentication/providers`)}`,
  );
  info('  「Google」を選び、有効にして保存してください。');
  console.log('');
}

// ---------------------------------------------------------------------------
heading('次の手順');
if (google?.enabled) {
  console.log('  1. 司会者本人に一度ログインしてもらう:');
  console.log(`       ${config?.appBaseUrl ?? ''}/admin/login`);
  console.log('     （この時点では「管理権限がありません」と表示されます。それで正常です）');
  console.log('  2. 司会者として登録:');
  console.log('       npm run host:add -- you@example.com --name "あなたの名前"');
} else {
  console.log('  1. 上の URL で Google プロバイダを有効にする');
  console.log('  2. 司会者本人に一度ログインしてもらう');
  console.log('  3. npm run host:add -- you@example.com --name "あなたの名前"');
}
console.log('');
info('詳細: docs/FIREBASE_SETUP.md / docs/HOST_ACCESS.md');
console.log('');
