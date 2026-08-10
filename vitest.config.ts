import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // ドメイン層のテストは Node API を、コンポーネントテストは DOM を使うため
    // jsdom を既定にする（jsdom 環境でも node: 組み込みモジュールは利用できる）。
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/domain/**', 'src/lib/**', 'src/application/**'],
      exclude: ['**/*.d.ts', 'src/lib/audio/**'],
    },
  },
});
