import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Linter } from 'eslint'
import plugin from '../dist/eslint.js'

// ESLint matches `files` patterns relative to the working directory, so
// fixtures live under the package rather than in the system temp directory.
const FIXTURE_BASE = path.join(process.cwd(), 'test', 'tmp')
mkdirSync(FIXTURE_BASE, { recursive: true })

/** A throwaway app on disk, since the rules resolve paths for real. */
const fixture = (files) => {
  const root = mkdtempSync(path.join(FIXTURE_BASE, 'app-'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@fairgarden/id' })
  )
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), contents)
  }
  return root
}

const lint = (root, file, code, rule, options = 'error') => {
  const linter = new Linter()
  return linter.verify(code, {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    plugins: { '@fairgarden/monolith': plugin },
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { [`@fairgarden/monolith/${rule}`]: options },
  }, path.join(root, file))
}

const RULE = 'no-escaping-relative-imports'

test('flags a relative import that escapes app/', () => {
  const root = fixture({ 'lib/theme.ts': '' })
  const messages = lint(
    root,
    'app/[locale]/page.tsx',
    "import x from '../../lib/theme'",
    RULE
  )
  assert.equal(messages.length, 1)
  assert.match(messages[0].message, /breaks once this app is mounted/)
  assert.match(messages[0].message, /'@fairgarden\/id\/lib\/theme'/)
})

test('flags the same escape from pages/', () => {
  const root = fixture({ 'lib/theme.ts': '' })
  const messages = lint(
    root,
    'pages/api/oidc/[...path].ts',
    "import x from '../../../lib/theme'",
    RULE
  )
  assert.equal(messages.length, 1)
})

test('allows relative imports that stay inside the route tree', () => {
  const root = fixture({})
  assert.deepEqual(
    lint(root, 'app/page.tsx', "import s from './page.module.css'", RULE),
    []
  )
  assert.deepEqual(
    lint(root, 'app/a/b/page.tsx', "import x from '../shared'", RULE),
    []
  )
})

test('allows package and bare imports', () => {
  const root = fixture({})
  assert.deepEqual(
    lint(
      root,
      'app/page.tsx',
      "import a from 'react'\nimport b from '@fairgarden/id/lib/theme'",
      RULE
    ),
    []
  )
})

test('ignores files outside a route tree', () => {
  const root = fixture({})
  assert.deepEqual(
    lint(root, 'lib/theme.ts', "import x from '../other/thing'", RULE),
    []
  )
})

test('covers src/app and src/pages', () => {
  const root = fixture({})
  assert.equal(
    lint(root, 'src/app/page.tsx', "import x from '../../lib/theme'", RULE).length,
    1
  )
})

test('flags escaping re-exports and dynamic imports', () => {
  const root = fixture({})
  assert.equal(
    lint(root, 'app/page.tsx', "export { x } from '../lib/theme'", RULE).length,
    1
  )
  assert.equal(
    lint(root, 'app/page.tsx', "const x = import('../lib/theme')", RULE).length,
    1
  )
})

test('autofixes to the package-name import', () => {
  const root = fixture({})
  const linter = new Linter()
  const { output } = linter.verifyAndFix(
    "import x from '../../lib/theme'",
    {
      files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
      plugins: { '@fairgarden/monolith': plugin },
      languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
      rules: { [`@fairgarden/monolith/${RULE}`]: 'error' },
    },
    path.join(root, 'app/[locale]/page.tsx')
  )
  assert.equal(output, "import x from '@fairgarden/id/lib/theme'")
})

test('flags next/link inside a route tree only', () => {
  const root = fixture({})
  assert.equal(
    lint(root, 'app/page.tsx', "import Link from 'next/link'", 'no-next-link').length,
    1
  )
  assert.deepEqual(
    lint(root, 'lib/nav.tsx', "import Link from 'next/link'", 'no-next-link'),
    []
  )
})

test('ships a recommended config wiring both rules', () => {
  const [config] = plugin.configs.recommended
  assert.deepEqual(Object.keys(config.rules), [
    '@fairgarden/monolith/no-escaping-relative-imports',
    '@fairgarden/monolith/no-next-link',
  ])
})
