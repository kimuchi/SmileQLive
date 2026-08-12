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
 *   --only       対象を絞る（既定: firestore:<database>,storage）
 *   --allow-default-bucket  Firebase 既定バケットへの配信を許可（既定では拒否）
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Storage も同様に、設定ファイルの mediaBucket で指定した専用バケットだけを対象にする
 * （配信直前に一時設定へ実バケット名を書き出し、--config で渡す）。
 */
function defaultTargets(databaseId) {
  return `firestore:${databaseId},storage`;
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

// Storage も同じ理由で、Firebase 既定バケットを対象にしたら止める。
// 既定バケットは既存アプリが使っている可能性が高く、ルールを上書きしてしまう。
const defaultBuckets = [`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`];
if (
  mediaBucket &&
  defaultBuckets.includes(mediaBucket) &&
  /(^|,)storage(:|,|$)/.test(only) &&
  !flags.has('allow-default-bucket')
) {
  fatal(
    `Firebase 既定バケット (${mediaBucket}) へ Storage ルールを配信しようとしています。`,
    [
      'SmileQ Live は画像用の専用バケットを使います。',
      '既定バケットへ配信すると、同じプロジェクトに同居している',
      '既存アプリの Storage ルールを上書きしてしまいます。',
      '',
      `正しい設定: "mediaBucket": "${projectId}-smileq-media"`,
      '  npm run firebase:config   … 専用バケット名を設定ファイルへ書き込む',
      '  npm run gcp:bootstrap     … そのバケットを作成する',
      '',
      'Firestore のルールだけ先に反映する場合:',
      `  npm run rules:deploy -- --only firestore:${databaseId}`,
      '',
      '既定バケットを使うと分かったうえで実行する場合のみ:',
      '  npm run rules:deploy -- --allow-default-bucket',
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
  : { bin: 'npx', prefix: ['--yes', 'firebase-tools@15'] };

if (hasFirebaseCli) {
  success('firebase CLI を使用します');
} else {
  info('firebase CLI が無いため npx --yes firebase-tools@15 で実行します（初回は取得に時間がかかります）。');
  console.log(`  ${color.dim('常用する場合は npm install -g firebase-tools を推奨します。')}`);
}

/** ログインし直すコマンド（このスクリプトが使う実行方法に合わせる）。 */
const reauthCommand = `${runner.bin} ${[...runner.prefix, 'login', '--reauth'].join(' ')}`;

/** 認証切れかどうか。文言は firebase CLI が出すもの。 */
function isAuthExpired(text) {
  return (
    /credentials are no longer valid/i.test(text) ||
    /Authentication Error/i.test(text) ||
    /Failed to authenticate/i.test(text) ||
    /No authorized accounts/i.test(text)
  );
}

function fatalAuthExpired() {
  fatal(
    'firebase CLI の認証が切れています。',
    [
      'ログインし直してから、もう一度実行してください:',
      `  ${reauthCommand}`,
      '',
      'ブラウザを開けない環境では:',
      `  ${runner.bin} ${[...runner.prefix, 'login', '--reauth', '--no-localhost'].join(' ')}`,
      '',
      'CI では GOOGLE_APPLICATION_CREDENTIALS か FIREBASE_TOKEN を使います。',
    ].join('\n'),
  );
}

// 認証は本番確認より前に確かめる。
// 「本番へ反映しますか？」に答えたあとで認証切れに気付くのは手戻りが大きい。
step('ログイン状態を確認');
{
  const loginCheck = run(runner.bin, [...runner.prefix, 'login:list'], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  const output = `${loginCheck.stdout ?? ''}\n${loginCheck.stderr ?? ''}`;
  if (!loginCheck.ok || isAuthExpired(output)) {
    fatalAuthExpired();
  }
  success(output.split(/\r?\n/).find((line) => line.includes('@'))?.trim() ?? 'ログイン済み');
}

// firebase.json の storage.bucket はプレースホルダのまま置いてある。
// 誤って手動 `firebase deploy` を実行しても既存アプリのバケットへ当たらないようにするため。
// ここで実際のバケット名と対象データベースを入れた一時設定を書き出し、--config で渡す。
step('配信用の一時設定を生成');

/**
 * 一時設定は**リポジトリ直下**へ置く。
 *
 * firebase CLI は --config を渡すと、そのファイルのあるディレクトリを
 * プロジェクトルートとみなし、rules / indexes の相対パスをそこから解決する
 * （firebase-tools の detectProjectRoot）。
 * 例えば .firebase/ へ置くと firebase/storage.rules を
 * .firebase/firebase/storage.rules として探しに行き、
 * 「Error reading rules file」で失敗する。
 * `../` で戻すこともできない（Config.path がプロジェクト外のパスを拒否する）。
 * firebase.json と同じ場所に置けば、相対パスはそのまま通る。
 */
const generatedConfigPath = '.smileq-deploy.json';
{
  const base = JSON.parse(readFileSync('firebase.json', 'utf8'));
  const generated = {
    firestore: [
      {
        database: databaseId,
        rules: 'firebase/firestore.rules',
        indexes: 'firebase/firestore.indexes.json',
      },
    ],
    ...(mediaBucket
      ? { storage: [{ bucket: mediaBucket, rules: 'firebase/storage.rules' }] }
      : {}),
    ...(base.emulators ? { emulators: base.emulators } : {}),
  };

  writeFileSync(generatedConfigPath, `${JSON.stringify(generated, null, 2)}\n`);
  success(`${generatedConfigPath} を生成しました`);
  info(`Firestore: ${databaseId} / Storage: ${mediaBucket || '(対象なし)'}`);

  // 生成した設定が指すファイルが本当に読めるかを、配信前に確かめる。
  // ここで落としておけば、認証や API を通ったあとで初めて失敗することがない。
  const referenced = [
    'firebase/firestore.rules',
    'firebase/firestore.indexes.json',
    ...(mediaBucket ? ['firebase/storage.rules'] : []),
  ];
  const unreadable = referenced.filter((file) => !existsSync(file));
  if (unreadable.length > 0) {
    fatal(
      `一時設定が参照するファイルを読めません: ${unreadable.join(', ')}`,
      [
        `${generatedConfigPath} からの相対パスとして解決されます。`,
        'リポジトリのルートで実行しているか確認してください。',
      ].join('\n'),
    );
  }
}

const deployArgs = [
  ...runner.prefix,
  'deploy',
  '--only',
  only,
  '--project',
  projectId,
  '--config',
  generatedConfigPath,
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
  // Enter で進める（デプロイ側の確認と揃える）。省くには --yes。
  const confirmed = await confirmYesNo(
    `  本番の Firebase プロジェクト (${projectId}) へ Rules を反映します。続けますか？`,
    true,
  );
  if (!confirmed) {
    fatal('中止しました。');
  }
}

// ---------------------------------------------------------------------------
step('反映');

const result = run(runner.bin, deployArgs, { allowFailure: true });

if (!result.ok) {
  // 反映中に期限が切れることもあるため、ここでも認証切れを見分ける。
  if (isAuthExpired(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    fatalAuthExpired();
  }
  fatal(
    'Rules / インデックスの反映に失敗しました。',
    [
      'よくある原因:',
      `  * 認証が切れている               → ${reauthCommand}`,
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
