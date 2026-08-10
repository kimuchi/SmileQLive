#!/usr/bin/env node
/**
 * Firestore エミュレータ上でトランザクションの不変条件を検証する。
 *
 *   npm run test:emulator
 *
 * PostgreSQL 版で SQL 関数を実 DB へ適用して検証していたのと同じ役割。
 * Firestore へ移行しても次が保たれていることを、実際に書き込んで確かめる。
 *
 *   * 1 参加者・1 問につき 1 回答（決定的ドキュメントID + create）
 *   * 同時実行しても二重登録されない
 *   * stateVersion の競合検出
 *   * 締切後の回答を受け付けない
 *   * 得点集計が回答と同じトランザクションで更新される
 *
 * 必要なもの: Java（Firestore エミュレータが JVM 上で動くため）。
 * 無い場合はスキップして終了コード 0 を返す（CI を壊さない）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, success, warn } from './lib/log.mjs';
import { commandExists, detectPackageManager, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

heading('Firestore トランザクション検証（エミュレータ）');

if (!commandExists('java')) {
  warn('Java が見つからないためスキップします。');
  info('Firestore エミュレータは JVM 上で動作します。');
  info('  macOS: brew install openjdk');
  info('  Windows: https://adoptium.net/');
  process.exit(0);
}

const projectId = process.env.GCLOUD_PROJECT ?? 'smileq-live-emulator';

// firebase-tools が入っていなければ一時実行する。
const hasFirebaseCli = commandExists('firebase');
const packageManager = detectPackageManager();
const runner = hasFirebaseCli
  ? { bin: 'firebase', prefix: [] }
  : packageManager === 'pnpm'
    ? { bin: 'pnpm', prefix: ['dlx', 'firebase-tools@15'] }
    : { bin: 'npx', prefix: ['--yes', 'firebase-tools@15'] };

if (!hasFirebaseCli) {
  info(`firebase CLI が無いため ${runner.bin} 経由で実行します（初回は時間がかかります）。`);
}

const result = run(
  runner.bin,
  [
    ...runner.prefix,
    'emulators:exec',
    '--only',
    'firestore',
    '--project',
    projectId,
    'node tests/emulator/transactions.smoke.mjs',
  ],
  { allowFailure: true, env: { GCLOUD_PROJECT: projectId } },
);

if (!result.ok) {
  fatal(
    'エミュレータ上の検証に失敗しました。',
    '上の FAIL 行を確認してください。詳細は docs/FIRESTORE_MODEL.md §3 を参照。',
  );
}

console.log('');
success('トランザクションの不変条件をすべて満たしています。');
console.log(`  ${color.dim('Security Rules 自体の検証は npm run test:rules が担当します。')}`);
console.log('');
