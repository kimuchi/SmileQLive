#!/usr/bin/env node
/**
 * ビルド成果物の安全性検査。
 *
 *   npm run verify:bundle        （pnpm build のあとに実行する）
 *
 * 検査内容:
 *   1. クライアントバンドルへ Supabase Secret Key が含まれないこと
 *   2. ビルド時に環境変数の値が埋め込まれていないこと
 *      （同一イメージを staging / production で再利用するための前提）
 *   3. 参加者向けの経路へ音声処理が混入していないこと
 *   4. 参加導線にルームコード入力欄が存在しないこと
 *
 * 「書いたつもり」ではなく実際の成果物を検査するため、
 * リファクタリングで壊れたときに確実に気付ける。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';

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
step('1. Supabase Secret Key がクライアントへ含まれないこと');

// supabase-js 自身がキー種別を判定するために "sb_secret_" という
// リテラルを持っているため、プレフィックスだけの一致は許容し、
// 「実際の値らしき文字列」を検出する。
scanClient('SUPABASE_SECRET_KEY という識別子が無い', (c) => c.includes('SUPABASE_SECRET_KEY'));
scanClient('Secret Key の実値らしき文字列が無い', (c) => /sb_secret_[A-Za-z0-9_-]{8,}/.test(c));
scanClient('service_role JWT が無い', (c) => /"role"\s*:\s*"service_role"/.test(c));

// 実行時に注入した値を渡して検査したい場合（CI 用）
const secretValue = process.env.SUPABASE_SECRET_KEY;
if (secretValue && secretValue.length >= 12) {
  scanClient('注入された Secret Key の実値が無い', (c) => c.includes(secretValue));
} else {
  info(color.dim('SUPABASE_SECRET_KEY 未設定のため、実値との照合はスキップしました。'));
}

// ---------------------------------------------------------------------------
step('2. ビルド時に環境変数が埋め込まれていないこと');

// NEXT_PUBLIC_* を使っていない = 同じイメージを staging / production で使い回せる。
scanClient('NEXT_PUBLIC_SUPABASE_* が埋め込まれていない', (c) =>
  c.includes('NEXT_PUBLIC_SUPABASE'),
);

const publishableValue = process.env.SUPABASE_PUBLISHABLE_KEY;
if (publishableValue && publishableValue.length >= 12) {
  scanClient(
    'Publishable Key がビルド時に焼き込まれていない（実行時に渡す）',
    (c) => c.includes(publishableValue),
  );
}

// ---------------------------------------------------------------------------
step('3. 参加者経路へ音声処理が混入していないこと');

// 投影画面 (present) のチャンクだけが音声を持ってよい。
// クライアントチャンクは名前から画面を特定できないため、
// サーバー側の参加者ページの成果物を検査する。
const participantServerFiles = collectFiles(SERVER_DIR, ['.js']).filter(
  (file) => file.includes('/play/') || file.includes('/j/') || file.includes('participant'),
);

if (participantServerFiles.length === 0) {
  warn('参加者ページの成果物が見つかりませんでした（未実装の可能性）。');
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

const joinServerFiles = collectFiles(SERVER_DIR, ['.js']).filter(
  (file) => file.includes('/j/') || file.includes('/play/'),
);

if (joinServerFiles.length === 0) {
  warn('参加ページの成果物が見つかりませんでした（未実装の可能性）。');
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
