#!/usr/bin/env node
/**
 * ローカルで本番ビルドを起動する。
 *
 * Cloud Run 上では Dockerfile の `node server.js` (standalone) が使われるため、
 * このスクリプトはローカル確認専用。
 * PORT は Cloud Run が注入する値を尊重し、無い場合だけ 3000 を使う。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.PORT || '3000';
const hostname = process.env.HOSTNAME || '0.0.0.0';

const standaloneServer = new URL('../.next/standalone/server.js', import.meta.url);

let command;
let args;

if (existsSync(standaloneServer)) {
  // standalone 出力があればそれを使う（本番と同じ起動経路）。
  command = process.execPath;
  args = [fileURLToPath(standaloneServer)];
} else {
  const agent = process.env.npm_config_user_agent ?? '';
  const pm = agent.startsWith('pnpm') ? 'pnpm' : agent.startsWith('yarn') ? 'yarn' : 'npm';
  const bin = process.platform === 'win32' ? `${pm}.cmd` : pm;
  command = bin;
  args =
    pm === 'npm'
      ? ['exec', '--', 'next', 'start', '--hostname', hostname, '--port', port]
      : ['exec', 'next', 'start', '--hostname', hostname, '--port', port];
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: false,
  cwd: repoRoot,
  env: { ...process.env, PORT: port, HOSTNAME: hostname },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
