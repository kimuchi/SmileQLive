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

/**
 * 指定の語句を正確に入力させる確認（本番デプロイ用）。
 *
 * `[production]` のような角括弧は「Enter で既定値」と読めてしまうため使わない。
 * また、ここへ来るまでに lint / typecheck / test / build を通っており
 * 数分かかっている。打ち間違いで全部やり直しにならないよう、数回まで受け付ける。
 * 空入力は明示的な中止として扱う。
 */
export async function confirmExact(question, expected, attempts = 3) {
  console.log(question);
  for (let remaining = attempts; remaining > 0; remaining -= 1) {
    const answer = await ask(`  続けるには ${expected} と入力してください（中止は Enter）: `);
    if (answer === expected) {
      return true;
    }
    if (answer === '') {
      return false;
    }
    if (remaining > 1) {
      console.log(`  入力が一致しません。残り ${remaining - 1} 回。`);
    }
  }
  return false;
}

export async function confirmYesNo(question, defaultYes = false) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix}: `)).toLowerCase();
  if (answer === '') {
    return defaultYes;
  }
  return answer === 'y' || answer === 'yes';
}
