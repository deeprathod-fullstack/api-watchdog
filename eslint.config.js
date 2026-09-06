import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
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
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Between them these two projects include every TypeScript file in the
        // repo � Node source and tests in the first, the browser app in the
        // second � so every file gets type information.
        project: ['./tsconfig.test.json', './apps/web/tsconfig.json'],
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

  // The web app runs in a browser, not in Node.
  //
  // The React Hooks rules go here too. `rules-of-hooks` catches a conditional
  // or nested hook call, which corrupts hook state in ways that surface as a
  // confusing runtime error far from the cause; `exhaustive-deps` catches the
  // stale-closure bugs that come from an incomplete dependency array. Neither
  // is expressible as a type, so ESLint is the only place to catch them.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Plain JS config files need no type-aware rules.
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
