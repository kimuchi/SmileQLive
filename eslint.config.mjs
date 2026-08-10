import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      'supabase/.temp/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/audio/*', '@/lib/audio'],
              message:
                '効果音モジュールは投影画面 (src/components/presentation, src/app/present) からのみ動的 import すること。',
            },
          ],
        },
      ],
    },
  },
  {
    // 投影画面だけが音声モジュールを利用できる。
    files: ['src/components/presentation/**', 'src/app/present/**', 'src/lib/audio/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];

export default eslintConfig;
