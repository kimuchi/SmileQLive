#!/usr/bin/env node
/**
 * Firestore / Storage の Security Rules とインデックスを対象プロジェクトへ反映する。
 *
 *   npm run rules:deploy                 … 設定ファイルから対象を自動判定
 *   npm run rules:deploy -- staging      … ステージングの Firebase プロジェクトへ
 *   npm run rules:deploy -- production   … 本番の Firebase プロジェクトへ
 *   npm run rules:deploy -- --project my-firebase-project   … プロジェクトを直接指定
 *
 * オプション:
 *   --yes        確認プロンプトを省略（CI 用）
 *   --dry-run    実行せずコマンドだけ表示
 *   --only       対象を絞る（既定: firestore:rules,firestore:indexes,storage）
 *
 * Rules は「万一クライアントが直接 Firestore を叩いても正解が漏れない」ための最終防壁です
 * （docs/FIRESTORE_MODEL.md §4）。アプリのデプロイとは別に、**必ずここから反映**してください。
 * ルール本体を変更したのに反映を忘れると、会場で正解が先に見えます。
 *
 * 対象ファイルは firebase.json に定義されています。
 *   firebase/firestore.rules / firebase/firestore.indexes.json / firebase/storage.rules
 *
 * firebase CLI が無ければ npx --yes firebase-tools で一時実行します
 * （新しい依存パッケージは追加しません）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { configExists, ENVIRONMENTS, parseArgs, resolveEnvironment } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { commandExists, run } from './lib/proc.mjs';
import { confirmYesNo, isInteractive } from './lib/prompt.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const { positional, flags } = parseArgs(process.argv.slice(2));
const skipConfirm = flags.has('yes') || flags.has('y') || process.env.CI === 'true';
const dryRun = flags.has('dry-run');
/**
 * 既定の配信対象。
 *
 * **既定データベース `(default)` を対象にしない。**
 * SmileQ Live は専用の名前付きデータベース（既定 'smileq-live'）を使うため、
 * `--only firestore:<database>` の形で対象を限定する。
 * これにより、同じプロジェクトに同居している既存アプリのルールとインデックスを
 * 上書きする事故が構造的に起こらない。
 *
 * Storage も同様に、firebase.json の target 'smileq-media' に紐づけた
 * 専用バケットだけを対象にする。
 */
function defaultTargets(databaseId) {
  return `firestore:${databaseId},storage:smileq-media`;
}

heading('Security Rules / インデックスの反映');

// ---------------------------------------------------------------------------
step('対象ファイルを確認');

const requiredFiles = [
  'firebase.json',
  'firebase/firestore.rules',
  'firebase/firestore.indexes.json',
  'firebase/storage.rules',
];

const missingFiles = requiredFiles.filter((file) => !existsSync(file));
if (missingFiles.length > 0) {
  fatal(
    `必要なファイルがありません: ${missingFiles.join(', ')}`,
    'リポジトリのルートで実行しているか確認してください。',
  );
}
success(requiredFiles.join(' / '));

// ---------------------------------------------------------------------------
step('対象の Firebase プロジェクトを決定');

const { projectId, source, environment, databaseId, mediaBucket } = resolveProject();

function resolveProject() {
  // 1. --project で直接指定
  const explicit = typeof flags.get('project') === 'string' ? flags.get('project') : '';
  if (explicit) {
    return { projectId: explicit, source: '--project', environment: '' };
  }

  // 2. 環境変数
  const fromEnv = process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? '';
  const named = positional.some((value) => ENVIRONMENTS.includes(value));
  if (fromEnv && !named && ENVIRONMENTS.filter(configExists).length === 0) {
    return { projectId: fromEnv, source: '環境変数', environment: '' };
  }

  // 3. デプロイ設定ファイル（npm run deploy と同じ解決規則）
  const { environment: target } = resolveEnvironment(positional, flags);
  const path = `deploy/cloud-run.${target}.json`;
  if (!existsSync(path)) {
    fatal(
      `設定ファイルがありません: ${path}`,
      [
        `  cp deploy/cloud-run.${target}.example.json ${path}`,
        'を実行して firebaseProjectId を設定するか、プロジェクトを直接指定してください:',
        '  npm run rules:deploy -- --project <firebase-project-id>',
      ].join('\n'),
    );
  }

  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fatal(`設定ファイルを読み込めません: ${path}`, `JSON として不正です: ${error.message}`);
  }

  const id = config.firebaseProjectId ?? config.projectId;
  if (!id) {
    fatal(
      `${path} に firebaseProjectId がありません。`,
      'Firebase コンソールのプロジェクト ID を設定してください。',
    );
  }
  const databaseId = config.firestoreDatabaseId
    ? String(config.firestoreDatabaseId)
    : 'smileq-live';
  return {
    projectId: String(id),
    source: path,
    environment: target,
    databaseId,
    mediaBucket: config.mediaBucket ? String(config.mediaBucket) : '',
  };
}

const only =
  typeof flags.get('only') === 'string' ? flags.get('only') : defaultTargets(databaseId);

// 既定データベースを対象にしようとしたら必ず止める。
// 同じプロジェクトに同居する既存アプリのルールを消してしまうため。
if (/firestore:\(default\)|(^|,)firestore:rules|(^|,)firestore:indexes|(^|,)firestore(,|$)/.test(only)) {
  fatal(
    '既定データベース (default) を対象にしようとしています。',
    [
      'SmileQ Live は専用の名前付きデータベースを使います。',
      '既定データベースへ配信すると、同じプロジェクトに同居している',
      '既存アプリのセキュリティルールとインデックスを上書きしてしまいます。',
      '',
      `正しい対象: firestore:${databaseId}`,
      '',
      'どうしても既定データベースを使う場合は、',
      `deploy/cloud-run.<env>.json の firestoreDatabaseId を "(default)" にしてください`,
      '（既存アプリのルールを引き継ぐ責任が生じます）。',
    ].join('\n'),
  );
}

info(`プロジェクト  : ${projectId}`);
info(`解決元        : ${source}`);
info(`データベース  : ${databaseId}`);
info(`メディアバケット: ${mediaBucket || '(未設定)'}`);
info(`対象          : ${only}`);
console.log(
  `  ${color.dim('※ 既定データベース (default) には触れません。既存アプリのルールは保持されます。')}`,
);

// ---------------------------------------------------------------------------
step('firebase CLI を確認');

// グローバル導入があればそれを使い、無ければ npx で一時実行する。
const hasFirebaseCli = commandExists('firebase');
const runner = hasFirebaseCli
  ? { bin: 'firebase', prefix: [] }
  : { bin: 'npx', prefix: ['--yes', 'firebase-tools'] };

if (hasFirebaseCli) {
  success('firebase CLI を使用します');
} else {
  info('firebase CLI が無いため npx --yes firebase-tools で実行します（初回は取得に時間がかかります）。');
  console.log(`  ${color.dim('常用する場合は npm install -g firebase-tools を推奨します。')}`);
}

// firebase.json の storage は target 名で対象バケットを指定している。
// どのバケットに紐づくかをここで確定させる（既存アプリのバケットに触れないため）。
if (only.includes('storage') && mediaBucket) {
  step('Storage の対象バケットを紐づけ');
  const applied = run(
    runner.bin,
    [
      ...runner.prefix,
      'target:apply',
      'storage',
      'smileq-media',
      mediaBucket,
      '--project',
      projectId,
    ],
    { capture: true, quiet: true, allowFailure: true },
  );
  if (applied.ok) {
    success(`smileq-media → ${mediaBucket}`);
  } else {
    warn('バケットの紐づけに失敗しました。Storage ルールの配信をスキップします。');
    info(`手動で紐づける場合: ${runner.bin} ${[...runner.prefix, 'target:apply', 'storage', 'smileq-media', mediaBucket].join(' ')}`);
  }
}

const deployArgs = [
  ...runner.prefix,
  'deploy',
  '--only',
  only,
  '--project',
  projectId,
  '--non-interactive',
];

if (dryRun) {
  info(color.dim('dry-run: 次のコマンドを実行します'));
  console.log(`\n  ${runner.bin} ${deployArgs.join(' ')}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
if (environment === 'production' && !skipConfirm) {
  step('本番反映の確認');
  if (!isInteractive()) {
    fatal(
      '本番の Rules 反映には確認が必要です。',
      '非対話環境（CI など）から実行する場合は --yes を付けてください:\n' +
        '  npm run rules:deploy -- production --yes',
    );
  }
  const confirmed = await confirmYesNo(
    `  本番の Firebase プロジェクト (${projectId}) へ Rules を反映します。よろしいですか？`,
  );
  if (!confirmed) {
    fatal('確認できなかったため中止しました。');
  }
  success('確認しました');
}

// ---------------------------------------------------------------------------
step('反映');

const result = run(runner.bin, deployArgs, { allowFailure: true });

if (!result.ok) {
  fatal(
    'Rules / インデックスの反映に失敗しました。',
    [
      'よくある原因:',
      '  * firebase login が済んでいない  → firebase login',
      '    （CI では GOOGLE_APPLICATION_CREDENTIALS か FIREBASE_TOKEN を使う）',
      `  * プロジェクト ID が違う         → ${projectId} を確認`,
      '  * Firestore がまだ作成されていない → docs/FIREBASE_SETUP.md §4',
      '  * ルールの構文エラー             → 上のエラー行を確認',
    ].join('\n'),
  );
}

console.log('');
success(`Rules とインデックスを反映しました: ${projectId}`);
if (only.includes('firestore:indexes')) {
  warn('複合インデックスの構築には数分かかることがあります（構築中はクエリが失敗します）。');
  info(`  進捗: https://console.firebase.google.com/project/${projectId}/firestore/indexes`);
}
console.log(`  ${color.dim('ルール自体の検証は npm run test:rules（エミュレータ）が担当します。')}`);
console.log('');
