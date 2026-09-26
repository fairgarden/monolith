import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findPortabilityProblems } from '../dist/portability.js'

const appWith = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'portability-'))
  for (const file of files) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), '')
  }
  return root
}

const matching = (problems, needle) =>
  problems.filter((problem) => problem.includes(needle))

test('accepts an app with nothing in the way', () => {
  assert.deepEqual(findPortabilityProblems({}, appWith(['app/page.tsx'])), [])
})

test('flags config the monolith owns', () => {
  const problems = findPortabilityProblems({ basePath: '/id' }, appWith([]))
  assert.equal(matching(problems, 'basePath').length, 1)
})

test('flags config that has to be shared', () => {
  const problems = findPortabilityProblems({ trailingSlash: true }, appWith([]))
  assert.equal(matching(problems, 'trailingSlash').length, 1)
})

test('flags a proxy, which a deployment can only have one of', () => {
  const problems = findPortabilityProblems({}, appWith(['proxy.ts']))
  assert.equal(matching(problems, 'proxy.ts').length, 1)
})

const LOCALE_PROXY = `import { createLocaleProxy } from '@fairgarden/indicators/proxy'
import { indicators } from '@acme/id/lib/indicators'

export const proxy = createLocaleProxy(indicators)
export const config = { matcher: ['/'] }
`

const appWithProxy = (source) => {
  const root = appWith([])
  writeFileSync(path.join(root, 'proxy.ts'), source)
  return root
}

test("accepts a proxy that is only the locale proxy, which the monolith's runs for it", () => {
  assert.deepEqual(findPortabilityProblems({}, appWithProxy(LOCALE_PROXY)), [])
  const renamed = LOCALE_PROXY.replace('{ createLocaleProxy }', '{ createLocaleProxy as locales }')
    .replace('= createLocaleProxy(', '= locales(')
  assert.deepEqual(findPortabilityProblems({}, appWithProxy(renamed)), [])
})

test('flags a locale proxy with anything more to it', () => {
  const wrapped = LOCALE_PROXY.replace(
    'export const proxy = createLocaleProxy(indicators)',
    'const locales = createLocaleProxy(indicators)\nexport const proxy = (request) => locales(request)'
  )
  const extra = `${LOCALE_PROXY}export const runtime = 'nodejs'\n`
  for (const source of [wrapped, extra]) {
    const problems = findPortabilityProblems({}, appWithProxy(source))
    assert.equal(matching(problems, 'proxy.ts').length, 1)
  }
})

test('flags middleware under src/ too', () => {
  const problems = findPortabilityProblems({}, appWith(['src/middleware.js']))
  assert.equal(matching(problems, 'middleware').length, 1)
})

test('flags the Pages Router singletons', () => {
  const problems = findPortabilityProblems(
    {},
    appWith(['pages/_app.tsx', 'pages/_document.tsx'])
  )
  assert.equal(matching(problems, '_app').length, 1)
  assert.equal(matching(problems, '_document').length, 1)
})

test('flags routes that only mean anything at the site root', () => {
  const problems = findPortabilityProblems({}, appWith(['app/robots.ts']))
  assert.equal(matching(problems, 'robots').length, 1)
})

test('does not flag ordinary routes', () => {
  const problems = findPortabilityProblems(
    {},
    appWith(['app/page.tsx', 'app/about/page.tsx', 'pages/api/thing.ts'])
  )
  assert.deepEqual(problems, [])
})
