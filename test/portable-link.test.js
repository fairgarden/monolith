import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prefixHref } from '../dist/mounts.js'

test('leaves hrefs alone when the app is not mounted', () => {
  assert.equal(prefixHref('/a/b', ''), '/a/b')
})

test('moves app-relative hrefs under the mount', () => {
  assert.equal(prefixHref('/a/b', '/id'), '/id/a/b')
})

test("maps the app's root to the mount itself, as basePath does", () => {
  assert.equal(prefixHref('/', '/id'), '/id')
  assert.equal(prefixHref('/?error=expired', '/id'), '/id?error=expired')
  assert.equal(prefixHref('/#referrals', '/id'), '/id#referrals')
  assert.deepEqual(prefixHref({ pathname: '/' }, '/id'), { pathname: '/id' })
})

test('leaves absolute and protocol-relative URLs alone', () => {
  assert.equal(prefixHref('https://example.com/a', '/id'), 'https://example.com/a')
  assert.equal(prefixHref('//example.com/a', '/id'), '//example.com/a')
})

test('leaves fragments and relative hrefs alone', () => {
  assert.equal(prefixHref('#section', '/id'), '#section')
  assert.equal(prefixHref('login', '/id'), 'login')
})

test('does not prefix twice', () => {
  assert.equal(prefixHref('/id/a/b', '/id'), '/id/a/b')
  assert.equal(prefixHref('/id', '/id'), '/id')
  assert.equal(prefixHref('/id?x=1', '/id'), '/id?x=1')
  assert.equal(prefixHref('/id#top', '/id'), '/id#top')
})

test('does not mistake a lookalike prefix for the mount', () => {
  assert.equal(prefixHref('/identity', '/id'), '/id/identity')
})

test('prefixes the pathname of an object href and keeps the rest', () => {
  assert.deepEqual(prefixHref({ pathname: '/a', query: { x: '1' } }, '/id'), {
    pathname: '/id/a',
    query: { x: '1' },
  })
})

test('leaves an object href without a pathname alone', () => {
  assert.deepEqual(prefixHref({ query: { x: '1' } }, '/id'), { query: { x: '1' } })
})
