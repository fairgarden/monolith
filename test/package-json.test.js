import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { routeImports, mergeAppDependencies } from '../dist/package-json.js'

const appFixture = (files, pkg = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'deps-'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@fairgarden/id', ...pkg })
  )
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), contents)
  }
  return {
    name: 'id',
    prefix: '/id',
    root,
    packageName: '@fairgarden/id',
    appDir: path.join(root, 'app'),
    publicDir: undefined,
    pagesDir: files['pages/api/x.ts'] ? path.join(root, 'pages') : undefined,
    pagesApiDir: undefined,
    apiViaPages: false,
    nextConfig: {},
  }
}

test('collects direct imports from both route trees', async () => {
  const app = appFixture({
    'app/page.tsx': "import c from 'classnames'\nimport './page.css'",
    'pages/api/x.ts': "import Provider from 'oidc-provider'",
  })
  const found = await routeImports(app)
  assert.deepEqual([...found].sort(), ['classnames', 'oidc-provider'])
})

test('ignores relative imports and node builtins', async () => {
  const app = appFixture({
    'app/page.tsx': "import a from './x'\nimport b from 'node:path'\nimport c from 'fs'",
  })
  assert.deepEqual([...(await routeImports(app))], [])
})

test("ignores the app's own package, which resolves through the app", async () => {
  const app = appFixture({
    'app/page.tsx': "import t from '@fairgarden/id/lib/theme'",
  })
  assert.deepEqual([...(await routeImports(app))], [])
})

test('reduces a subpath import to its package', async () => {
  const app = appFixture({
    'app/page.tsx':
      "import B from '@scope/design/components/Button'\nimport x from 'lodash/get'",
  })
  assert.deepEqual([...(await routeImports(app))].sort(), ['@scope/design', 'lodash'])
})

test('finds require and dynamic import too', async () => {
  const app = appFixture({
    'app/page.tsx': "const a = require('alpha')\nconst b = import('beta')",
  })
  assert.deepEqual([...(await routeImports(app))].sort(), ['alpha', 'beta'])
})

test('does not descend into node_modules', async () => {
  const app = appFixture({
    'app/page.tsx': "import a from 'alpha'",
    'app/node_modules/pkg/index.js': "import b from 'beta'",
  })
  assert.deepEqual([...(await routeImports(app))], ['alpha'])
})

const monolithFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mono-'))
  const file = path.join(root, 'package.json')
  writeFileSync(
    file,
    JSON.stringify({ name: 'monolith', dependencies: { next: '16.0.0' } })
  )
  return file
}

test('merges only what the routes import, with their type packages', async () => {
  const app = appFixture(
    { 'app/page.tsx': "import c from 'classnames'" },
    {
      dependencies: { classnames: '^2.5.1', negotiator: '^1.1.0' },
      devDependencies: { '@types/classnames': '^2.0.0', eslint: '^9.0.0' },
    }
  )
  const { packageJson, changed } = await mergeAppDependencies(
    monolithFixture(),
    [app]
  )

  assert.equal(changed, true)
  assert.equal(packageJson.dependencies.classnames, '^2.5.1')
  assert.equal(packageJson.devDependencies['@types/classnames'], '^2.0.0')
  // Only the unmounted proxy uses this, and eslint is the app's own tooling.
  assert.equal(packageJson.dependencies.negotiator, undefined)
  assert.equal(packageJson.devDependencies?.eslint, undefined)
})

test('takes everything with all', async () => {
  const app = appFixture(
    { 'app/page.tsx': '' },
    { dependencies: { negotiator: '^1.1.0' } }
  )
  const { packageJson } = await mergeAppDependencies(monolithFixture(), [app], {
    all: true,
  })
  assert.equal(packageJson.dependencies.negotiator, '^1.1.0')
})

test('skips workspace and link ranges, which are not installable', async () => {
  const app = appFixture(
    { 'app/page.tsx': "import d from '@scope/design'" },
    { dependencies: { '@scope/design': 'workspace:*' } }
  )
  const { packageJson, changed } = await mergeAppDependencies(
    monolithFixture(),
    [app]
  )
  assert.equal(changed, false)
  assert.equal(packageJson.dependencies['@scope/design'], undefined)
})

test('reports no change when the monolith already has everything', async () => {
  const app = appFixture(
    { 'app/page.tsx': "import n from 'next'" },
    { dependencies: { next: '16.0.0' } }
  )
  const { changed } = await mergeAppDependencies(monolithFixture(), [app])
  assert.equal(changed, false)
})
