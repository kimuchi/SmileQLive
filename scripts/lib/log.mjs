import process from 'node:process';

/**
 * デプロイスクリプト共通のログ出力。
 * OS 依存のシェル機能を使わず、Node.js だけで完結させる。
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);

export const color = {
  dim: (t) => paint('2', t),
  bold: (t) => paint('1', t),
  red: (t) => paint('31', t),
  green: (t) => paint('32', t),
  yellow: (t) => paint('33', t),
  blue: (t) => paint('36', t),
};

let stepNumber = 0;

export function step(message) {
  stepNumber += 1;
  console.log(`\n${color.blue(`[${stepNumber}]`)} ${color.bold(message)}`);
}

export function info(message) {
  console.log(`    ${message}`);
}

export function success(message) {
  console.log(`    ${color.green('✔')} ${message}`);
}

export function warn(message) {
  console.warn(`    ${color.yellow('▲')} ${message}`);
}

export function fail(message) {
  console.error(`\n${color.red('✖')} ${message}`);
}

export function fatal(message, hint) {
  fail(message);
  if (hint) {
    console.error(`\n${color.dim('ヒント:')} ${hint}`);
  }
  process.exit(1);
}

/**
 * ログへ出す前に秘匿値を伏せる。
 * Secret Manager の値そのものはスクリプトが読まないが、
 * Publishable Key やトークン様の文字列は念のため伏せる。
 */
export function redactArg(value, secrets = []) {
  let out = String(value);
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

export function heading(title) {
  const line = '='.repeat(Math.max(8, title.length + 4));
  console.log(`\n${color.dim(line)}\n  ${color.bold(title)}\n${color.dim(line)}`);
}
