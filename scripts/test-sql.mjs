#!/usr/bin/env node
/**
 * PostgreSQL 関数のスモークテスト。
 *
 *   npm run db:test
 *   npm run db:test -- --url postgres://user:pass@host:5432/dbname
 *
 * Supabase を起動せず、素の PostgreSQL 上で
 *   Supabase 互換スタブ → 全マイグレーション → スモークテスト
 * を順に流し、状態遷移・回答登録・数値判定・集計・監査ログを検証する。
 *
 * 接続先の決定順序:
 *   1. --url / DATABASE_URL
 *   2. ローカルの PostgreSQL (postgres://postgres@localhost:5432/smileq_sqltest)
 *
 * 破壊的: 指定データベースの public / auth / realtime スキーマを作り直す。
 * 本番 DB を指定しないこと。
 */
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { commandExists, run } from './lib/proc.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repoRoot);

const { flags } = parseArgs(process.argv.slice(2));

if (!commandExists('psql')) {
  warn('psql が見つからないためスキップします。');
  info('PostgreSQL クライアントを入れると DB 関数のスモークテストを実行できます。');
  process.exit(0);
}

const url =
  (typeof flags.get('url') === 'string' ? flags.get('url') : '') ||
  process.env.DATABASE_URL ||
  'postgres://postgres@localhost:5432/smileq_sqltest';

if (/supabase\.co|\.supabase\./i.test(url) && !flags.has('force')) {
  fatal(
    'Supabase の本番／ステージング DB に対しては実行できません。',
    'このスクリプトはスキーマを作り直します。ローカルの検証用 DB を指定してください。',
  );
}

heading('DB 関数スモークテスト');
info(`接続先: ${url.replace(/\/\/[^@]*@/, '//***@')}`);

step('検証用スキーマを初期化');
const reset = run(
  'psql',
  [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-c',
    'drop schema if exists public cascade;',
    '-c',
    'create schema public;',
    '-c',
    'drop schema if exists auth cascade;',
    '-c',
    'drop schema if exists realtime cascade;',
  ],
  { capture: true, quiet: true, allowFailure: true },
);

if (!reset.ok) {
  console.error(reset.stderr);
  fatal(
    'データベースへ接続できませんでした。',
    [
      'ローカル PostgreSQL を起動し、検証用データベースを作成してください:',
      '  createdb smileq_sqltest',
      'または --url で接続先を指定してください。',
    ].join('\n'),
  );
}
success('スキーマを初期化しました');

step('Supabase 互換スタブとマイグレーションを適用');
const files = [
  'supabase/tests/_supabase_stubs.sql',
  ...readdirSync('supabase/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => `supabase/migrations/${name}`),
];

for (const file of files) {
  const result = run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });
  if (!result.ok) {
    console.error(result.stderr);
    fatal(`マイグレーションの適用に失敗しました: ${file}`);
  }
  success(file);
}

const SMOKE_TESTS = [
  { file: 'supabase/tests/functions_smoke.sql', label: 'DB 関数' },
  { file: 'supabase/tests/rls_smoke.sql', label: 'RLS' },
];

for (const { file, label } of SMOKE_TESTS) {
  step(`スモークテストを実行: ${label}`);
  const test = run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], {
    capture: true,
    quiet: true,
    allowFailure: true,
  });

  const output = `${test.stdout}\n${test.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.includes('NOTICE:') || line.includes('ERROR:'))
    .map((line) =>
      line.replace(/^.*?(NOTICE|ERROR):\s*/, (_m, kind) => (kind === 'ERROR' ? '✖ ' : '')),
    )
    .join('\n');

  console.log(output);

  if (!test.ok) {
    fatal(`${label} のスモークテストに失敗しました。`);
  }
}

console.log(`\n  ${color.green('DB 関数と RLS のスモークテストに成功しました。')}\n`);
