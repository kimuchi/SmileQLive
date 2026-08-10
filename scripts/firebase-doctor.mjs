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
import { existsSync, readFileSync } from 'node:fs';
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
step('5. Firebase 利用規約への同意');
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
step('6. 組織ポリシー');
if (hasGcloud) {
  const policies = run(
    'gcloud',
    ['resource-manager', 'org-policies', 'list', `--project=${projectId}`, '--format=value(constraint)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (policies.ok) {
    const lines = policies.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      record(true, 'プロジェクト単位の組織ポリシーはありません', '');
    } else {
      console.log('');
      for (const line of lines) {
        console.log(`          ${line}`);
      }
      console.log('');
      const suspicious = lines.filter((line) => /restrictServiceUsage|firebase/i.test(line));
      record(
        suspicious.length === 0,
        suspicious.length === 0 ? '疑わしいポリシーはありません' : 'Firebase を制限しうるポリシーがあります',
        suspicious.join(', '),
      );
    }
  } else {
    info('組織ポリシーを取得できませんでした（権限が無い場合は正常です）。');
  }
}

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
