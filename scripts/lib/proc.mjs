import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { color, redactArg } from './log.mjs';

/**
 * 子プロセス実行の共通処理。
 *
 * - 必ず配列引数 + shell: false で呼ぶ（Bash / PowerShell へ依存しない）。
 * - Windows では実行ファイル名へ .cmd を付ける必要があるものを吸収する。
 */

const isWindows = process.platform === 'win32';

/** Windows 用に実行ファイル名を補正する。 */
export function binName(name) {
  if (!isWindows) {
    return name;
  }
  const cmdWrapped = new Set(['gcloud', 'pnpm', 'npm', 'npx', 'yarn', 'supabase']);
  return cmdWrapped.has(name) ? `${name}.cmd` : name;
}

export function commandExists(name) {
  const probe = spawnSync(binName(name), ['--version'], { stdio: 'ignore', shell: false });
  return !probe.error && probe.status === 0;
}

/**
 * @param {string} name        実行ファイル名 (例 'gcloud')
 * @param {string[]} args      引数配列
 * @param {object} options
 * @param {boolean} [options.capture]  stdout を文字列で受け取る
 * @param {boolean} [options.quiet]    実行コマンドを表示しない
 * @param {boolean} [options.allowFailure] 失敗しても例外を投げず結果を返す
 * @param {string[]} [options.secrets] 表示時に伏せる文字列
 * @param {string} [options.cwd]
 * @param {Record<string,string>} [options.env]
 */
export function run(name, args, options = {}) {
  const {
    capture = false,
    quiet = false,
    allowFailure = false,
    secrets = [],
    cwd,
    env,
  } = options;

  if (!quiet) {
    const printable = args.map((a) => redactArg(a, secrets)).join(' ');
    console.log(`    ${color.dim(`$ ${name} ${printable}`)}`);
  }

  const result = spawnSync(binName(name), args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    shell: false,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });

  if (result.error) {
    if (allowFailure) {
      return { ok: false, status: null, stdout: '', stderr: String(result.error) };
    }
    throw new Error(`コマンドを実行できませんでした: ${name} (${result.error.message})`);
  }

  const stdout = capture ? (result.stdout ?? '').trim() : '';
  const stderr = capture ? (result.stderr ?? '').trim() : '';

  if (result.status !== 0) {
    if (capture && stderr && !quiet) {
      console.error(stderr);
    }
    if (allowFailure) {
      return { ok: false, status: result.status, stdout, stderr };
    }
    throw new Error(`コマンドが失敗しました (exit ${result.status}): ${name} ${args[0] ?? ''}`);
  }

  return { ok: true, status: 0, stdout, stderr };
}

export function runCapture(name, args, options = {}) {
  return run(name, args, { ...options, capture: true }).stdout;
}

/** 実行中のパッケージマネージャを推定する（npm run deploy / pnpm deploy の両方に対応）。 */
export function detectPackageManager() {
  const agent = process.env.npm_config_user_agent ?? '';
  if (agent.startsWith('pnpm')) return 'pnpm';
  if (agent.startsWith('yarn')) return 'yarn';
  if (agent.startsWith('npm')) return 'npm';
  if (commandExists('pnpm')) return 'pnpm';
  return 'npm';
}

/** package.json の script を、呼び出し元と同じパッケージマネージャで実行する。 */
export function runPackageScript(scriptName, options = {}) {
  const pm = detectPackageManager();
  const args = pm === 'yarn' ? [scriptName] : ['run', scriptName];
  return run(pm, args, options);
}
