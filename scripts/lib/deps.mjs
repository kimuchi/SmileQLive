/**
 * 依存パッケージが導入済みかを調べる。
 *
 * 未導入のまま `npm run verify` へ入ると、
 *   'eslint' は、内部コマンドまたは外部コマンドとして認識されていません。
 * のような、原因が分かりにくいエラーで止まる。
 * 先に確かめて「何を実行すればよいか」を出す。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { commandExists } from './proc.mjs';

const isWindows = process.platform === 'win32';

/** verify で実際に呼ばれる実行ファイル。1 つでも欠けたら verify は失敗する。 */
const REQUIRED_BINS = ['eslint', 'tsc', 'vitest', 'next'];

/**
 * node_modules/.bin に実行ファイルがあるか。
 * Windows では .cmd / .ps1 のラッパーになる。
 */
function binInstalled(root, name) {
  const base = join(root, 'node_modules', '.bin', name);
  return existsSync(base) || (isWindows && (existsSync(`${base}.cmd`) || existsSync(`${base}.ps1`)));
}

/**
 * 依存パッケージの導入状態を返す。
 *
 * @param {string} [root] リポジトリのルート（既定は process.cwd()）
 * @returns {{ok: boolean, installed: boolean, missing: string[], command: string, packageManager: string}}
 */
export function checkDependencies(root = process.cwd()) {
  const packageManager = preferredPackageManager(root);
  const hasPnpm = packageManager === 'pnpm' && commandExists('pnpm');

  // pnpm が入っていなければ npm install を案内する。
  // 「pnpm を先に入れてから」と案内すると手順が増えるだけで、npm でも動く。
  // （package-lock.json は .gitignore 済みなので、デプロイ前のクリーン判定を汚さない）
  const command = hasPnpm ? 'pnpm install --frozen-lockfile' : 'npm install';

  const base = { command, packageManager, usesPnpm: hasPnpm };

  if (!existsSync(join(root, 'node_modules'))) {
    return { ok: false, installed: false, missing: REQUIRED_BINS, ...base };
  }

  const missing = REQUIRED_BINS.filter((name) => !binInstalled(root, name));
  return { ok: missing.length === 0, installed: true, missing, ...base };
}

/**
 * このリポジトリが想定するパッケージマネージャ。
 * package.json の packageManager を正とする（lockfile と食い違わせないため）。
 */
function preferredPackageManager(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const declared = String(pkg.packageManager ?? '');
    if (declared.startsWith('pnpm')) return 'pnpm';
    if (declared.startsWith('yarn')) return 'yarn';
    if (declared.startsWith('npm')) return 'npm';
  } catch {
    // package.json を読めない場合は既定へ倒す。
  }
  return existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
}

/** 未導入のときに見せる手順。 */
export function installHint(result) {
  const lines = [
    result.installed
      ? `依存パッケージが不足しています: ${result.missing.join(', ')}`
      : 'node_modules がありません。依存パッケージが未導入です。',
    '',
    '次を実行してください:',
    `  ${result.command}`,
  ];

  if (result.packageManager === 'pnpm' && !result.usesPnpm) {
    lines.push(
      '',
      'このリポジトリは pnpm を前提にしています（package.json の packageManager）。',
      'npm install でも動きますが、pnpm-lock.yaml とは別の解決結果になります。',
      'pnpm を使う場合:',
      '  npm install -g pnpm',
      '  pnpm install --frozen-lockfile',
    );
  }
  return lines.join('\n');
}

export { REQUIRED_BINS };
