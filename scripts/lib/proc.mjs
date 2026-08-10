import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { color, redactArg } from './log.mjs';

/**
 * 子プロセス実行の共通処理。
 *
 * - 必ず配列引数で呼び、文字列連結でコマンドを組み立てない。
 * - macOS / Linux は常に shell: false（Bash / PowerShell へ依存しない）。
 *   Windows の .cmd ラッパー（gcloud / pnpm など）だけは、Node.js が
 *   .cmd を直接起動できない仕様のため cmd.exe 経由で起動する。
 * - Windows では実行ファイル名へ .cmd を付ける必要があるものを吸収する。
 */

const isWindows = process.platform === 'win32';

/**
 * Windows では gcloud / pnpm / npm などの実体が .cmd バッチファイルになる。
 * Node.js は .cmd / .bat を shell: false で起動できない仕様のため、
 * これらだけは cmd.exe 経由で起動する必要がある。
 */
const CMD_WRAPPED = new Set(['gcloud', 'pnpm', 'npm', 'npx', 'yarn', 'firebase']);

/** Windows 用に実行ファイル名を補正する。 */
export function binName(name) {
  if (!isWindows) {
    return name;
  }
  return CMD_WRAPPED.has(name) ? `${name}.cmd` : name;
}

/**
 * この実行ファイルの起動に cmd.exe を挟む必要があるか。
 * Windows の .cmd ラッパーだけ true になる。
 */
function needsShell(name) {
  return isWindows && CMD_WRAPPED.has(name);
}

/**
 * cmd.exe へ渡す引数を安全に引用する。
 *
 * `shell: true` + 引数配列は Node.js が引数を**連結するだけでエスケープしない**ため、
 * 空白を含む引数（例: "SmileQ Live"）が複数の引数へ割れてしまう
 * （Node 22 以降は DEP0190 として警告も出る）。
 * そのため自前で引用し、`cmd /d /s /c "..."` へ verbatim で渡す。
 */
function quoteForCmd(value) {
  const text = String(value);
  if (text.length === 0) {
    return '""';
  }
  // 引用が不要な安全な文字だけなら、そのまま渡す。
  if (!/[\s"&|<>^()%!,;=]/.test(text)) {
    return text;
  }
  // 閉じ引用符の直前のバックスラッシュは倍にする必要がある（Windows の引数解析規則）。
  const escaped = text
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Windows で .cmd を起動するための spawnSync 引数を組み立てる。
 * `cmd /d /s /c "<引用済みコマンド>"` の形にし、windowsVerbatimArguments で
 * Node 側の再解釈を止める（Node 自身の shell:true 実装と同じ方式）。
 */
function buildWindowsInvocation(resolved, args) {
  const commandLine = [resolved, ...args].map(quoteForCmd).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: { windowsVerbatimArguments: true, shell: false },
  };
}

/**
 * コマンドが「このスクリプトから実際に起動できるか」を調べる。
 *
 * デプロイ本体は必ず shell: false で呼ぶため、存在確認も shell: false で行う。
 * ただしそれで失敗した場合だけ、原因の切り分けのためにシェル経由でも試す。
 * （PATH がシェル初期化ファイルでしか設定されていない、エイリアス／シェル関数として
 *   定義されている、Windows で拡張子付きの実体が無い、などを区別するため）
 *
 * @returns {{ok: boolean, via: 'direct'|'shell-only'|'missing', detail: string, version: string}}
 */
export function probeCommand(name) {
  const resolved = binName(name);

  const probe = needsShell(name)
    ? buildWindowsInvocation(resolved, ['--version'])
    : { file: resolved, args: ['--version'], options: { shell: false } };

  const direct = spawnSync(probe.file, probe.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...probe.options,
    timeout: 30_000,
  });

  const firstLine = (text) => String(text ?? '').split(/\r?\n/)[0]?.trim() ?? '';

  if (!direct.error && direct.status === 0) {
    return { ok: true, via: 'direct', detail: '', version: firstLine(direct.stdout) };
  }

  // ここから先は診断目的のみ。実際のデプロイ処理をシェル経由で実行することはない。
  const viaShell = spawnSync(`${name} --version`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: true,
    timeout: 30_000,
  });

  if (!viaShell.error && viaShell.status === 0) {
    return {
      ok: false,
      via: 'shell-only',
      detail:
        `シェル経由では見つかりますが、直接起動できません（${resolved}）。` +
        'エイリアスやシェル関数ではなく、実行ファイルが PATH に含まれているか確認してください。' +
        (isWindows ? ' Windows では gcloud.cmd が PATH にある必要があります。' : ''),
      version: firstLine(viaShell.stdout),
    };
  }

  const reason = direct.error
    ? `${direct.error.code ?? direct.error.message}`
    : direct.status === null
      ? 'タイムアウト'
      : `終了コード ${direct.status}`;

  const stderr = firstLine(direct.stderr);

  return {
    ok: false,
    via: 'missing',
    detail: `${resolved} を起動できません（${reason}）${stderr ? `: ${stderr}` : ''}`,
    version: '',
  };
}

export function commandExists(name) {
  return probeCommand(name).ok;
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

  // Windows の .cmd ラッパーだけ cmd.exe 経由。引数は自前で引用する
  // （shell: true は引数をエスケープせず連結するため、空白を含む値が壊れる）。
  const invocation = needsShell(name)
    ? buildWindowsInvocation(binName(name), args)
    : { file: binName(name), args, options: { shell: false } };

  const result = spawnSync(invocation.file, invocation.args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    ...invocation.options,
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
