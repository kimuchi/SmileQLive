#!/usr/bin/env node
/**
 * Firebase の公開設定（projectId / apiKey / authDomain / storageBucket / appId）を
 * CLI で取得し、デプロイ設定ファイルへ書き込む。
 *
 *   npm run firebase:config                      … 対話的に選んで production へ書き込む
 *   npm run firebase:config -- --project my-proj … プロジェクトを指定
 *   npm run firebase:config -- staging           … 書き込み先の環境を指定
 *   npm run firebase:config -- --print           … 書き込まず表示だけ
 *   npm run firebase:config -- --app-id 1:...    … 既知の Web アプリを直接指定
 *   npm run firebase:config -- --new-api-key     … 専用の API キーを作り直す
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
 *
 * Web アプリ API が組織の制限などで使えない場合は、gcloud の API キーから
 * 同じ値を組み立てる（apiKey の実体は Google Cloud の API キー、
 * authDomain はプロジェクト ID から決まり、appId は Analytics 用で任意）。
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { cliJson } from './lib/cli-json.mjs';
import {
  classifyApiError,
  extractApiError,
  readDebugLogTail,
  relevantLogLines,
} from './lib/firebase-debug.mjs';
import { configPath, ENVIRONMENTS, parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { commandExists, detectPackageManager, run } from './lib/proc.mjs';
import { ask, confirmYesNo, isInteractive } from './lib/prompt.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));
const printOnly = flags.has('print');
/** 既存アプリのキーと取り違えないよう、専用キーの名前を固定する。 */
const DEDICATED_KEY_NAME = 'SmileQ Live Web';
/** 制限に当たったキーを捨てて作り直したいときに使う。 */
const forceNewApiKey = flags.has('new-api-key');
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
const repoRoot = process.cwd();
const cliCwd = mkdtempSync(join(tmpdir(), 'smileq-firebase-'));
process.on('exit', () => {
  rmSync(cliCwd, { recursive: true, force: true });
});

/**
 * CLI のデバッグログをリポジトリ直下へ退避する。
 *
 * firebase CLI は「See firebase-debug.log for more info」としか言わず、
 * 実際の HTTP ステータスと API の応答はログにしか書かない。
 * そのログは CLI の作業ディレクトリ（= 終了時に消える一時領域）にできるため、
 * 失敗時はここでリポジトリ直下へ写して利用者が読めるようにする。
 * （firebase-debug.log* は .gitignore 済み）
 */
function preserveDebugLog() {
  for (const name of ['firebase-debug.log', 'firebase-debug.log.1']) {
    const from = join(cliCwd, name);
    if (!existsSync(from)) {
      continue;
    }
    const to = join(repoRoot, name);
    try {
      copyFileSync(from, to);
      return to;
    } catch {
      // 写せなければ諦める（診断のための処理で失敗を増やさない）。
    }
  }
  return '';
}

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

/** CLI は作業ディレクトリへログを書くため、そちらを先に見る。 */
function readCliDebugLog() {
  return readDebugLogTail([cliCwd, repoRoot]);
}

/**
 * 失敗した firebase コマンドの出力を、原因が分かる形で表示する。
 *
 * npm / pnpm 経由だと大量の warn が混ざるため、それらを除いて
 * 実際のエラー行だけを残す（原因が埋もれると利用者が対処できない）。
 */
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

/**
 * 失敗した firebase コマンドについて、分かることを全部出す。
 *
 * CLI 本体は「See firebase-debug.log for more info」としか言わないため、
 * ここでデバッグログから HTTP ステータスと API の応答本文を取り出して見せ、
 * ログ自体もリポジトリ直下へ残す。ここを省くと利用者は原因に辿り着けない。
 *
 * @returns {{status: string, body: string, text: string}} 判定に使えるエラー情報
 */
function explainFailure(cmdResult, args, jsonMessage = '') {
  reportFailure(cmdResult, args);
  if (jsonMessage) {
    console.error(`  CLI のエラー: ${jsonMessage}`);
    console.error('');
  }

  const logText = readCliDebugLog();
  const apiError = extractApiError(logText);
  if (apiError.status || apiError.body) {
    console.error('  API の応答:');
    if (apiError.status) {
      console.error(`    HTTP ${apiError.status}`);
    }
    if (apiError.body) {
      console.error(`    ${apiError.body}`);
    }
    console.error('');
  } else {
    // 構造化された本文が取れないログもある。読める形でそのまま見せる。
    const lines = relevantLogLines(logText);
    if (lines.length > 0) {
      console.error('  firebase-debug.log より:');
      for (const line of lines) {
        console.error(`    ${line.slice(0, 200)}`);
      }
      console.error('');
    }
  }

  const saved = preserveDebugLog();
  if (saved) {
    console.error(`  詳細ログ: ${saved}`);
    console.error('');
  }
  return { ...apiError, text: `${cmdResult.stdout ?? ''}\n${cmdResult.stderr ?? ''}\n${jsonMessage}\n${apiError.text}` };
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
    const debugLog = readCliDebugLog();
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
// Web アプリと公開設定
//
// 通常は Firebase の Web アプリ登録から公開設定一式を取得する。
// ただし Web アプリ API（firebase.googleapis.com の webApps）は、
// 組織の制限や権限設定によっては一覧も作成も 403 で拒否されることがある。
// その場合でも SmileQ Live に必要な値は揃えられるため、gcloud の API キーで代替する。
//   * appId … Analytics を使わないので任意（src/lib/env/server-env.ts）
//   * authDomain / storageBucket … プロジェクト ID から決まる
//   * apiKey … Google Cloud の API キーそのもの。gcloud で取得・作成できる
// ---------------------------------------------------------------------------
step('Web アプリを決定');

/** --app-id で既知の appId を渡せる（一覧が使えないときの回避策）。 */
const explicitAppId = typeof flags.get('app-id') === 'string' ? flags.get('app-id').trim() : '';

let appId = '';
let webAppUsable = true;

if (explicitAppId) {
  appId = explicitAppId;
  success(`指定された Web アプリを使用します: ${appId}`);
} else {
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

  if (!appsJson.ok) {
    // 一覧そのものが失敗した場合は「アプリが 0 件」とは区別する。
    // 既に登録済みのアプリが見えていないだけかもしれないので、ここでは作成しない
    // （見えない状態で作成すると Web アプリが二重にできる）。
    warn('Web アプリの一覧を取得できませんでした。');
    const failure = explainFailure(
      appsResult,
      ['apps:list', 'WEB', '--project', projectId],
      appsJson.message,
    );
    explainWebAppDenied(failure);
    info('登録済みの appId が分かっている場合は、直接指定できます:');
    info(`  npm run firebase:config -- --project=${projectId} --app-id=<appId>`);
    console.log('');
    webAppUsable = false;
  } else if (apps.length === 0) {
    warn('このプロジェクトに Web アプリが登録されていません。');
    const shouldCreate =
      flags.has('yes') || !isInteractive()
        ? true
        : await confirmYesNo('Web アプリ「SmileQ Live」を作成しますか？', true);

    if (!shouldCreate) {
      webAppUsable = false;
    } else {
      const created = firebase(
        ['apps:create', 'WEB', 'SmileQ Live', '--project', projectId, '--json'],
        { allowFailure: true },
      );
      const createdJson = cliJson(created);
      if (createdJson.ok) {
        noteExitCodeMismatch(created, 'apps:create');
        appId = createdJson.result?.appId ?? '';
        if (appId) {
          success(`Web アプリを作成しました: ${appId}`);
        } else {
          warn('作成した Web アプリの appId を取得できませんでした。');
          webAppUsable = false;
        }
      } else {
        warn('Web アプリを作成できませんでした。');
        const failure = explainFailure(
          created,
          ['apps:create', 'WEB', 'SmileQ Live', '--project', projectId],
          createdJson.message,
        );
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
        explainWebAppDenied(failure);
        webAppUsable = false;
      }
    }
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
}

/**
 * Web アプリ API が拒否されたときに、原因ごとの対処を出す。
 *
 * 403 は「権限不足」以外でも返るため、デバッグログの内容で分類してから案内する
 * （一律に「権限を確認してください」と言うと、権限があるのに直せない）。
 */
function explainWebAppDenied(failure) {
  const kind = classifyApiError(failure?.text ?? '');
  console.log('');

  if (kind.serviceDisabled) {
    info('必要な API が無効になっています。');
    info(
      `  gcloud services enable firebase.googleapis.com apikeys.googleapis.com --project ${projectId}`,
    );
  } else if (kind.insufficientScopes) {
    info('CLI のログインに必要なスコープが足りません（古いログインで起きます）。');
    info(`  ${cli.bin} ${[...cli.prefix, 'login', '--reauth'].join(' ')}`);
  } else if (kind.permissionDenied) {
    info('Web アプリ API が 403 を返しています。よくある原因:');
    info('  * apikeys.googleapis.com が無効（Web アプリ作成時にブラウザ用キーを作れない）');
    info(`      gcloud services enable apikeys.googleapis.com --project ${projectId}`);
    info('  * CLI のログインスコープが古い');
    info(`      ${cli.bin} ${[...cli.prefix, 'login', '--reauth'].join(' ')}`);
    info('  * 権限不足（必要なロール: roles/firebase.developAdmin）');
    info('  * 組織ポリシーで API キーの作成が禁止されている');
  } else {
    info('Web アプリ API を利用できませんでした。');
    info(`  切り分け: npm run firebase:doctor -- --project ${projectId}`);
  }

  console.log('');
  info('Web アプリの登録は SmileQ Live には必須ではありません（appId は Analytics 用）。');
  console.log('');
}

// ---------------------------------------------------------------------------
step('公開設定を取得');

/** apps:sdkconfig から公開設定を取る（本来の経路）。 */
function configFromWebApp() {
  if (!appId) {
    return null;
  }
  const sdkResult = firebase(['apps:sdkconfig', 'WEB', appId, '--project', projectId, '--json'], {
    allowFailure: true,
  });
  // 判定は終了コードではなく出力内容で行う（cliJson の説明を参照）。
  const sdkJson = cliJson(sdkResult);
  if (!sdkJson.ok) {
    warn('Web アプリの公開設定を取得できませんでした。');
    explainFailure(
      sdkResult,
      ['apps:sdkconfig', 'WEB', appId, '--project', projectId],
      sdkJson.message,
    );
    return null;
  }
  noteExitCodeMismatch(sdkResult, 'apps:sdkconfig');
  const payload = sdkJson.result ?? {};
  const sdk = payload.sdkConfig ?? payload;
  if (!sdk.apiKey) {
    warn('取得した公開設定に apiKey が含まれていませんでした。');
    return null;
  }
  return {
    firebaseProjectId: sdk.projectId ?? projectId,
    firebaseApiKey: sdk.apiKey,
    firebaseAuthDomain: sdk.authDomain ?? `${projectId}.firebaseapp.com`,
    firebaseStorageBucket: sdk.storageBucket ?? `${projectId}.firebasestorage.app`,
    firebaseAppId: sdk.appId ?? appId,
  };
}

/**
 * gcloud の API キーから公開設定を組み立てる（Web アプリ API が使えないときの代替）。
 *
 * apiKey の実体は Google Cloud の API キーであり、Firebase Auth と Firestore の
 * Web SDK はこれと authDomain / projectId だけで動く。appId は Analytics 用で任意。
 */
function configFromGcloud() {
  if (!commandExists('gcloud')) {
    info('gcloud が無いため、API キーによる代替取得はできません。');
    return null;
  }

  const list = run(
    'gcloud',
    ['services', 'api-keys', 'list', `--project=${projectId}`, '--format=json'],
    { capture: true, quiet: true, allowFailure: true },
  );
  let keys = [];
  if (list.ok) {
    try {
      keys = JSON.parse(list.stdout || '[]');
    } catch {
      keys = [];
    }
  } else {
    warn('API キーの一覧を取得できませんでした。');
    const firstLine = String(list.stderr ?? '').split(/\r?\n/)[0] ?? '';
    if (firstLine) {
      info(`  ${firstLine}`);
    }
    info(`  有効化: gcloud services enable apikeys.googleapis.com --project ${projectId}`);
  }

  // 既存アプリのキーを流用しない。
  //
  // Firebase が自動生成した「Browser key」は既存アプリのものであり、
  // 多くの場合 HTTP リファラー制限が既存アプリのドメインに限定されている。
  // それを使い回すと、ブラウザからのログインが
  //   Requests from referer https://<新ドメイン>/ are blocked.
  // で拒否される（画面には原因が出ない）。専用のキーだけを使う。
  const usable = keys.filter((key) => !key.deleteTime);
  const dedicated = usable.find((key) => key.displayName === DEDICATED_KEY_NAME);

  if (!dedicated && usable.length > 0) {
    info(`既存の API キーが ${usable.length} 件ありますが、流用しません。`);
    info('（既存アプリ用のキーはリファラー制限が別ドメインに限定されていることが多いため）');
  }

  let keyName = dedicated?.name ?? '';
  if (forceNewApiKey && keyName) {
    info(`--new-api-key のため、既存の「${DEDICATED_KEY_NAME}」とは別に作り直します。`);
    keyName = '';
  }
  if (!keyName) {
    info(`SmileQ Live 専用の API キーを作成します: ${DEDICATED_KEY_NAME}`);
    const createdKey = run(
      'gcloud',
      [
        'services',
        'api-keys',
        'create',
        `--project=${projectId}`,
        `--display-name=${DEDICATED_KEY_NAME}`,
        '--format=value(response.name)',
      ],
      { capture: true, quiet: true, allowFailure: true },
    );
    if (!createdKey.ok) {
      warn('API キーを作成できませんでした。');
      const firstLine = String(createdKey.stderr ?? '').split(/\r?\n/)[0] ?? '';
      if (firstLine) {
        info(`  ${firstLine}`);
      }
      return null;
    }
    keyName = createdKey.stdout.trim();
    success(`API キーを作成しました: ${keyName.split('/').pop()}`);
  }

  const keyString = run(
    'gcloud',
    ['services', 'api-keys', 'get-key-string', keyName, `--project=${projectId}`, '--format=value(keyString)'],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (!keyString.ok || !keyString.stdout.trim()) {
    warn('API キーの文字列を取得できませんでした。');
    const firstLine = String(keyString.stderr ?? '').split(/\r?\n/)[0] ?? '';
    if (firstLine) {
      info(`  ${firstLine}`);
    }
    return null;
  }

  return {
    firebaseProjectId: projectId,
    firebaseApiKey: keyString.stdout.trim(),
    firebaseAuthDomain: `${projectId}.firebaseapp.com`,
    firebaseStorageBucket: `${projectId}.firebasestorage.app`,
    firebaseAppId: appId,
  };
}

let resolved = webAppUsable ? configFromWebApp() : null;

if (!resolved) {
  console.log('');
  info('Web アプリからは取得できませんでした。gcloud の API キーで代替します。');
  info('（apiKey の実体は Google Cloud の API キーです。appId は Analytics 用で任意）');
  console.log('');
  resolved = configFromGcloud();
  if (resolved) {
    success('gcloud から公開設定を組み立てました。');
    if (!resolved.firebaseAppId) {
      info('appId は空のままにします（Analytics を使わないため不要）。');
    }
  }
}

if (!resolved) {
  fatal(
    '公開設定を取得できませんでした。',
    [
      '次のいずれかで先へ進めます。',
      '',
      '── 1. 既に Web アプリがあるなら appId を直接指定する ──',
      `  npm run firebase:config -- --project=${projectId} --app-id=1:000000000000:web:xxxxxxxx`,
      '',
      '── 2. API キーを手で取得して設定ファイルへ書く ──',
      `  gcloud services api-keys list --project ${projectId}`,
      `  gcloud services api-keys get-key-string <KEY_ID> --project ${projectId}`,
      '  deploy/cloud-run.<env>.json の firebaseApiKey へ貼り付けてください。',
      `  firebaseAuthDomain は ${projectId}.firebaseapp.com です。`,
      '',
      '── 3. Firebase コンソールから Web アプリを登録する ──',
      `  https://console.firebase.google.com/project/${projectId}/settings/general`,
      '',
      `切り分け: npm run firebase:doctor -- --project ${projectId}`,
    ].join('\n'),
  );
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

// ---------------------------------------------------------------------------
// Google Cloud 側（projectId / serviceAccount）
//
// ここを雛形のまま残すと、初期設定が途中まで成功してから失敗する。
// 実際に「projectId だけ直して serviceAccount を直し忘れる」事故が起きた
// （存在しない ...@your-gcp-project-id... へ権限を付与しようとして停止）。
// 同じプロジェクトを使うのが通常なので、雛形のままならここで揃える。
// ---------------------------------------------------------------------------
const cloudPlaceholder = /your-gcp-project-id/;
const projectIsPlaceholder = cloudPlaceholder.test(String(current.projectId ?? ''));
const accountIsPlaceholder = cloudPlaceholder.test(String(current.serviceAccount ?? ''));

if (projectIsPlaceholder || accountIsPlaceholder) {
  const useSameProject =
    flags.has('yes') || !isInteractive()
      ? true
      : await confirmYesNo(
          `Cloud Run も同じプロジェクト（${projectId}）を使いますか？`,
          true,
        );

  if (useSameProject) {
    if (projectIsPlaceholder) {
      updated.projectId = projectId;
    }
    if (accountIsPlaceholder) {
      const name = String(current.serviceAccount).split('@')[0] || 'smileq-live-runtime';
      updated.serviceAccount = `${name}@${updated.projectId}.iam.gserviceaccount.com`;
    }
    success(`Cloud Run 側の設定も ${updated.projectId} に揃えました。`);
  } else {
    warn('projectId / serviceAccount は手動で書き換えてください。');
    info(`  deploy/cloud-run.${targetEnv}.json`);
    info('  serviceAccount は <name>@<projectId>.iam.gserviceaccount.com の形です。');
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
if (cloudPlaceholder.test(`${updated.projectId} ${updated.serviceAccount}`)) {
  warn('projectId / serviceAccount が雛形のままです。実際の値へ書き換えてください。');
  info(`Firebase と同じプロジェクトを使う場合は projectId も "${projectId}" になります。`);
} else {
  success('Google Cloud 側の設定も入力済みです。');
}
console.log('');
info('確認: npm run deploy:doctor');
console.log('');
