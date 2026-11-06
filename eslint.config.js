const eslint = require('@eslint/js')
const tseslint = require('typescript-eslint')
const figmaPlugin = require('@figma/eslint-plugin-figma-plugins')
// globals is not a direct devDependency; it is installed transitively via eslint.
const globals = require('globals')

module.exports = tseslint.config(
  eslint.configs.recommended,
  // @typescript-eslint/recommended-type-checked is too aggressive for
  // widget code...it doesn't seem to like JSX element return values or
  // unbundling the `widget` object for use* hooks. So we'll use
  // tseslint.configs.recommended instead.
  tseslint.configs.recommended,
  {
    plugins: {
      '@figma/figma-plugins': figmaPlugin,
    },
    rules: {
      ...figmaPlugin.configs.recommended.rules,
      // allow underscore-prefixing of unused variables
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Node.js server (ESM, per server/package.json "type": "module").
  {
    files: ['server/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // Node.js tests (CommonJS: require() and 'use strict').
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    ignores: ['code.js', 'dist', 'eslint.config.js'],
  },
)
