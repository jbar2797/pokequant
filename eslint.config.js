import tsPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import * as internal from './scripts/eslint-plugin-internal.js';

export default [
  {
    files: ['src/**/*.ts','test/**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { '@typescript-eslint': tsPlugin, internal },
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn', 'log'] }],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'internal/no-raw-error-literal': 'error'
    }
  }
];
