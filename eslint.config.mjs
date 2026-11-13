import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config. Deliberately not type-aware: `tsc --noEmit` is the type gate and
 * runs separately, so linting does not need to build a program (it stays fast).
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.temporal/**',
      '**/.artifacts/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      // Generated Prisma client: `prisma generate` output, never hand-edited.
      'packages/database/generated/**',
      // Frozen Phase 1 artifacts: deliberately not linted (contract §0).
      'prototype/**',
      'qa/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Structured logging only. `pino` is the logger (contract §2).
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
);
