import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'],
  },

  js.configs.recommended,

  // Type-aware linting. This is what makes rules like `no-floating-promises`
  // possible: without type information ESLint cannot know a call returns a
  // promise, and an unawaited promise here means a silently lost check result.
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // tsconfig.test.json includes both src and test files, so every
        // TypeScript file in the repo gets type information.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Plain JS config files need no type-aware rules.
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
