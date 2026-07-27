import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // App.jsx's data-loading effects predate this rule (added in eslint-plugin-react-hooks v7)
      // and rely on setState-in-effect throughout. Properly fixing this means extracting that
      // logic into custom hooks, which is tracked as its own larger refactor - downgraded to a
      // warning for now so it's visible without blocking CI on pre-existing architecture.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    files: ['*.js', 'api/**/*.js', 'server/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
  },
])
