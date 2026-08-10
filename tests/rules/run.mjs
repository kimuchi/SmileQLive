/**
 * Firestore Security Rules 検証の入口。
 *
 * `firebase emulators:exec` の中から起動される（scripts/test-rules.mjs 参照）。
 * このファイル自身は「エミュレータへつなぎ、tests/rules/*.test.mjs を順に実行する」だけ。
 *
 * Admin SDK（Rules を迂回する）で種データを作り、
 * 匿名サインインした素の Firebase SDK で読み書きを試す。
 * つまり **本番のクライアントとまったく同じ経路**で Rules を評価している。
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { createReporter, setupRulesContext } from './harness.mjs';

const testsDir = fileURLToPath(new URL('.', import.meta.url));

async function main() {
  console.log('=== Firestore Security Rules 検証 ===');
  console.log('firebase/firestore.rules をエミュレータへ適用した状態で読み書きを試します。');

  const entries = await readdir(testsDir);
  const testFiles = entries.filter((name) => name.endsWith('.test.mjs')).sort();

  if (testFiles.length === 0) {
    console.error('tests/rules に *.test.mjs がありません。');
    process.exitCode = 1;
    return;
  }

  const report = createReporter();
  const ctx = await setupRulesContext();

  try {
    for (const fileName of testFiles) {
      console.log(`\n--- ${fileName} ---`);
      const moduleUrl = pathToFileURL(`${testsDir}${fileName}`).href;
      const testModule = await import(moduleUrl);
      const run = testModule.default;
      if (typeof run !== 'function') {
        console.error(`  ${fileName} が default export の関数を持っていません。`);
        process.exitCode = 1;
        continue;
      }
      await run(report, ctx);
    }
  } finally {
    await ctx.dispose();
  }

  console.log('');
  console.log(`結果: ${report.passed} 件成功 / ${report.failed} 件失敗`);

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

await main();
