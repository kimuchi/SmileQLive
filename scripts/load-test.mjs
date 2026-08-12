#!/usr/bin/env node
/**
 * 会場規模（既定 500 人）の負荷検証。
 *
 *   npm run load:test
 *   npm run load:test -- --participants 1000
 *
 * Firestore エミュレータを起こし、実際のトランザクション
 * （参加登録・回答登録・ランキング取得）へ同時に人数ぶんの要求をぶつける。
 *
 * 見ているのは「1 ドキュメントへの集中」。会場では次が同時に起きる。
 *
 *   1. 開場直後に全員が二次元コードを読む → 参加登録が一斉に走る
 *   2. 出題ごとに全員が同時に回答する     → 回答登録が一斉に走る
 *   3. 正解発表で全員の画面が更新される   → ランキング取得が一斉に走る
 *
 * 必要なもの: Java（Firestore エミュレータが JVM 上で動くため）。
 * 無い場合はスキップして終了コード 0 を返す（CI を壊さない）。
 *
 * Windows / macOS / Linux で同じコマンドで動く。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, success, warn } from './lib/log.mjs';
import { commandExists, detectPackageManager, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

heading('会場規模の負荷検証（エミュレータ）');

const args = process.argv.slice(2);
const participantsIndex = args.findIndex((arg) => arg === '--participants' || arg === '-n');
const participants =
  participantsIndex >= 0 ? Number(args[participantsIndex + 1] ?? '500') : Number(process.env.LOAD_PARTICIPANTS ?? 500);

if (!Number.isInteger(participants) || participants < 2 || participants > 5000) {
  fatal('--participants には 2〜5000 の整数を指定してください。');
}

if (!commandExists('java')) {
  warn('Java が見つからないためスキップします。');
  info('Firestore エミュレータは JVM 上で動作します。');
  info('  macOS: brew install openjdk');
  info('  Windows: https://adoptium.net/');
  process.exit(0);
}

info(`参加者 ${participants} 人で確かめます。`);
info('参加登録・回答登録・ランキング取得を、それぞれ人数ぶん同時に走らせます。');
console.log('');

const projectId = process.env.GCLOUD_PROJECT ?? 'smileq-live-emulator';

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
    'npx vitest run --config vitest.load.config.ts',
  ],
  {
    allowFailure: true,
    env: { GCLOUD_PROJECT: projectId, LOAD_PARTICIPANTS: String(participants) },
  },
);

if (!result.ok) {
  fatal(
    `${participants} 人の同時アクセスに耐えられませんでした。`,
    '上の失敗内容を確認してください。詳細は docs/OPERATIONS.md「同時接続の目安」を参照。',
  );
}

console.log('');
success(`${participants} 人が同時に来ても、登録・回答を取りこぼさないことを確認しました。`);
console.log(
  `  ${color.dim('人数を変えて試す: npm run load:test -- --participants 1000')}`,
);
console.log('');
