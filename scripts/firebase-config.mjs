#!/usr/bin/env node
/**
 * Firebase の公開設定（projectId / apiKey / authDomain / storageBucket / appId）を
 * CLI で取得し、デプロイ設定ファイルへ書き込む。
 *
 *   npm run firebase:config                      … 対話的に選んで production へ書き込む
 *   npm run firebase:config -- --project my-proj … プロジェクトを指定
 *   npm run firebase:config -- staging           … 書き込み先の環境を指定
 *   npm run firebase:config -- --print           … 書き込まず表示だけ
 *
 * GUI（Firebase コンソール）を開く必要はない。
 * ここで扱う値はすべて**公開前提の識別子**であり秘密情報ではない
 * （docs/FIRESTORE_MODEL.md §6）。サーバー用の秘密鍵は Firebase 版では不要。
 *
 * 内部で使う Firebase CLI コマンド:
 *   firebase projects:list                     … アクセスできるプロジェクト一覧
 *   firebase apps:list WEB --project <id>      … 登録済み Web アプリ一覧
 *   firebase apps:create WEB "<name>" ...      … Web アプリが無い場合に作成
 *   firebase apps:sdkconfig WEB <appId> ...    … 公開設定一式を取得
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { cliJson } from './lib/cli-json.mjs';
import { configPath, ENVIRONMENTS, parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { commandExists, detectPackageManager, run } from './lib/proc.mjs';
import { ask, confirmYesNo, isInteractive } from './lib/prompt.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));
const printOnly = flags.has('print');
const targetEnv = positional.find((value) => ENVIRONMENTS.includes(value)) ?? 'production';

heading('Firebase の公開設定を取得');
info('Firebase コンソール（GUI）を開かずに CLI だけで取得します。');

// ---------------------------------------------------------------------------
// Firebase CLI の準備
// ---------------------------------------------------------------------------
const hasFirebaseCli = commandExists('firebase');
const packageManager = detectPackageManager();
const cli = hasFirebaseCli
  ? { bin: 'firebase', prefix: [] }
  : packageManager === 'pnpm'
    ? { bin: 'pnpm', prefix: ['dlx', 'firebase-tools@15'] }
    : { bin: 'npx', prefix: ['--yes', 'firebase-tools@15'] };

if (!hasFirebaseCli) {
  info(`firebase CLI が無いため ${cli.bin} 経由で実行します（初回は取得に時間がかかります）。`);
}

/**
 * firebase CLI をリポジトリの外で実行するための作業ディレクトリ。
 *
 * ここで使うコマンド（projects / apps 系）は firebase.json を必要としない。
 * それにもかかわらずリポジトリ直下で実行すると CLI が firebase.json を読み込んでしまう。
 * このリポジトリの firebase.json は storage.bucket を意図的にプレースホルダのままにしてあり
 * （誤った手動デプロイを止めるため — scripts/deploy-rules.mjs）、
 * 設定取得とは無関係な検証の警告や異常終了を招く。最初から見えない場所で実行する。
 */
const cliCwd = mkdtempSync(join(tmpdir(), 'smileq-firebase-'));
process.on('exit', () => {
  rmSync(cliCwd, { recursive: true, force: true });
});

function firebase(args, { capture = true, allowFailure = false } = {}) {
  return run(cli.bin, [...cli.prefix, ...args], {
    capture,
    quiet: true,
    allowFailure,
    cwd: cliCwd,
  });
}

/** 中身は正しいのに終了コードだけが 0 以外だった場合に、黙って隠さず記録する。 */
function noteExitCodeMismatch(cmdResult, label) {
  if (cmdResult.ok) {
    return;
  }
  warn(
    `${label}: firebase CLI は終了コード ${cmdResult.status ?? '不明'} を返しましたが、` +
      '有効な JSON が得られたため続行します。',
  );
  const line = String(cmdResult.stderr ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !/^(npm |pnpm |\(node:)/.test(value));
  if (line) {
    info(`  stderr: ${line}`);
  }
}

/**
 * 失敗した firebase コマンドの出力を、原因が分かる形で表示する。
 *
 * npm / pnpm 経由だと大量の warn が混ざるため、それらを除いて
 * 実際のエラー行だけを残す（原因が埋もれると利用者が対処できない）。
 */
/**
 * firebase CLI は失敗の詳細を stdout ではなく firebase-debug.log にだけ書く。
 * 分類を誤らないよう、直近のエラー行をここから読み取る。
 */
function readDebugLogTail(maxLines = 400) {
  // CLI は実行時の作業ディレクトリへ書くため、そちらを先に見る。
  const candidates = [
    join(cliCwd, 'firebase-debug.log'),
    join(cliCwd, 'firebase-debug.log.1'),
    'firebase-debug.log',
    'firebase-debug.log.1',
  ];
  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }
    try {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      return lines.slice(-maxLines).join('\n');
    } catch {
      // 読めなければ無視する。
    }
  }
  return '';
}

/** デバッグログから HTTP ステータスとエラー本文を抽出する。 */
function extractApiError(logText) {
  const status = logText.match(/HTTP Error:\s*(\d{3})/g)?.pop() ?? '';
  const body = logText.match(/\{"error":\{[^\n]*\}\}/g)?.pop() ?? '';
  return { status, body, text: `${status}\n${body}\n${logText}` };
}

function reportFailure(result, args) {
  const noise = /^(npm |pnpm |\(node:|\s*$)/;
  const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !noise.test(line));

  console.error('');
  console.error(`  実行したコマンド: firebase ${args.join(' ')}`);
  if (lines.length > 0) {
    console.error('  出力:');
    for (const line of lines.slice(0, 15)) {
      console.error(`    ${line}`);
    }
  } else {
    console.error('  出力: （エラーメッセージが得られませんでした）');
  }
  console.error('');
}

// ---------------------------------------------------------------------------
step('ログイン状態を確認');
const loginCheck = firebase(['login:list'], { allowFailure: true });
if (!loginCheck.ok || /No authorized accounts/i.test(loginCheck.stdout)) {
  fatal(
    'Firebase CLI にログインしていません。',
    [
      '次のコマンドでログインしてください（ブラウザが開きます）:',
      `  ${cli.bin} ${[...cli.prefix, 'login'].join(' ')}`,
      '',
      'ブラウザを開けない環境（SSH 越しなど）では:',
      `  ${cli.bin} ${[...cli.prefix, 'login', '--no-localhost'].join(' ')}`,
    ].join('\n'),
  );
}
success(loginCheck.stdout.split(/\r?\n/).find((line) => line.includes('@')) ?? 'ログイン済み');

// ---------------------------------------------------------------------------
step('プロジェクトを決定');
let projectId = typeof flags.get('project') === 'string' ? flags.get('project') : '';

/** projects:list は 2 箇所で使うため 1 回だけ実行して使い回す。 */
let projectsCache = null;
function listProjects() {
  if (projectsCache) {
    return projectsCache;
  }
  const cmdResult = firebase(['projects:list', '--json'], { allowFailure: true });
  const parsed = cliJson(cmdResult);
  if (parsed.ok) {
    noteExitCodeMismatch(cmdResult, 'projects:list');
  }
  projectsCache = {
    ok: parsed.ok,
    message: parsed.message,
    projects: Array.isArray(parsed.result)
      ? parsed.result.map((item) => ({ id: item.projectId, name: item.displayName ?? '' }))
      : [],
  };
  return projectsCache;
}

if (!projectId) {
  const { projects } = listProjects();

  if (projects.length === 0) {
    warn('プロジェクト一覧を取得できませんでした。');
    info('--project でプロジェクト ID を直接指定してください。');
    info(`一覧の確認: ${cli.bin} ${[...cli.prefix, 'projects:list'].join(' ')}`);
    process.exit(1);
  }

  console.log('');
  projects.forEach((project, index) => {
    console.log(`  ${String(index + 1).padStart(2)}. ${project.id}  ${color.dim(project.name)}`);
  });
  console.log('');

  if (projects.length === 1) {
    projectId = projects[0].id;
    success(`プロジェクトは 1 件のみ: ${projectId}`);
  } else if (isInteractive()) {
    const answer = await ask('番号またはプロジェクト ID を入力してください: ');
    const index = Number.parseInt(answer, 10);
    projectId =
      Number.isInteger(index) && index >= 1 && index <= projects.length
        ? projects[index - 1].id
        : answer.trim();
  } else {
    fatal('複数のプロジェクトがあります。--project で指定してください。');
  }
}

if (!projectId) {
  fatal('プロジェクト ID を決定できませんでした。');
}
success(`プロジェクト: ${projectId}`);

// ---------------------------------------------------------------------------
step('Firebase が有効になっているか確認');

/**
 * Google Cloud プロジェクトに Firebase リソースが追加されているか。
 *
 * GCP プロジェクトが存在していても Firebase が未追加だと、
 * Firebase Management API は 404 "Firebase project <番号> not found" を返す。
 * この状態は権限不足と紛らわしいので、明示的に切り分ける。
 */
function isFirebaseNotEnabled(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return /Firebase project .* not found/i.test(output) || /not a Firebase project/i.test(output);
}

const projectCheck = listProjects();
// 一覧を取得できなかったときは、ここで判定せず後続の API 呼び出しの結果で切り分ける。
const firebaseEnabled = projectCheck.ok
  ? projectCheck.projects.some((item) => item.id === projectId)
  : true;

if (!firebaseEnabled) {
  warn(`${projectId} に Firebase が追加されていません。`);
  info('Google Cloud プロジェクトとしては存在しますが、Firebase リソースが未追加の状態です。');
  info('（この状態でも Cloud Run などは使えるため、権限不足と紛らわしくなります）');
  console.log('');

  const shouldAdd =
    flags.has('yes') || !isInteractive()
      ? true
      : await confirmYesNo(`${projectId} へ Firebase を追加しますか？`, true);

  if (!shouldAdd) {
    fatal(
      'Firebase が有効でないと設定を取得できません。',
      [
        'CLI で追加する場合:',
        `  ${cli.bin} ${[...cli.prefix, 'projects:addfirebase', projectId].join(' ')}`,
        '',
        'GUI で追加する場合:',
        '  https://console.firebase.google.com/ → プロジェクトを追加 →',
        `  「既存の Google Cloud プロジェクト」から ${projectId} を選ぶ`,
      ].join('\n'),
    );
  }

  step('Firebase を追加');
  const added = firebase(['projects:addfirebase', projectId, '--json'], { allowFailure: true });
  const addedJson = cliJson(added);
  if (!addedJson.ok) {
    reportFailure(added, ['projects:addfirebase', projectId]);

    // CLI の標準出力には詳細が出ないため、デバッグログも合わせて判定する。
    const debugLog = readDebugLogTail();
    const apiError = extractApiError(debugLog);
    const output = `${added.stdout ?? ''}\n${added.stderr ?? ''}\n${addedJson.message}\n${apiError.text}`;

    if (apiError.body) {
      console.error(`  API の応答: ${apiError.body}`);
      console.error('');
    }
    const permissionDenied =
      /PERMISSION_DENIED/i.test(output) ||
      /does not have permission/i.test(output) ||
      /HTTP Error: 403/i.test(output);
    const serviceDisabled = /SERVICE_DISABLED/i.test(output) || /has not been used in project/i.test(output);

    if (serviceDisabled) {
      fatal(
        'Firebase Management API が有効になっていません。',
        [
          '次を実行してから、もう一度お試しください:',
          `  gcloud services enable firebase.googleapis.com --project ${projectId}`,
        ].join('\n'),
      );
    }

    if (permissionDenied) {
      fatal(
        `${projectId} へ Firebase を追加できませんでした（403）。`,
        [
          '403 は「IAM 権限が足りない」以外の原因でも返ります。',
          'オーナー権限があるのに失敗する場合は、次の順に確認してください。',
          '',
          '── 1. Firebase Management API が有効か ──',
          `  gcloud services list --enabled --project ${projectId} | grep firebase`,
          `  gcloud services enable firebase.googleapis.com --project ${projectId}`,
          '',
          '── 2. CLI の認証スコープを取り直す ──',
          '  古いログインだと firebase スコープが足りないことがあります。',
          `    ${cli.bin} ${[...cli.prefix, 'login', '--reauth'].join(' ')}`,
          '',
          '── 3. Firebase の利用規約に同意しているか ──',
          '  その Google アカウント／組織で Firebase を一度も使ったことが無い場合、',
          '  規約同意が済んでおらず API 側で拒否されます。',
          '  https://console.firebase.google.com/ を一度開いて同意すると解消します。',
          '  （同意後は CLI だけで進められます）',
          '',
          '── 4. 組織ポリシーで制限されていないか ──',
          `  gcloud resource-manager org-policies list --project ${projectId}`,
          '',
          '── 5. 自分のロールを確認する ──',
          `  gcloud projects get-iam-policy ${projectId} \\`,
          '    --flatten="bindings[].members" \\',
          `    --filter="bindings.members:$(gcloud config get-value account)" \\`,
          '    --format="value(bindings.role)"',
          '',
          '── 回避策: 別プロジェクトで Firebase を使う ──',
          '  Cloud Run と同じプロジェクトである必要はありません。',
          `    ${cli.bin} ${[...cli.prefix, 'projects:create', 'smileq-live', '--display-name', '"SmileQ Live"'].join(' ')}`,
          '    npm run firebase:config -- --project=smileq-live',
          '  詳細は docs/FIREBASE_SETUP.md の「プロジェクトを分けてもよい」を参照。',
        ].join('\n'),
      );
    }

    fatal(
      'Firebase を追加できませんでした。',
      [
        '考えられる原因:',
        '  * 組織ポリシーで Firebase の利用が制限されている',
        '  * プロジェクトが削除保留中',
        '',
        'GUI で追加する場合:',
        '  https://console.firebase.google.com/ → プロジェクトを追加 →',
        `  「既存の Google Cloud プロジェクト」から ${projectId} を選ぶ`,
      ].join('\n'),
    );
  }
  noteExitCodeMismatch(added, 'projects:addfirebase');
  success(`${projectId} へ Firebase を追加しました。`);
}

// ---------------------------------------------------------------------------
step('Web アプリを決定');
const appsResult = firebase(['apps:list', 'WEB', '--project', projectId, '--json'], {
  allowFailure: true,
});

const appsJson = cliJson(appsResult);
if (appsJson.ok) {
  noteExitCodeMismatch(appsResult, 'apps:list');
}
const apps = Array.isArray(appsJson.result)
  ? appsJson.result.map((item) => ({ appId: item.appId, displayName: item.displayName ?? '' }))
  : [];

let appId = '';
if (apps.length === 0) {
  if (appsJson.message) {
    warn(`Web アプリ一覧を取得できませんでした: ${appsJson.message}`);
  }
  warn('この プロジェクトに Web アプリが登録されていません。');
  const shouldCreate =
    flags.has('yes') || !isInteractive()
      ? true
      : await confirmYesNo('Web アプリ「SmileQ Live」を作成しますか？', true);

  if (!shouldCreate) {
    fatal(
      'Web アプリが無いと公開設定を取得できません。',
      `作成コマンド: ${cli.bin} ${[...cli.prefix, 'apps:create', 'WEB', '"SmileQ Live"', '--project', projectId].join(' ')}`,
    );
  }

  const created = firebase(
    ['apps:create', 'WEB', 'SmileQ Live', '--project', projectId, '--json'],
    { allowFailure: true },
  );
  const createdJson = cliJson(created);
  if (!createdJson.ok) {
    reportFailure(created, ['apps:create', 'WEB', 'SmileQ Live', '--project', projectId]);
    if (createdJson.message) {
      console.error(`  CLI のエラー: ${createdJson.message}`);
      console.error('');
    }
    if (isFirebaseNotEnabled(created)) {
      fatal(
        `${projectId} に Firebase が追加されていません。`,
        [
          'Google Cloud プロジェクトは存在しますが、Firebase リソースが未追加です。',
          '',
          'CLI で追加する場合:',
          `  ${cli.bin} ${[...cli.prefix, 'projects:addfirebase', projectId].join(' ')}`,
          '',
          'GUI で追加する場合:',
          '  https://console.firebase.google.com/ → プロジェクトを追加 →',
          `  「既存の Google Cloud プロジェクト」から ${projectId} を選ぶ`,
        ].join('\n'),
      );
    }
    fatal(
      'Web アプリを作成できませんでした。',
      [
        'よくある原因:',
        '  * このアカウントに Firebase プロジェクトの編集権限が無い',
        '    （必要なロール: roles/firebase.developAdmin もしくは編集者）',
        '  * 対象プロジェクトで Firebase が有効化されていない',
        '',
        '手動で作成する場合:',
        `  ${cli.bin} ${[...cli.prefix, 'apps:create', 'WEB', '"SmileQ Live"', '--project', projectId].join(' ')}`,
      ].join('\n'),
    );
  }
  noteExitCodeMismatch(created, 'apps:create');
  appId = createdJson.result?.appId ?? '';
  if (!appId) {
    fatal('作成した Web アプリの appId を取得できませんでした。');
  }
  success(`Web アプリを作成しました: ${appId}`);
} else if (apps.length === 1) {
  appId = apps[0].appId;
  success(`Web アプリ: ${appId} ${apps[0].displayName}`);
} else {
  console.log('');
  apps.forEach((app, index) => {
    console.log(`  ${String(index + 1).padStart(2)}. ${app.appId}  ${color.dim(app.displayName)}`);
  });
  console.log('');
  if (isInteractive()) {
    const answer = await ask('番号または appId を入力してください: ');
    const index = Number.parseInt(answer, 10);
    appId =
      Number.isInteger(index) && index >= 1 && index <= apps.length
        ? apps[index - 1].appId
        : answer.trim();
  } else {
    appId = apps[0].appId;
    warn(`複数の Web アプリがあります。先頭を使用します: ${appId}`);
  }
}

// ---------------------------------------------------------------------------
step('公開設定を取得');
const sdkResult = firebase(['apps:sdkconfig', 'WEB', appId, '--project', projectId, '--json'], {
  allowFailure: true,
});

// 判定は終了コードではなく出力内容で行う（cliJson の説明を参照）。
// CLI が正しい設定を返しているのに「取得できませんでした」と言わないため。
const sdkJson = cliJson(sdkResult);
if (!sdkJson.ok) {
  reportFailure(sdkResult, ['apps:sdkconfig', 'WEB', appId, '--project', projectId]);
  if (sdkJson.message) {
    console.error(`  CLI のエラー: ${sdkJson.message}`);
    console.error('');
  }
  fatal('公開設定を取得できませんでした。');
}
noteExitCodeMismatch(sdkResult, 'apps:sdkconfig');

const payload = sdkJson.result ?? {};
const config = payload.sdkConfig ?? payload;

const resolved = {
  firebaseProjectId: config.projectId ?? projectId,
  firebaseApiKey: config.apiKey ?? '',
  firebaseAuthDomain: config.authDomain ?? `${projectId}.firebaseapp.com`,
  firebaseStorageBucket: config.storageBucket ?? `${projectId}.firebasestorage.app`,
  firebaseAppId: config.appId ?? appId,
};

if (!resolved.firebaseApiKey) {
  fatal('apiKey を取得できませんでした。Web アプリが正しく作成されているか確認してください。');
}

console.log('');
console.log('  取得した公開設定:');
for (const [key, value] of Object.entries(resolved)) {
  console.log(`    ${key.padEnd(24)} ${value}`);
}
console.log('');
console.log(
  `  ${color.dim('※ これらは公開前提の識別子です。ブラウザへ渡ります（秘密情報ではありません）。')}`,
);
console.log(
  `  ${color.dim('   実際の保護は Security Rules とサーバー側の認可で行います。')}`,
);

if (printOnly) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
step(`deploy/cloud-run.${targetEnv}.json へ書き込み`);
const path = configPath(targetEnv);

if (!existsSync(path)) {
  const examplePath = new URL(
    `../deploy/cloud-run.${targetEnv}.example.json`,
    import.meta.url,
  );
  if (!existsSync(examplePath)) {
    fatal(`雛形が見つかりません: deploy/cloud-run.${targetEnv}.example.json`);
  }
  writeFileSync(path, readFileSync(examplePath, 'utf8'));
  info(`雛形から作成しました: deploy/cloud-run.${targetEnv}.json`);
}

const current = JSON.parse(readFileSync(path, 'utf8'));
const updated = { ...current, ...resolved };

/**
 * 画像用の専用バケット名。
 *
 * Firebase の既定バケット（<project>.firebasestorage.app）は**使わない**。
 * 同じプロジェクトで既存アプリが動いている場合、既定バケットを対象に
 * Storage ルールを配信すると既存アプリのルールを上書きしてしまうため、
 * バケットごと分けてルールもデータも独立させる（docs/FIREBASE_SETUP.md）。
 * このバケットは npm run gcp:bootstrap が作成する。
 */
const dedicatedMediaBucket = `${resolved.firebaseProjectId}-smileq-media`;

const currentMediaBucket = String(current.mediaBucket ?? '').trim();
const isPlaceholder =
  currentMediaBucket.length === 0 || /your-(firebase|gcp)/.test(currentMediaBucket);
const isSharedDefaultBucket =
  currentMediaBucket === resolved.firebaseStorageBucket ||
  currentMediaBucket === `${resolved.firebaseProjectId}.firebasestorage.app` ||
  currentMediaBucket === `${resolved.firebaseProjectId}.appspot.com`;

if (isPlaceholder || isSharedDefaultBucket) {
  updated.mediaBucket = dedicatedMediaBucket;
  if (isSharedDefaultBucket) {
    warn(`mediaBucket が Firebase 既定バケット (${currentMediaBucket}) を指していました。`);
    info('既定バケットへ Storage ルールを配信すると既存アプリのルールを上書きします。');
    info(`専用バケットへ変更しました: ${dedicatedMediaBucket}`);
    info('意図的に既定バケットを使う場合は、設定ファイルを直接書き換えてください。');
  }
}

writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
success(`deploy/cloud-run.${targetEnv}.json を更新しました`);

console.log('');
console.log('  既存アプリと分離する設定:');
console.log(
  `    firestoreDatabaseId … ${color.bold(updated.firestoreDatabaseId ?? 'smileq-live')}  ${color.dim('（既定 (default) は使わない）')}`,
);
console.log(
  `    mediaBucket         … ${color.bold(updated.mediaBucket)}  ${color.dim('（gcp:bootstrap が作成）')}`,
);
console.log('');
console.log('  残りの設定（Google Cloud 側）:');
console.log(`    projectId       … ${color.bold(updated.projectId)}`);
console.log(`    serviceAccount  … ${color.bold(updated.serviceAccount)}`);
console.log('');
if (String(updated.projectId).includes('your-gcp-project-id')) {
  warn('projectId / serviceAccount が雛形のままです。実際の値へ書き換えてください。');
  info(`Firebase と同じプロジェクトを使う場合は projectId も "${projectId}" になります。`);
} else {
  success('Google Cloud 側の設定も入力済みです。');
}
console.log('');
info('確認: npm run deploy:doctor');
console.log('');
