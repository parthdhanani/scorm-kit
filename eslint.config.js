const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    // Node.js CLI + library code (the default for this package)
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Dead-code signal: flag unused vars/imports. Allow _-prefixed throwaways
      // and unused catch bindings (intentional error-swallow is configured below).
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Empty blocks are a smell, but an intentional empty catch is allowed.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Cosmetic redundant regex escapes — visible but non-blocking. Left as
      // warnings so security-relevant regexes aren't mechanically rewritten.
      'no-useless-escape': 'warn',
    },
  },
  {
    // Browser-side code (RUM beacon runtime + mock-LMS web harness) — runs in
    // the learner's browser, so it legitimately uses window/document/localStorage.
    files: ['src/**/runtime/**/*.js', 'src/**/web/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'test/fixtures/'],
  },
];
