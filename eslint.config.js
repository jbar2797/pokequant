import tsPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts','test/**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn', 'log'] }],
      '@typescript-eslint/consistent-type-imports': 'warn'
    }
  }
];
