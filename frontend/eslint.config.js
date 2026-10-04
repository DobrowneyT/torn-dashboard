/**
 * ESLint, deliberately narrow: only rules whose failure is a CRASH, not style.
 *
 * ⚠️ Why this exists. `vite build` and vitest both pass when a .jsx file uses a
 * name that is not declared — that is a runtime ReferenceError, so the bundle
 * compiles and the page explodes on render. Two production crashes on
 * 2026-10-04 were exactly that: War Payouts (`raceGroupHeaders`, a3e3b2f) and
 * Member Overview (`renderCtx`, #900). The same day turned up four tables
 * calling `useTableSort` after an early return, which throws "Rendered more
 * hooks than during the previous render" when the branch flips.
 *
 * ⚠️ Do not widen this to a recommended preset. Every rule here is at `error`
 * with ZERO standing failures; a lint run with hundreds of style warnings is
 * one nobody reads, and then these get missed too.
 */
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  { ignores: ['dist/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    // ⚠️ Off rather than an error per stale directive: the code carries
    // `eslint-disable-next-line react-hooks/exhaustive-deps` comments from
    // before there was a linter, and that rule is not enabled here.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      'react/jsx-no-undef': 'error',
      // Marks names used only in JSX as used, so `no-undef`'s scope is right.
      'react/jsx-uses-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // vitest globals (`vi`, `describe`…) are imported explicitly in this repo,
    // but test files run under node and may touch `global`.
    files: ['src/**/__tests__/**'],
    languageOptions: { globals: { ...globals.node } },
  },
]
