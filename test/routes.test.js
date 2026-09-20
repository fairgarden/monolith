import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prefixPath } from '../dist/routes.js'
import { mergeRewrites, mergeRedirects, mergeHeaders } from '../dist/routes.js'

test('mounts a root path at the prefix itself', () => {
  assert.equal(prefixPath('/', '/id'), '/id')
})

test('mounts nested paths and keeps route params', () => {
  assert.equal(prefixPath('/login', '/id'), '/id/login')
  assert.equal(prefixPath('/:path*', '/id'), '/id/:path*')
  assert.equal(prefixPath('/en-US/:path*', '/id'), '/id/en-US/:path*')
})

test('leaves Next internals alone', () => {
  assert.equal(prefixPath('/_next/static/media/a.txt', '/id'), '/_next/static/media/a.txt')
})

test('leaves absolute URLs alone', () => {
  assert.equal(prefixPath('https://example.com/x', '/id'), 'https://example.com/x')
})

const app = (name, nextConfig, apiViaPages = false) => ({
  name,
  prefix: `/${name}`,
  root: `/tmp/${name}`,
  packageName: `@scope/${name}`,
  appDir: `/tmp/${name}/app`,
  publicDir: undefined,
  pagesDir: apiViaPages ? `/tmp/${name}/pages` : undefined,
  pagesApiDir: apiViaPages ? `/tmp/${name}/pages/api` : undefined,
  apiViaPages,
  nextConfig,
})

test('puts the mount after /api for Pages Router API routes', () => {
  // `pages/api` mounts at `pages/api/<name>`, so the prefix follows `/api`.
  assert.equal(prefixPath('/api/oidc', '/id', true), '/api/id/oidc')
  assert.equal(prefixPath('/api/oidc/:path*', '/id', true), '/api/id/oidc/:path*')
  assert.equal(prefixPath('/api', '/id', true), '/api/id')
})

test('leaves /api alone when the app has no Pages Router API', () => {
  // An App Router route handler lives under the app mount like anything else.
  assert.equal(prefixPath('/api/thing', '/id', false), '/id/api/thing')
})

test('does not mistake /apiary for /api', () => {
  assert.equal(prefixPath('/apiary', '/id', true), '/id/apiary')
})

test('rewrites an app\'s api paths to the api mount', async () => {
  const apps = [
    app(
      'id',
      {
        rewrites: async () => ({
          beforeFiles: [
            { source: '/oidc/:path*', destination: '/api/oidc/:path*' },
          ],
        }),
      },
      true
    ),
  ]
  const merged = await (await mergeRewrites({}, apps))()
  assert.deepEqual(merged.beforeFiles, [
    { source: '/id/oidc/:path*', destination: '/api/id/oidc/:path*' },
  ])
})

test('merges rewrites per phase, monolith first', async () => {
  const base = {
    rewrites: async () => ({ beforeFiles: [{ source: '/health', destination: '/api/health' }] }),
  }
  const apps = [
    app('id', {
      rewrites: async () => ({
        beforeFiles: [{ source: '/', destination: '/en-US' }],
        afterFiles: [{ source: '/oidc/:p*', destination: '/api/oidc/:p*' }],
        fallback: [],
      }),
    }),
  ]

  const merged = await (await mergeRewrites(base, apps))()

  assert.deepEqual(merged.beforeFiles, [
    { source: '/health', destination: '/api/health' },
    { source: '/id', destination: '/id/en-US' },
  ])
  assert.deepEqual(merged.afterFiles, [
    { source: '/id/oidc/:p*', destination: '/id/api/oidc/:p*' },
  ])
  assert.deepEqual(merged.fallback, [])
})

test('treats a bare rewrites array as afterFiles', async () => {
  const apps = [app('id', { rewrites: async () => [{ source: '/a', destination: '/b' }] })]
  const merged = await (await mergeRewrites({}, apps))()
  assert.deepEqual(merged.afterFiles, [{ source: '/id/a', destination: '/id/b' }])
  assert.deepEqual(merged.beforeFiles, [])
})

test('prefixes redirects but not their internal destinations', async () => {
  const apps = [
    app('id', {
      redirects: async () => [
        { source: '/en-US', destination: '/', permanent: true },
        { source: '/x', destination: '/_next/y', permanent: false },
      ],
    }),
  ]
  const merged = await (await mergeRedirects({}, apps))()
  assert.deepEqual(merged, [
    { source: '/id/en-US', destination: '/id', permanent: true },
    { source: '/id/x', destination: '/_next/y', permanent: false },
  ])
})

test('prefixes header sources and keeps the headers', async () => {
  const apps = [
    app('id', {
      headers: async () => [
        { source: '/static/:p*', headers: [{ key: 'Cache-Control', value: 'private' }] },
      ],
    }),
  ]
  const merged = await (await mergeHeaders({}, apps))()
  assert.deepEqual(merged, [
    { source: '/id/static/:p*', headers: [{ key: 'Cache-Control', value: 'private' }] },
  ])
})

test('keeps apps in declaration order', async () => {
  const apps = [
    app('id', { redirects: async () => [{ source: '/a', destination: '/b' }] }),
    app('members', { redirects: async () => [{ source: '/a', destination: '/b' }] }),
  ]
  const merged = await (await mergeRedirects({}, apps))()
  assert.deepEqual(
    merged.map((r) => r.source),
    ['/id/a', '/members/a']
  )
})
