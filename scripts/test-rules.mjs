#!/usr/bin/env node
/**
 * Firestore Security Rules を **実際のエミュレータ上で**検証する。
 *
 *   node scripts/test-rules.mjs
 *
 * `firebase/firestore.rules` は「万一クライアントが直接 Firestore を叩いても
 * 正解が 1 件も漏れない」ための最終防壁。ここが崩れると、
 * アプリ側の実装がどれだけ正しくても会場で正解が先に見えてしまう。
 * したがってルール本体を「机上で読む」のではなく、毎回エミュレータへ適用して確かめる。
 *
 * 検証内容（tests/rules/security-rules.test.mjs）:
 *   * 匿名参加者が rooms/{id}（quizSnapshot = 正解）を読めない
 *   * 匿名参加者が quizzes/** と questions/**（正解・解説）を読めない
 *   * 匿名参加者が rooms/{id}/public/state を読める
 *   * 匿名参加者が rooms/{id}/staff/progress を読めない
 *   * 参加者は自分の members / answers だけ読める
 *   * 司会者は自分のルーム・クイズだけ読める
 *   * あらゆるロールからの書き込みがすべて拒否される
 *
 * 必要なもの:
 *   * Java            … Firestore / Auth エミュレータは JVM 上で動く
 *   * firebase-tools  … エミュレータの起動に使う（`npm install -g firebase-tools`）
 *
 * firebase-tools が未導入なら pnpm dlx / npx で一時実行を試みる。
 * **それも用意できない環境（Java 無し・オフライン）では、
 * 理由を明示して終了コード 0 でスキップ**する。エミュレータが無いだけで
 * CI を赤くしないため。
 *
 * なお、この検証のために依存パッケージは 1 つも追加していない
 * （@firebase/rules-unit-testing は使わず、素の firebase / firebase-admin だけで検証する）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, success, warn } from './lib/log.mjs';
import { commandExists, detectPackageManager, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

heading('Firestore Security Rules 検証（エミュレータ）');

// ---------------------------------------------------------------------------
// 前提の確認。足りなければ「何が必要か」を示してスキップする。
// ---------------------------------------------------------------------------
if (!commandExists('java')) {
  warn('Java が見つからないためスキップします。');
  info('Firebase エミュレータは JVM 上で動作します。');
  info('  macOS:   brew install openjdk');
  info('  Windows: https://adoptium.net/');
  info('  Linux:   sudo apt install default-jre');
  process.exit(0);
}

// firebase CLI が入っていなければ、パッケージマネージャの一時実行で代替する。
// （常にスキップしてしまうと検証の意味が無いため）
const hasFirebaseCli = commandExists('firebase');
const packageManager = detectPackageManager();
const cliRunner = hasFirebaseCli
  ? { bin: 'firebase', prefix: [] }
  : packageManager === 'pnpm'
    ? { bin: 'pnpm', prefix: ['dlx', 'firebase-tools@15'] }
    : { bin: 'npx', prefix: ['--yes', 'firebase-tools@15'] };

if (!hasFirebaseCli) {
  info(
    `firebase CLI が無いため ${cliRunner.bin} 経由で実行します（初回は取得に時間がかかります）。`,
  );
  console.log(`  ${color.dim('常用する場合は npm install -g firebase-tools を推奨します。')}`);

  // 一時実行はネットワークから firebase-tools を取得する。
  // 取得できない環境（オフラインの CI など）では **検証失敗と区別できない**ため、
  // 先に「起動できるか」だけを確かめ、駄目ならスキップして終了コード 0 を返す。
  // ここを素通りさせると、エミュレータが無いだけで CI が赤くなってしまう。
  const probe = run(cliRunner.bin, [...cliRunner.prefix, '--version'], {
    allowFailure: true,
    capture: true,
    quiet: true,
  });

  if (!probe.ok) {
    warn('firebase-tools を取得できなかったためスキップします。');
    info('この検証には Firebase エミュレータが必要です。');
    info('  npm install -g firebase-tools');
    info('導入後にもう一度実行してください:');
    info('  node scripts/test-rules.mjs');
    process.exit(0);
  }

  info(`firebase-tools ${probe.stdout.split(/\r?\n/)[0] ?? ''} を使います。`);
}

// ---------------------------------------------------------------------------
// エミュレータを起動して検証スクリプトを走らせる
// ---------------------------------------------------------------------------
const projectId = process.env.GCLOUD_PROJECT ?? 'smileq-live-emulator';

info(`プロジェクト: ${projectId}`);
info('firestore / auth エミュレータを起動します（Rules は firebase.json の設定から読まれます）。');

// auth も起動する。Rules の request.auth を本物の ID トークンで評価するため、
// 各ロールを Auth エミュレータで匿名サインインさせる。
const result = run(
  cliRunner.bin,
  [
    ...cliRunner.prefix,
    'emulators:exec',
    '--only',
    'firestore,auth',
    '--project',
    projectId,
    'node tests/rules/run.mjs',
  ],
  { allowFailure: true, env: { GCLOUD_PROJECT: projectId } },
);

if (!result.ok) {
  fatal(
    'Security Rules の検証に失敗しました。',
    '上の NG 行を確認してください。' +
      ' firebase/firestore.rules と docs/FIRESTORE_MODEL.md §4 の対応表を突き合わせること。',
  );
}

console.log('');
success('Security Rules はすべての検証を満たしています。');
console.log(`  ${color.dim('トランザクションの不変条件は npm run test:emulator が担当します。')}`);
console.log('');
