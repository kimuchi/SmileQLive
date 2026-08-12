import { createInterface } from 'node:readline/promises';
import process from 'node:process';

/** 対話確認。CI や非 TTY では利用側で --yes を必須にする。 */

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}

export async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 入力が閉じた（Ctrl+D / パイプの終端）場合、rl.question の Promise は
    // 解決しないまま固まる。空回答として扱い、呼び出し側で中止できるようにする。
    const closed = new Promise((resolve) => rl.once('close', () => resolve('')));
    return (await Promise.race([rl.question(question), closed])).trim();
  } finally {
    rl.close();
  }
}

export async function confirmYesNo(question, defaultYes = false) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix}: `)).toLowerCase();
  if (answer === '') {
    return defaultYes;
  }
  return answer === 'y' || answer === 'yes';
}
