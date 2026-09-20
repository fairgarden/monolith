import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withMonolith } from '../dist/index.js'

/**
 * A repository whose root is a distribution manifest, with a monolith app at
 * apps/monolith and one module checked out beside it.
 */
const repository = ({ ours, parentShips }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-'))
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@acme/core',
      version: '2024.06.01',
      dependencies: { '@fg/id': ours, '@fairgarden/core': 'latest' },
      distribution: { extends: '@fairgarden/core' },
    })
  )

  const parent = path.join(root, 'node_modules', '@fairgarden', 'core')
  mkdirSync(parent, { recursive: true })
  writeFileSync(
    path.join(parent, 'package.json'),
    JSON.stringify({
      name: '@fairgarden/core',
      version: '2024.01.01',
      dependencies: { '@fg/id': parentShips },
    })
  )

  const app = path.join(root, 'modules', 'id')
  mkdirSync(path.join(app, 'app'), { recursive: true })
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@fg/id' }))

  const monolith = path.join(root, 'apps', 'monolith')
  mkdirSync(monolith, { recursive: true })
  writeFileSync(path.join(monolith, 'package.json'), JSON.stringify({ name: 'mono' }))

  return { root, monolith }
}

const mount = (monolith) =>
  withMonolith({}, { id: { root: '../../modules/id' } }, {
    root: monolith,
    selfReference: false,
  })('phase-production-build')

test('refuses to build when a module is older than the parent ships', async () => {
  const { monolith } = repository({ ours: '1.1.0', parentShips: '1.2.3' })
  await assert.rejects(mount(monolith), (error) => {
    assert.match(error.message, /@fg\/id 1\.1\.0 is older than the 1\.2\.3/)
    assert.match(error.message, /never behind it/)
    return true
  })
})

test('builds when the extension has moved ahead', async () => {
  const { monolith } = repository({ ours: '1.4.0', parentShips: '1.2.3' })
  await assert.doesNotReject(mount(monolith))
})

test('builds when the extension matches its parent exactly', async () => {
  const { monolith } = repository({ ours: '1.2.3', parentShips: '1.2.3' })
  await assert.doesNotReject(mount(monolith))
})
