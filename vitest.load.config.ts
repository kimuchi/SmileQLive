import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * 会場規模の負荷検証だけを走らせる設定。
 *
 *   npm run load:test
 *
 * 普段の `npm test` からは外してある。数百件の同時書き込みを行うため
 * 時間がかかり、Firestore エミュレータも要るため。
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/load/**/*.test.ts'],
    // 同じルームを使い回すので、ファイル同士を並べて走らせない。
    fileParallelism: false,
    // 何が起きているかを数字で見せるのが目的なので、ログを隠さない。
    disableConsoleIntercept: true,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
