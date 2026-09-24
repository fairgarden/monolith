import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Linter } from 'eslint'
import { withMonolith, getRegisteredApps } from '../dist/index.js'
import plugin from '../dist/eslint.js'

const monolith = ({ routesAt = 'src/app' } = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'regress-'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mono' }))
  mkdirSync(path.join(root, routesAt), { recursive: true })
  writeFileSync(path.join(root, routesAt, 'page.tsx'), 'export default () => null\n')
  writeFileSync(path.join(root, routesAt, 'layout.tsx'), 'export default (p) => p\n')
  return root
}

const moduleAt = (root, at, { app = true, pages = false } = {}) => {
  const dir = path.join(root, at)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
  if (app) {
    mkdirSync(path.join(dir, 'app'), { recursive: true })
    writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default () => null\n')
  }
  if (pages) {
    mkdirSync(path.join(dir, 'pages', 'api'), { recursive: true })
    writeFileSync(path.join(dir, 'pages', 'api', 'x.ts'), 'export default () => null\n')
  }
  return dir
}

test('will not build the derived tree over the monolith\'s own routes', async () => {
  // a conventional Next layout keeps routes in app/, which is where the
  // derived tree goes — deriving over it would delete them
  const root = monolith({ routesAt: 'app' })
  moduleAt(root, 'modules/widget')

  await assert.rejects(
    withMonolith({}, { widget: { root: 'modules/widget' } }, {
      root,
      selfReference: false,
    })('phase-production-build'),
    /Move them to src\/app/
  )

  assert.deepEqual(readdirSync(path.join(root, 'app')).sort(), ['layout.tsx', 'page.tsx'])
})

test('mounts a package-sourced app with a Pages Router', async () => {
  // nothing is written into the committed pages tree for a package-sourced
  // app, so syncing from it would read a directory that was never created
  const root = monolith()
  const pkg = path.join(root, 'node_modules', '@acme', 'widget')
  mkdirSync(path.join(pkg, 'app'), { recursive: true })
  mkdirSync(path.join(pkg, 'pages', 'api'), { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
  writeFileSync(path.join(pkg, 'app', 'page.tsx'), 'export default () => null\n')
  writeFileSync(path.join(pkg, 'pages', 'api', 'x.ts'), 'export default () => null\n')

  await assert.doesNotReject(
    withMonolith({}, { widget: { package: '@acme/widget' } }, {
      root,
      selfReference: false,
    })('phase-production-build')
  )
  assert.ok(existsSync(path.join(root, 'pages', 'api', 'widget', 'x.ts')))
})

test('falls back to the package when the checkout has only a Pages Router', async () => {
  // a pages-only checkout is not something resolveApps can mount, so it must
  // not win over the package offered alongside it
  const root = monolith()
  moduleAt(root, 'modules/widget', { app: false, pages: true })

  const pkg = path.join(root, 'node_modules', '@acme', 'widget')
  mkdirSync(path.join(pkg, 'app'), { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
  writeFileSync(path.join(pkg, 'app', 'page.tsx'), 'export default () => null\n')

  await withMonolith({}, {
    widget: { root: 'modules/widget', package: '@acme/widget' },
  }, { root, selfReference: false })('phase-production-build')

  assert.equal(getRegisteredApps()[0].source, 'package')
})

const lint = (root, file, code) => {
  const linter = new Linter()
  return linter.verify(code, {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    plugins: { '@fairgarden/monolith': plugin },
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { '@fairgarden/monolith/no-escaping-relative-imports': 'error' },
  }, path.join(root, file))
}

// ESLint matches `files` patterns relative to the working directory, so these
// fixtures live under the package rather than the system temp directory.
const LINT_BASE = path.join(process.cwd(), 'test', 'tmp')
mkdirSync(LINT_BASE, { recursive: true })

const linted = () => {
  const root = mkdtempSync(path.join(LINT_BASE, 'lint-regress-'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
  return root
}

test('offers no fix for an import that climbs out of the package', () => {
  // '@acme/widget/../../outside' would be worse than what it replaced
  const [message] = lint(linted(), 'app/page.tsx', "import x from '../../../outside/util'")
  assert.match(message.message, /breaks once this app is mounted/)
  assert.equal(message.fix, undefined)
  assert.doesNotMatch(message.message, /Use '/)
})

test('still offers a fix for one that stays inside the package', () => {
  const [message] = lint(linted(), 'app/page.tsx', "import x from '../lib/util'")
  assert.ok(message.fix)
  assert.match(message.message, /'@acme\/widget\/lib\/util'/)
})

test('flags an escaping require, not only import', () => {
  const messages = lint(linted(), 'app/page.tsx', "const x = require('../lib/util')")
  assert.equal(messages.length, 1)
  assert.match(messages[0].message, /breaks once this app is mounted/)
})

test('survives the repeat config evaluation Next does on every build', async () => {
  // Next reloads the config in its build worker, so a derived tree written by
  // the first run must not look like the monolith's own routes to the second.
  const root = monolith()
  const pkg = path.join(root, 'node_modules', '@acme', 'widget')
  mkdirSync(path.join(pkg, 'app'), { recursive: true })
  mkdirSync(path.join(pkg, 'pages', 'api'), { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
  writeFileSync(path.join(pkg, 'app', 'page.tsx'), 'export default () => null\n')
  writeFileSync(path.join(pkg, 'pages', 'api', 'x.ts'), 'export default () => null\n')

  const config = withMonolith({}, { widget: { package: '@acme/widget' } }, {
    root,
    selfReference: false,
  })

  for (const run of [1, 2, 3]) {
    await assert.doesNotReject(config('phase-production-build'), `run ${run}`)
  }
})

test('a workspace-linked package is the checkout, not an installed copy', async () => {
  // resolving through node_modules does not make it a package: a workspace
  // link points at the checkout, which belongs in the committed tree
  const root = monolith()
  const checkout = moduleAt(root, 'modules/widget')
  const link = path.join(root, 'node_modules', '@acme')
  mkdirSync(link, { recursive: true })
  symlinkSync(checkout, path.join(link, 'widget'), 'dir')

  await withMonolith({}, { widget: { package: '@acme/widget' } }, {
    root,
    selfReference: false,
  })('phase-production-build')

  assert.equal(getRegisteredApps()[0].source, 'path')
})

test('reports app config it cannot merge instead of dropping it', async () => {
  const root = monolith()
  moduleAt(root, 'modules/widget')

  await assert.rejects(
    withMonolith({}, {
      widget: { root: 'modules/widget', nextConfig: { images: { unoptimized: true } } },
    }, { root, selfReference: false })('phase-production-build'),
    /images, which a monolith cannot merge/
  )
})

test('asks for serverExternalPackages to be moved to the monolith', async () => {
  const root = monolith()
  moduleAt(root, 'modules/widget')

  await assert.rejects(
    withMonolith({ serverExternalPackages: ['a'] }, {
      widget: { root: 'modules/widget', nextConfig: { serverExternalPackages: ['a', 'x'] } },
    }, { root, selfReference: false })('phase-production-build'),
    /serverExternalPackages to include \["x"\], which the monolith does not/
  )
})

test('accepts serverExternalPackages the monolith already carries', async () => {
  const root = monolith()
  moduleAt(root, 'modules/widget')

  await assert.doesNotReject(
    withMonolith({ serverExternalPackages: ['x', 'y'] }, {
      widget: { root: 'modules/widget', nextConfig: { serverExternalPackages: ['x'] } },
    }, { root, selfReference: false })('phase-production-build')
  )
})

test('accepts an app whose config is only routing', async () => {
  const root = monolith()
  moduleAt(root, 'modules/widget')
  await assert.doesNotReject(
    withMonolith({}, {
      widget: { root: 'modules/widget', nextConfig: { rewrites: async () => [] } },
    }, { root, selfReference: false })('phase-production-build')
  )
})

test('serves an app at the site root alongside prefixed ones', async () => {
  const root = monolith()
  // the root app supplies the layout and page, so the monolith has none
  rmSync(path.join(root, 'src/app/page.tsx'))
  rmSync(path.join(root, 'src/app/layout.tsx'))

  const www = moduleAt(root, 'modules/www')
  mkdirSync(path.join(www, 'app', 'about'), { recursive: true })
  writeFileSync(path.join(www, 'app', 'about', 'page.tsx'), 'export default () => null\n')
  writeFileSync(path.join(www, 'app', 'layout.tsx'), 'export default (p) => p\n')
  moduleAt(root, 'modules/id')

  await withMonolith({}, {
    www: { root: 'modules/www', prefix: '/' },
    id: { root: 'modules/id' },
  }, { root, selfReference: false })('phase-production-build')

  const tree = path.join(root, 'src', 'app')
  // the root app's entries sit alongside, the prefixed one gets a directory
  assert.ok(existsSync(path.join(tree, 'page.tsx')))
  assert.ok(existsSync(path.join(tree, 'about')))
  assert.ok(existsSync(path.join(tree, 'id')))
  assert.ok(!existsSync(path.join(tree, 'www')))
})

test('leaves a root app\'s paths unprefixed', async () => {
  const { prefixPath } = await import('../dist/routes.js')
  assert.equal(prefixPath('/', ''), '/')
  assert.equal(prefixPath('/about', ''), '/about')
  assert.equal(prefixPath('/about', '/id'), '/id/about')
})

test('refuses to overwrite the monolith\'s own files from the root', async () => {
  const root = monolith() // keeps its own page.tsx and layout.tsx
  const www = moduleAt(root, 'modules/www')
  writeFileSync(path.join(www, 'app', 'layout.tsx'), 'export default (p) => p\n')

  await assert.rejects(
    withMonolith({}, { www: { root: 'modules/www', prefix: '/' } }, {
      root,
      selfReference: false,
    })('phase-production-build'),
    /serves src\/app\/(page|layout)\.tsx \(routes\), which the monolith already has/
  )
})

test('allows only one app at the site root', async () => {
  const root = monolith()
  rmSync(path.join(root, 'src/app/page.tsx'))
  rmSync(path.join(root, 'src/app/layout.tsx'))
  moduleAt(root, 'modules/www')
  moduleAt(root, 'modules/other')

  await assert.rejects(
    withMonolith({}, {
      www: { root: 'modules/www', prefix: '/' },
      other: { root: 'modules/other', prefix: '/' },
    }, { root, selfReference: false })('phase-production-build'),
    /Only one app can be served at the site root/
  )
})

test('refuses a mount that would take over one of the monolith\'s own routes', async () => {
  const root = monolith()
  mkdirSync(path.join(root, 'src/app/id'), { recursive: true })
  writeFileSync(path.join(root, 'src/app/id/page.tsx'), 'export default () => null\n')
  moduleAt(root, 'modules/id')

  await assert.rejects(
    withMonolith({}, { id: { root: 'modules/id' } }, { root, selfReference: false })(
      'phase-production-build'
    ),
    /"id" serves src\/app\/id \(routes\), which the monolith already has/
  )

  // and it is still the monolith's
  assert.ok(existsSync(path.join(root, 'src/app/id/page.tsx')))
})

test('refuses two apps that serve the same path', async () => {
  const root = monolith()
  rmSync(path.join(root, 'src/app/page.tsx'))
  rmSync(path.join(root, 'src/app/layout.tsx'))

  const www = moduleAt(root, 'modules/www')
  mkdirSync(path.join(www, 'app', 'id'), { recursive: true })
  writeFileSync(path.join(www, 'app', 'id', 'page.tsx'), 'export default () => null\n')
  moduleAt(root, 'modules/id')

  await assert.rejects(
    withMonolith({}, {
      www: { root: 'modules/www', prefix: '/' },
      id: { root: 'modules/id' },
    }, { root, selfReference: false })('phase-production-build'),
    (error) => {
      assert.match(error.message, /both serve src\/app\/id/)
      assert.match(error.message, /deploy the apps separately/)
      return true
    }
  )
})

test('says nothing when the apps do not overlap', async () => {
  const root = monolith()
  rmSync(path.join(root, 'src/app/page.tsx'))
  rmSync(path.join(root, 'src/app/layout.tsx'))

  const www = moduleAt(root, 'modules/www')
  mkdirSync(path.join(www, 'app', 'about'), { recursive: true })
  writeFileSync(path.join(www, 'app', 'about', 'page.tsx'), 'export default () => null\n')
  moduleAt(root, 'modules/id')

  await assert.doesNotReject(
    withMonolith({}, {
      www: { root: 'modules/www', prefix: '/' },
      id: { root: 'modules/id' },
    }, { root, selfReference: false })('phase-production-build')
  )
})

test('does not mistake its own previous run for a collision', async () => {
  const root = monolith()
  moduleAt(root, 'modules/id')
  const config = withMonolith({}, { id: { root: 'modules/id' } }, {
    root,
    selfReference: false,
  })
  for (const run of [1, 2, 3]) {
    await assert.doesNotReject(config('phase-production-build'), `run ${run}`)
  }
})
