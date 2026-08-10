import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * ESLint フラット設定。
 *
 * 重要な独自ルール:
 *   効果音モジュール (src/lib/audio/**) を、投影画面以外から import させない。
 *   参加者画面へ音声処理が混入することを静的に防ぐ（§32.4）。
 */
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
      'public/**',
    ],
  },

  ...coreWebVitals,
  ...nextTypescript,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
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
              group: ['@/lib/audio', '@/lib/audio/*', '**/lib/audio/*'],
              message:
                '効果音モジュールは投影画面 (src/app/present, src/components/presentation) からのみ利用できます。参加者画面・共通レイアウトへ音声処理を混入させないでください。',
            },
          ],
        },
      ],
    },
  },

  {
    // 投影画面と音声モジュール自身だけが音声を扱える。
    files: ['src/app/present/**', 'src/components/presentation/**', 'src/lib/audio/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs', '*.mjs', '*.config.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];

export default eslintConfig;
