#!/usr/bin/env node
/**
 * Playwright の webServer から起動される薄いラッパー。
 *
 *   node scripts/e2e-server.mjs
 *
 * playwright.config.ts が `http://127.0.0.1:3100/api/health` を待つため、
 * ここでは **本番ビルドを 3100 番ポートで起動するだけ**にする。
 * （E2E は「開発サーバー特有の挙動」ではなく、配布物の挙動を検証するもの）
 *
 * 守っていること:
 * - `spawn` は必ず**配列引数**で呼び、文字列連結でコマンドを組み立てない。
 * - macOS / Linux では常に `shell: false`（Bash / PowerShell へ依存しない）。
 * - Windows の `pnpm.cmd` / `npm.cmd` は Node.js が `shell: false` で起動できない仕様のため、
 *   その場合だけ `cmd.exe` 経由にする（scripts/lib/proc.mjs の needsShell と同じ考え方）。
 *   ただし既定では **リポジトリ内の next CLI を `node` で直接起動する**ため、
 *   Windows でもシェルは不要になる。
 * - 参加トークンなどの秘匿値はこのスクリプトが扱わない（ログへ出す値が無い）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** playwright.config.ts の baseURL と必ずそろえること。 */
const port = process.env.E2E_PORT ?? '3100';
const hostname = process.env.E2E_HOSTNAME ?? '127.0.0.1';

// ---------------------------------------------------------------------------
// 事前確認: 本番ビルドがあるか
// ---------------------------------------------------------------------------
const buildIdPath = new URL('../.next/BUILD_ID', import.meta.url);

if (!existsSync(buildIdPath)) {
  console.error('本番ビルドが見つかりません（.next/BUILD_ID が無い）。');
  console.error('先にビルドしてから E2E を実行してください:');
  console.error('  pnpm build && pnpm test:e2e');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 起動コマンドの決定
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';

/**
 * Windows では pnpm / npm などの実体が .cmd バッチファイルになる。
 * Node.js は .cmd を shell: false で起動できないため、これらだけ cmd.exe 経由にする。
 */
const CMD_WRAPPED = new Set(['pnpm', 'npm', 'npx', 'yarn']);

/** Windows 用に実行ファイル名を補正する。 */
function binName(name) {
  return isWindows && CMD_WRAPPED.has(name) ? `${name}.cmd` : name;
}

/** この実行ファイルの起動に shell が必要か（Windows の .cmd ラッパーだけ true）。 */
function needsShell(name) {
  return isWindows && CMD_WRAPPED.has(name);
}

/** 実行中のパッケージマネージャを推定する。 */
function detectPackageManager() {
  const agent = process.env.npm_config_user_agent ?? '';
  if (agent.startsWith('pnpm')) return 'pnpm';
  if (agent.startsWith('yarn')) return 'yarn';
  return 'npm';
}

const nextCli = new URL('../node_modules/next/dist/bin/next', import.meta.url);

let command;
let args;
let useShell;

if (existsSync(nextCli)) {
  // 既定の経路。node が JS を直接起動するのでシェルは不要（Windows も同じ）。
  command = process.execPath;
  args = [fileURLToPath(nextCli), 'start', '--hostname', hostname, '--port', port];
  useShell = false;
} else {
  // node_modules の配置が異なる環境向けの退避経路。
  const packageManager = detectPackageManager();
  command = binName(packageManager);
  args =
    packageManager === 'npm'
      ? ['exec', '--', 'next', 'start', '--hostname', hostname, '--port', port]
      : ['exec', 'next', 'start', '--hostname', hostname, '--port', port];
  useShell = needsShell(packageManager);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
console.log(`E2E サーバーを起動します: http://${hostname}:${port}`);

const child = spawn(command, args, {
  stdio: 'inherit',
  // 引数は配列のまま渡し、文字列連結でコマンドを作らない。
  shell: useShell,
  cwd: repoRoot,
  env: { ...process.env, PORT: port, HOSTNAME: hostname },
});

child.on('error', (error) => {
  console.error('E2E サーバーを起動できませんでした。');
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    // 受け取ったシグナルで自分自身も終了する（Playwright の停止手順にそろえる）。
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
