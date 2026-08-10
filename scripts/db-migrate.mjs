#!/usr/bin/env node
/**
 * Supabase のマイグレーション適用ヘルパー。
 *
 *   npm run db:migrate -- --local          … ローカル (supabase start) へ適用
 *   npm run db:migrate -- --project-ref xxx … リンク済みリモートへ push
 *   npm run db:migrate -- --status          … 適用状況を表示
 *
 * Supabase CLI をそのまま使うのが基本だが、OS を問わず同じコマンドで呼べるようにする。
 * 本番 DB を管理画面から手動変更しないこと（必ずマイグレーションを残す）。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { parseArgs } from './lib/config.mjs';
import { fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { commandExists, run } from './lib/proc.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { flags } = parseArgs(process.argv.slice(2));

heading('Supabase マイグレーション');

const hasSupabaseCli = commandExists('supabase');
const supabaseArgs = (args) => (hasSupabaseCli ? { bin: 'supabase', args } : { bin: 'pnpm', args: ['dlx', 'supabase', ...args] });

if (!hasSupabaseCli) {
  warn('supabase CLI が見つからないため pnpm dlx supabase を使用します（初回は時間がかかります）。');
  info('常用する場合は https://supabase.com/docs/guides/local-development/cli/getting-started を参照。');
}

if (flags.has('status')) {
  step('適用状況');
  const { bin, args } = supabaseArgs(['migration', 'list']);
  run(bin, args, { allowFailure: true });
  process.exit(0);
}

if (flags.has('local')) {
  step('ローカル DB へ適用');
  const { bin, args } = supabaseArgs(['db', 'reset']);
  run(bin, args);
  success('ローカル DB を初期化してマイグレーションを適用しました');
  process.exit(0);
}

const projectRef = typeof flags.get('project-ref') === 'string' ? flags.get('project-ref') : '';

if (projectRef) {
  step(`リモートプロジェクトへリンク: ${projectRef}`);
  const link = supabaseArgs(['link', '--project-ref', projectRef]);
  run(link.bin, link.args, { allowFailure: true });
}

step('リモート DB へ push');
info('後方互換のあるマイグレーションから順に適用してください（docs/SUPABASE_SETUP.md）。');
const push = supabaseArgs(['db', 'push']);
const result = run(push.bin, push.args, { allowFailure: true });

if (!result.ok) {
  fatal(
    'マイグレーションの適用に失敗しました。',
    [
      '確認事項:',
      '  * supabase link --project-ref <ref> でリンク済みか',
      '  * DB パスワードが正しいか',
      '  * 破壊的変更の場合はバックアップとロールバック手順を用意したか',
    ].join('\n'),
  );
}

success('マイグレーションを適用しました');
