import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import n from 'eslint-plugin-n';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'coverage/']
  },
  js.configs.recommended,
  prettier,
  {
    files: ['**/*.js'],
    plugins: { n },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: {
      'no-async-promise-executor': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'one-var': ['error', 'never'],
      'no-nested-ternary': 'error',
      'multiline-ternary': ['error', 'never'],
      'n/no-missing-require': 'error'
    }
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node
    }
  }
];
