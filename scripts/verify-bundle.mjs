#!/usr/bin/env node
/**
 * ビルド成果物の安全性検査。
 *
 *   npm run verify:bundle        （pnpm build のあとに実行する）
 *
 * 検査内容:
 *   1. クライアントバンドルへ Firebase のサービスアカウント秘密鍵が含まれないこと
 *   2. ビルド時に環境変数の値が埋め込まれていないこと
 *      （同一イメージを staging / production で再利用するための前提）
 *   3. 参加者向けの経路へ音声処理が混入していないこと
 *   4. 参加導線にルームコード入力欄が存在しないこと
 *
 * 「書いたつもり」ではなく実際の成果物を検査するため、
 * リファクタリングで壊れたときに確実に気付ける。
 *
 * なお `FIREBASE_API_KEY` は**秘密情報ではない**（公開前提の識別子。
 * docs/FIRESTORE_MODEL.md §6）ため、クライアントに含まれていても問題ない。
 * ここで守るのは「サーバーだけが持つべき鍵」と「ビルド時埋め込みをしないこと」の 2 点。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, step, success } from './lib/log.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const STATIC_DIR = '.next/static';
const SERVER_DIR = '.next/server';

if (!existsSync(STATIC_DIR)) {
  fatal(
    'ビルド成果物が見つかりません。',
    '先に本番ビルドを実行してください:\n  npm run build',
  );
}

heading('ビルド成果物の安全性検査');

const failures = [];

function collectFiles(dir, extensions) {
  const out = [];
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => full.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * パス区切りを `/` へ揃える。
 *
 * Windows では join が `\` を返すため、`/play/` のような判定が必ず外れる。
 * 検査が「対象なし」で素通りし、成果物を見ていないのに成功と表示されていた。
 */
function toPosix(path) {
  return path.replace(/\\/g, '/');
}

/** ルート（/j/ や /play/）に対応する成果物を選ぶ。 */
function filesForRoutes(files, routes) {
  return files.filter((file) => {
    const path = toPosix(file);
    return routes.some((route) => path.includes(route));
  });
}

const clientFiles = collectFiles(STATIC_DIR, ['.js', '.mjs']);
info(`クライアントチャンク: ${clientFiles.length} 件`);

function scanClient(label, matcher, { allow = () => false } = {}) {
  const hits = [];
  for (const file of clientFiles) {
    const content = readFileSync(file, 'utf8');
    if (matcher(content) && !allow(content, file)) {
      hits.push(file);
    }
  }
  if (hits.length === 0) {
    success(label);
    return true;
  }
  failures.push(`${label} — 該当: ${hits.join(', ')}`);
  console.error(`    ${color.red('✖')} ${label}`);
  for (const hit of hits.slice(0, 5)) {
    console.error(`        ${hit}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
step('1. Firebase のサービスアカウント秘密鍵がクライアントへ含まれないこと');

// Cloud Run では ADC を使うため、そもそもリポジトリにも実行環境にも秘密鍵は存在しない。
// 「うっかり鍵ファイルを import した」事故を、実際の成果物で検出する。
scanClient('PEM 形式の秘密鍵が無い', (c) => c.includes('-----BEGIN PRIVATE KEY-----'));
scanClient('RSA 秘密鍵が無い', (c) => c.includes('-----BEGIN RSA PRIVATE KEY-----'));
scanClient('サービスアカウント JSON の private_key が無い', (c) =>
  /"private_key"\s*:\s*"/.test(c),
);
scanClient('サービスアカウント JSON の client_email が無い', (c) =>
  /"client_email"\s*:\s*"[^"]+@[^"]+\.iam\.gserviceaccount\.com"/.test(c),
);
scanClient('FIREBASE_SERVICE_ACCOUNT_JSON という識別子が無い', (c) =>
  c.includes('FIREBASE_SERVICE_ACCOUNT_JSON'),
);
scanClient('GOOGLE_APPLICATION_CREDENTIALS という識別子が無い', (c) =>
  c.includes('GOOGLE_APPLICATION_CREDENTIALS'),
);

// 実行時に注入した値を渡して検査したい場合（CI 用）
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (serviceAccountJson && serviceAccountJson.length >= 32) {
  scanClient('注入されたサービスアカウント JSON の実値が無い', (c) =>
    c.includes(serviceAccountJson),
  );
} else {
  info(
    color.dim(
      'FIREBASE_SERVICE_ACCOUNT_JSON 未設定のため、実値との照合はスキップしました（Cloud Run では ADC を使うため通常は未設定）。',
    ),
  );
}

// ---------------------------------------------------------------------------
step('2. ビルド時に環境変数が埋め込まれていないこと');

// NEXT_PUBLIC_* を使っていない = 同じイメージを staging / production で使い回せる。
// Firebase の公開設定は RuntimeConfig（Server Component がリクエスト時に読む）から渡す。
scanClient('NEXT_PUBLIC_FIREBASE_* が埋め込まれていない', (c) => c.includes('NEXT_PUBLIC_FIREBASE'));

// 実行時に渡すべき値がビルド時に焼き込まれていないことを、実値でも確かめる（CI 用）。
for (const name of ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_AUTH_DOMAIN']) {
  const value = process.env[name];
  if (value && value.length >= 12) {
    scanClient(`${name} の実値が焼き込まれていない（実行時に渡す）`, (c) => c.includes(value));
  }
}

// ---------------------------------------------------------------------------
step('3. 参加者経路へ音声処理が混入していないこと');

// 投影画面 (present) のチャンクだけが音声を持ってよい。
// クライアントチャンクは名前から画面を特定できないため、
// サーバー側の参加者ページの成果物を検査する。
const participantServerFiles = filesForRoutes(collectFiles(SERVER_DIR, ['.js']), [
  '/play/',
  '/j/',
  'participant',
]);

if (participantServerFiles.length === 0) {
  // 参加者ページは必ず存在する。0 件は「安全」ではなく「検査できていない」。
  failures.push('参加者ページの成果物が見つからず、音声処理の有無を検査できませんでした');
  console.error(`    ${color.red('✖')} 参加者ページの成果物が見つかりません（検査できていません）`);
  console.error(`        探索先: ${SERVER_DIR}`);
} else {
  const audioHits = participantServerFiles.filter((file) => {
    const content = readFileSync(file, 'utf8');
    return (
      /new\s+AudioContext|webkitAudioContext|decodeAudioData|navigator\.vibrate/.test(content) ||
      /projector-audio-manager/.test(content)
    );
  });
  if (audioHits.length === 0) {
    success(`参加者ページ ${participantServerFiles.length} 件に音声処理が無い`);
  } else {
    failures.push(`参加者ページへ音声処理が混入 — ${audioHits.join(', ')}`);
    console.error(`    ${color.red('✖')} 参加者ページへ音声処理が混入しています`);
    for (const hit of audioHits) {
      console.error(`        ${hit}`);
    }
  }
}

// ---------------------------------------------------------------------------
step('4. 参加導線にルームコード入力欄が無いこと');

const joinServerFiles = filesForRoutes(collectFiles(SERVER_DIR, ['.js']), ['/j/', '/play/']);

if (joinServerFiles.length === 0) {
  // 同上。二次元コード参加は仕様の中心なので、見ていないまま通してはいけない。
  failures.push('参加ページの成果物が見つからず、ルームコード入力の有無を検査できませんでした');
  console.error(`    ${color.red('✖')} 参加ページの成果物が見つかりません（検査できていません）`);
  console.error(`        探索先: ${SERVER_DIR}`);
} else {
  const codeInputHits = joinServerFiles.filter((file) => {
    const content = readFileSync(file, 'utf8');
    return /roomCode|room_code|ルームコード|参加コード|コードを入力/.test(content);
  });
  if (codeInputHits.length === 0) {
    success(`参加ページ ${joinServerFiles.length} 件にルームコード入力が無い`);
  } else {
    failures.push(`参加導線にルームコード入力の痕跡 — ${codeInputHits.join(', ')}`);
    console.error(`    ${color.red('✖')} 参加導線にルームコード入力の痕跡があります`);
    for (const hit of codeInputHits) {
      console.error(`        ${hit}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length > 0) {
  fatal(
    `${failures.length} 件の問題が見つかりました。`,
    failures.join('\n') + '\n\n詳細は docs/ARCHITECTURE.md の「正解を漏らさないための設計」を参照。',
  );
}

console.log(`  ${color.green('ビルド成果物の安全性検査に成功しました。')}\n`);
