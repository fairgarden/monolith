import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withMonolith, getRegisteredApps } from '../dist/index.js'

/** A monolith with a checkout at `modules/widget` and a package of the same name. */
const fixture = ({ checkoutHasRoutes, packageHasRoutes }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fallback-'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mono' }))

  const checkout = path.join(root, 'modules', 'widget')
  mkdirSync(checkout, { recursive: true })
  writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
  if (checkoutHasRoutes) mkdirSync(path.join(checkout, 'app'), { recursive: true })

  if (packageHasRoutes !== undefined) {
    const pkg = path.join(root, 'node_modules', '@acme', 'widget')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/widget' }))
    if (packageHasRoutes) mkdirSync(path.join(pkg, 'app'), { recursive: true })
  }

  return root
}

const mount = async (root, app) => {
  await withMonolith({}, { widget: app }, { root, selfReference: false })(
    'phase-production-build'
  )
  return getRegisteredApps()[0]
}

test('uses the checkout when its routes are there', async () => {
  const root = fixture({ checkoutHasRoutes: true, packageHasRoutes: true })
  const app = await mount(root, { root: 'modules/widget', package: '@acme/widget' })
  assert.equal(app.source, 'path')
  assert.match(app.appDir, /modules\/widget\/app$/)
})

test('falls back to the package when the checkout is empty', async () => {
  // which is what a build host leaves behind when it cannot clone a submodule
  const root = fixture({ checkoutHasRoutes: false, packageHasRoutes: true })
  const app = await mount(root, { root: 'modules/widget', package: '@acme/widget' })
  assert.equal(app.source, 'package')
  assert.match(app.appDir, /node_modules\/@acme\/widget\/app$/)
})

test('falls back when the checkout directory is missing entirely', async () => {
  const root = fixture({ checkoutHasRoutes: false, packageHasRoutes: true })
  rmSync(path.join(root, 'modules'), { recursive: true, force: true })
  const app = await mount(root, { root: 'modules/widget', package: '@acme/widget' })
  assert.equal(app.source, 'package')
})

test('still uses a lone path when no package is offered', async () => {
  const root = fixture({ checkoutHasRoutes: true })
  const app = await mount(root, { root: 'modules/widget' })
  assert.equal(app.source, 'path')
})

test('names both places when neither has routes', async () => {
  const root = fixture({ checkoutHasRoutes: false, packageHasRoutes: false })
  await assert.rejects(
    mount(root, { root: 'modules/widget', package: '@acme/widget' }),
    (error) =>
      /no routes directory/.test(error.message) &&
      /path .*modules\/widget/.test(error.message) &&
      /package .*node_modules/.test(error.message) &&
      /submodule that was never cloned/.test(error.message)
  )
})

test('reports the package that could not be resolved at all', async () => {
  const root = fixture({ checkoutHasRoutes: false })
  await assert.rejects(
    mount(root, { package: '@acme/missing' }),
    /Is it a dependency of the monolith\?/
  )
})
