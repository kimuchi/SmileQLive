#!/usr/bin/env node
/**
 * Firebase が使える状態かを切り分ける診断。
 *
 *   npm run firebase:doctor -- --project idl-application
 *
 * 変更は一切行わない。「なぜ Firebase が使えないのか」を特定するためだけに使う。
 *
 * よくある誤解:
 *   「このプロジェクトでは既に Firestore を使っているのに Firebase が使えない」
 *   → Firestore は Google Cloud の製品としても単体で使える。
 *      サービスアカウントに roles/datastore.user を与えて API を叩く使い方では、
 *      **Firebase をプロジェクトへ追加していなくても動く**。
 *      Firebase（Auth / Web SDK 設定 / Rules 配信）はその上の層で、別途追加が要る。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliJson } from './lib/cli-json.mjs';
import { classifyApiError, extractApiError, readDebugLogTail } from './lib/firebase-debug.mjs';
import { configExists, ENVIRONMENTS, parseArgs } from './lib/config.mjs';
import { color, heading, info, step, warn } from './lib/log.mjs';
import { commandExists, detectPackageManager, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));

function resolveProjectId() {
  const explicit =
    (typeof flags.get('project') === 'string' ? flags.get('project') : '') ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT;
  if (explicit) {
    return explicit;
  }
  const target =
    positional.find((value) => ENVIRONMENTS.includes(value)) ??
    ENVIRONMENTS.filter(configExists)[0];
  if (target) {
    const path = new URL(`../deploy/cloud-run.${target}.json`, import.meta.url);
    if (existsSync(path)) {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      return config.firebaseProjectId ?? config.projectId ?? '';
    }
  }
  return '';
}

const projectId = resolveProjectId();
if (!projectId) {
  warn('プロジェクト ID を特定できません。--project で指定してください。');
  process.exit(0);
}

heading(`Firebase 診断 — ${projectId}`);

const hasGcloud = commandExists('gcloud');
const hasFirebaseCli = commandExists('firebase');
const packageManager = detectPackageManager();
const fb = hasFirebaseCli
  ? { bin: 'firebase', prefix: [] }
  : packageManager === 'pnpm'
    ? { bin: 'pnpm', prefix: ['dlx', 'firebase-tools@15'] }
    : { bin: 'npx', prefix: ['--yes', 'firebase-tools@15'] };

// firebase CLI はリポジトリ直下だと firebase.json を読み込む。
// 診断は配信設定と無関係なので、見えない一時ディレクトリで実行する
// （デバッグログもここへ集まるので、失敗理由を読み取りやすい）。
const cliCwd = mkdtempSync(join(tmpdir(), 'smileq-doctor-'));
process.on('exit', () => {
  rmSync(cliCwd, { recursive: true, force: true });
});

const findings = [];
function record(ok, label, detail) {
  findings.push({ ok, label, detail });
  const mark = ok ? color.green('✔') : color.yellow('▲');
  console.log(`    ${mark} ${label}`);
  if (detail) {
    console.log(`        ${color.dim(detail)}`);
  }
}

// ---------------------------------------------------------------------------
step('1. Google Cloud プロジェクトの存在');
if (hasGcloud) {
  const describe = run(
    'gcloud',
    ['projects', 'describe', projectId, '--format=value(projectNumber,lifecycleState)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (describe.ok) {
    const [number, state] = describe.stdout.split(/\s+/);
    record(state === 'ACTIVE', `プロジェクトは ${state ?? '不明'}`, `プロジェクト番号: ${number}`);
  } else {
    record(false, 'プロジェクトへアクセスできません', describe.stderr.split('\n')[0] ?? '');
  }
} else {
  warn('gcloud が無いため一部の確認を省略します。');
}

// ---------------------------------------------------------------------------
step('2. 必要な API の有効化');
if (hasGcloud) {
  const enabled = run(
    'gcloud',
    ['services', 'list', '--enabled', `--project=${projectId}`, '--format=value(config.name)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  const list = enabled.ok ? enabled.stdout.split(/\r?\n/) : [];
  const required = [
    ['firebase.googleapis.com', 'Firebase Management（addFirebase に必須）'],
    ['identitytoolkit.googleapis.com', 'Firebase Authentication'],
    ['firestore.googleapis.com', 'Firestore'],
    ['firebaserules.googleapis.com', 'Security Rules の配信'],
    ['firebasestorage.googleapis.com', 'Cloud Storage for Firebase'],
    ['apikeys.googleapis.com', 'API キー（Web アプリ登録時にブラウザ用キーを作る）'],
  ];
  for (const [api, purpose] of required) {
    const on = list.includes(api);
    record(on, `${api}`, on ? purpose : `未有効 — gcloud services enable ${api} --project ${projectId}`);
  }
}

// ---------------------------------------------------------------------------
step('3. Firestore の状態（既存アプリとの関係）');
if (hasGcloud) {
  const databases = run(
    'gcloud',
    ['firestore', 'databases', 'list', `--project=${projectId}`, '--format=value(name,type,locationId)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (databases.ok && databases.stdout.trim()) {
    console.log('');
    console.log('        既存のデータベース:');
    for (const line of databases.stdout.split(/\r?\n/).filter(Boolean)) {
      console.log(`          ${line}`);
    }
    console.log('');
    info('Firestore が既にあっても、それは「Firebase が追加済み」を意味しません。');
    info('Firestore は Google Cloud の製品として単体で使えます');
    info('（サービスアカウント + roles/datastore.user だけで動く使い方）。');
  } else {
    record(false, 'Firestore データベースが見つかりません', 'まだ作成されていない可能性があります');
  }
}

// ---------------------------------------------------------------------------
step('4. Firebase として認識されているか');
const projectsList = run(fb.bin, [...fb.prefix, 'projects:list', '--json'], {
  capture: true,
  quiet: true,
  allowFailure: true,
  cwd: cliCwd,
});
let isFirebaseProject = false;
if (projectsList.ok) {
  try {
    const parsed = JSON.parse(projectsList.stdout);
    const projects = parsed.result ?? [];
    isFirebaseProject = projects.some((item) => item.projectId === projectId);
    record(
      isFirebaseProject,
      isFirebaseProject ? 'Firebase プロジェクトとして登録済み' : 'Firebase が未追加',
      isFirebaseProject
        ? ''
        : `firebase projects:list に ${projectId} が出てきません（一覧には ${projects.length} 件）`,
    );
  } catch {
    record(false, 'projects:list の結果を解釈できませんでした', '');
  }
} else {
  record(false, 'projects:list を実行できませんでした', 'firebase login を確認してください');
}

// ---------------------------------------------------------------------------
step('5. Web アプリ API が使えるか');

// 公開設定の取得はここで失敗することが多い。実際に叩いて切り分ける。
// projects:list が通っても webApps だけ 403 になる構成があるため、別項目にする。
{
  const appsResult = run(fb.bin, [...fb.prefix, 'apps:list', 'WEB', '--project', projectId, '--json'], {
    capture: true,
    quiet: true,
    allowFailure: true,
    cwd: cliCwd,
  });
  const parsed = cliJson(appsResult);
  if (parsed.ok) {
    const apps = Array.isArray(parsed.result) ? parsed.result : [];
    record(true, `Web アプリ一覧を取得できます（${apps.length} 件）`, '');
    for (const app of apps) {
      console.log(`          ${app.appId}  ${color.dim(app.displayName ?? '')}`);
    }
    if (apps.length > 0) {
      info('appId を直接指定して設定を取得できます:');
      info(`  npm run firebase:config -- --project=${projectId} --app-id=${apps[0].appId}`);
    }
  } else {
    const apiError = extractApiError(readDebugLogTail([cliCwd]));
    const kind = classifyApiError(`${parsed.message}\n${apiError.text}`);
    const cause = kind.serviceDisabled
      ? 'API が無効 — gcloud services enable apikeys.googleapis.com firebase.googleapis.com'
      : kind.insufficientScopes
        ? `ログインのスコープ不足 — ${fb.bin} ${[...fb.prefix, 'login', '--reauth'].join(' ')}`
        : kind.permissionDenied
          ? '403 — apikeys.googleapis.com の有効化 / ログインの再取得 / roles/firebase.developAdmin を確認'
          : parsed.message || '原因を特定できませんでした';
    record(false, 'Web アプリ一覧を取得できません', cause);
    if (apiError.body) {
      console.log(`        ${color.dim(apiError.body)}`);
    }
    info('Web アプリが使えなくても、gcloud の API キーで公開設定は取得できます。');
    info('  npm run firebase:config   … 自動で代替経路へ切り替わります');
  }
}

// ---------------------------------------------------------------------------
step('6. Firebase 利用規約への同意');
if (!isFirebaseProject) {
  const otherProjects = (() => {
    try {
      return (JSON.parse(projectsList.stdout).result ?? []).length;
    } catch {
      return 0;
    }
  })();

  if (otherProjects > 0) {
    record(
      true,
      `この アカウントは他に ${otherProjects} 件の Firebase プロジェクトを持っています`,
      '規約同意は済んでいる可能性が高いです',
    );
  } else {
    record(
      false,
      'このアカウントで Firebase プロジェクトを 1 件も持っていません',
      '規約未同意の可能性が高い — https://console.firebase.google.com/ を一度開いてください',
    );
  }
}

// ---------------------------------------------------------------------------
step('7. 組織ポリシー（プロジェクト単位 + 組織単位）');

/** Firebase の追加を妨げうる制約。 */
const RISKY_CONSTRAINTS = [
  ['constraints/gcp.restrictServiceUsage', 'サービスの利用制限（Firebase API を含むと追加できない）'],
  ['constraints/iam.disableServiceAccountCreation', 'サービスアカウント作成の禁止（Firebase のサービスエージェントを作れない）'],
  ['constraints/iam.disableServiceAccountKeyCreation', 'サービスアカウント鍵の作成禁止'],
  ['constraints/gcp.resourceLocations', 'リソースの作成先リージョン制限'],
];

function listPolicies(scopeArgs, label) {
  const policies = run(
    'gcloud',
    ['resource-manager', 'org-policies', 'list', ...scopeArgs, '--format=value(constraint)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (!policies.ok) {
    info(`${label}のポリシーを取得できませんでした（権限が無い場合は正常です）。`);
    return [];
  }
  const lines = policies.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    record(true, `${label}にポリシーはありません`, '');
    return [];
  }
  console.log('');
  console.log(`        ${label}のポリシー:`);
  for (const line of lines) {
    console.log(`          ${line}`);
  }
  console.log('');
  const risky = lines.filter((line) => RISKY_CONSTRAINTS.some(([c]) => line.includes(c)));
  record(
    risky.length === 0,
    risky.length === 0 ? `${label}に Firebase を妨げるポリシーはありません` : `${label}に要注意のポリシーがあります`,
    risky
      .map((line) => {
        const found = RISKY_CONSTRAINTS.find(([c]) => line.includes(c));
        return found ? `${line} — ${found[1]}` : line;
      })
      .join('\n        '),
  );
  return lines;
}

if (hasGcloud) {
  listPolicies([`--project=${projectId}`], 'プロジェクト');

  // 組織・フォルダから継承されるポリシーはプロジェクト単位の一覧に出ない。
  // 祖先をたどって組織 ID を求め、そちらも確認する。
  const ancestors = run(
    'gcloud',
    ['projects', 'get-ancestors', projectId, '--format=value(id,type)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (ancestors.ok) {
    const rows = ancestors.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(/\s+/));
    const org = rows.find((row) => row[1] === 'organization');
    const folders = rows.filter((row) => row[1] === 'folder');

    for (const folder of folders) {
      listPolicies([`--folder=${folder[0]}`], `フォルダ ${folder[0]}`);
    }
    if (org) {
      info(`組織 ID: ${org[0]}`);
      listPolicies([`--organization=${org[0]}`], `組織 ${org[0]}`);
    } else {
      info('このプロジェクトは組織に属していません。');
    }
  } else {
    info('プロジェクトの祖先を取得できませんでした（権限が無い場合は正常です）。');
  }
}

// ---------------------------------------------------------------------------
step('8. Google Workspace 側の Firebase 有効/無効');
info('Google Workspace 管理コンソールで Firebase を無効化していると、');
info('プロジェクト権限が十分でも API は 403 を返します。');
info('  管理コンソール → アプリ → その他の Google サービス → Firebase');
info('  対象の組織部門(OU)で「オン」になっているか確認してください。');
console.log('');
info(`このアカウントで新規 Firebase プロジェクトを作れるか試すと切り分けられます:`);
info(`  ${fb.bin} ${[...fb.prefix, 'projects:create', 'smileq-live-test'].join(' ')}`);
info('  作成できる → Firebase 自体は使える。idl-application 固有の問題');
info('  作成できない → 組織や Workspace 側で Firebase が制限されている');

// ---------------------------------------------------------------------------
heading('まとめ');
const problems = findings.filter((f) => !f.ok);
if (problems.length === 0) {
  console.log(`  ${color.green('Firebase を利用できる状態です。')}`);
} else {
  console.log('  次の項目を確認してください:');
  for (const problem of problems) {
    console.log(`    ${color.yellow('▲')} ${problem.label}`);
    if (problem.detail) {
      console.log(`        ${problem.detail}`);
    }
  }
}
console.log('');
info('Firestore を使っていることと、Firebase が追加されていることは別です。');
info('詳細は docs/FIREBASE_SETUP.md を参照してください。');
console.log('');
process.exit(0);
