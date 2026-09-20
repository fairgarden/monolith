import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertCompatible } from '../dist/compat.js'

/** A directory that resolves `next` to a given version, or not at all. */
const withNext = (version) => {
  const root = mkdtempSync(path.join(tmpdir(), 'nextver-'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }))
  if (version) {
    const pkg = path.join(root, 'node_modules', 'next')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'next', version, main: 'index.js' })
    )
    writeFileSync(path.join(pkg, 'index.js'), '')
  }
  return root
}

const app = (name, version) => ({
  name,
  prefix: `/${name}`,
  root: withNext(version),
  packageName: `@scope/${name}`,
  appDir: '/tmp/app',
  publicDir: undefined,
  pagesDir: undefined,
  pagesApiDir: undefined,
  apiViaPages: false,
  nextConfig: {},
})

const check = (monolithVersion, apps) =>
  assertCompatible({}, apps, withNext(monolithVersion))

test('accepts an app on the same version', () => {
  check('16.3.5', [app('id', '16.3.5')])
})

test('accepts an app pinned to an older patch', () => {
  // The monolith compiles it, so being ahead is fine.
  check('16.3.5', [app('id', '16.3.0')])
})

test('accepts an app on an older minor', () => {
  check('16.3.5', [app('id', '16.1.0')])
})

test('rejects an app needing a newer Next than the monolith', () => {
  assert.throws(
    () => check('16.3.5', [app('id', '16.4.0')]),
    /at least as new as the newest one/
  )
})

test('rejects an app a whole major ahead', () => {
  assert.throws(
    () => check('15.3.0', [app('id', '16.0.0')]),
    /major versions have to match/
  )
})

test('rejects an app a major behind, which the monolith would miscompile', () => {
  assert.throws(
    () => check('16.3.5', [app('id', '15.3.0')]),
    /major versions have to match/
  )
})

test('names the offending app', () => {
  assert.throws(
    () => check('16.3.5', [app('id', '16.3.5'), app('membership', '16.9.0')]),
    /"membership" is built for Next 16\.9\.0/
  )
})

test('compares prereleases correctly', () => {
  // A canary is newer than the release it precedes.
  check('16.4.0-canary.1', [app('id', '16.3.5')])
  assert.throws(
    () => check('16.3.5', [app('id', '16.4.0-canary.1')]),
    /at least as new as the newest one/
  )
})

test('skips the check when a version cannot be resolved', () => {
  check('16.3.5', [app('id', undefined)])
  check(undefined, [app('id', '99.0.0')])
})

test('reports version and config problems together', () => {
  assert.throws(
    () => assertCompatible({}, [{ ...app('id', '17.0.0'), nextConfig: { basePath: '/id' } }], withNext('16.3.5')),
    (error) =>
      /major versions have to match/.test(error.message) &&
      /basePath/.test(error.message)
  )
})

test('withMonolith refuses to start on an incompatible app', async () => {
  const { withMonolith } = await import('../dist/index.js')

  const appRoot = withNext('16.9.0')
  mkdirSync(path.join(appRoot, 'app'), { recursive: true })
  writeFileSync(path.join(appRoot, 'app', 'page.tsx'), '')
  writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ name: '@scope/id' })
  )

  const monolithRoot = withNext('16.3.5')

  await assert.rejects(
    withMonolith({}, { id: { root: appRoot } }, {
      root: monolithRoot,
      selfReference: false,
    })('phase-production-build'),
    /"id" is built for Next 16\.9\.0.*at least as new as the newest one/s
  )
})
