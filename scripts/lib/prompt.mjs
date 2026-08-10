import { createInterface } from 'node:readline/promises';
import process from 'node:process';

/** 対話確認。CI や非 TTY では利用側で --yes を必須にする。 */

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}

export async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 指定の語句を正確に入力させる確認（本番デプロイ用）。 */
export async function confirmExact(question, expected) {
  const answer = await ask(`${question}\n  入力してください [${expected}]: `);
  return answer === expected;
}

export async function confirmYesNo(question, defaultYes = false) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix}: `)).toLowerCase();
  if (answer === '') {
    return defaultYes;
  }
  return answer === 'y' || answer === 'yes';
}
