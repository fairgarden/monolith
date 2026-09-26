import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { proxyMatcher, unservedLocaleProxies } from '../dist/proxies.js'

const LOCALE_PROXY = `import { createLocaleProxy } from '@fairgarden/indicators/proxy'
import { indicators } from './lib/indicators'

export const proxy = createLocaleProxy(indicators)
export const config = { matcher: ['/'] }
`

const dirWith = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'proxies-'))
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), source)
  }
  return root
}

const app = (name, files, prefix = `/${name}`) => ({ name, prefix, root: dirWith(files) })

const monolithProxy = (matcher) =>
  `import { createLocaleProxy } from '@fairgarden/indicators/proxy'
export const proxy = createLocaleProxy({})
export const config = { matcher: ${JSON.stringify(matcher)} }
`

test('reads a literal matcher, as Next does', () => {
  const root = dirWith({
    'proxy.ts': "export const config = { matcher: ['/id', { source: '/members' }] }\n",
    'src/proxy.ts': "export const config = { matcher: '/other' }\n",
  })
  assert.deepEqual(proxyMatcher(path.join(root, 'proxy.ts')), ['/id', '/members'])
  assert.deepEqual(proxyMatcher(path.join(root, 'src/proxy.ts')), ['/other'])
  const unmatched = dirWith({ 'proxy.ts': 'export const proxy = () => {}\n' })
  assert.equal(proxyMatcher(path.join(unmatched, 'proxy.ts')), undefined)
})

test("an app's locale proxy is served when the monolith's matches its mount", () => {
  const monolith = dirWith({ 'proxy.ts': monolithProxy(['/id']) })
  const id = app('id', { 'proxy.ts': LOCALE_PROXY })
  assert.deepEqual(unservedLocaleProxies(monolith, [id]), [])
})

test("says which app's locale proxy the monolith does not run, and where to add it", () => {
  const monolith = dirWith({ 'proxy.ts': monolithProxy(['/id']) })
  const members = app('members', { 'proxy.ts': LOCALE_PROXY })
  const [unserved, ...rest] = unservedLocaleProxies(monolith, [members])
  assert.equal(rest.length, 0)
  assert.equal(unserved.app, members)
  assert.match(unserved.message, /"members" negotiates its locale/)
  assert.match(unserved.message, /createLocaleProxy\(\{ '\/members': \.\.\. \}\)/)

  // With no proxy at all, every app's goes unserved; an app at the root is '/'.
  const bare = dirWith({ 'package.json': '{}' })
  const www = app('www', { 'proxy.ts': LOCALE_PROXY }, '')
  assert.match(unservedLocaleProxies(bare, [www])[0].message, /at \/\. /)
})

test('says nothing of apps with no locale proxy, or a monolith proxy that runs everywhere', () => {
  const monolith = dirWith({ 'proxy.ts': monolithProxy([]) })
  const plain = app('plain', { 'app/page.tsx': '' })
  const custom = app('custom', { 'proxy.ts': 'export const proxy = () => {}\n' })
  assert.deepEqual(unservedLocaleProxies(monolith, [plain, custom]), [])

  const everywhere = dirWith({ 'proxy.ts': 'export const proxy = () => {}\n' })
  const id = app('id', { 'proxy.ts': LOCALE_PROXY })
  assert.deepEqual(unservedLocaleProxies(everywhere, [id]), [])
})
