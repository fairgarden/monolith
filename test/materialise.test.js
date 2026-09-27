import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { materialisePublic, restorePublic, strangers } from '../dist/materialise.js'
import { withMonolith } from '../dist/index.js'

/** A monolith beside an app, with the app's assets linked the way linkApps does. */
const layout = () => {
  const base = mkdtempSync(path.join(tmpdir(), 'materialise-'))
  const assets = path.join(base, 'id/public')
  mkdirSync(path.join(assets, 'icons'), { recursive: true })
  writeFileSync(path.join(assets, 'icons/logo.svg'), '<svg/>')
  writeFileSync(path.join(assets, 'robots.txt'), 'User-agent: *')

  const root = path.join(base, 'monolith')
  mkdirSync(path.join(root, 'public'), { recursive: true })
  writeFileSync(path.join(root, 'public/favicon.ico'), 'own')
  const link = path.join(root, 'public/id')
  symlinkSync('../../id/public', link, 'dir')
  return { root, assets, link }
}

test('an app linked into public/ is real files for the build, and the same link after', () => {
  const { root, assets, link } = layout()
  const done = materialisePublic(root, [link, path.join(root, 'app/id')])
  assert.deepEqual(done, [link])

  // What a copy that does not follow links sees: a directory, not a link.
  assert.equal(lstatSync(link).isDirectory(), true)
  assert.equal(readFileSync(path.join(link, 'icons/logo.svg'), 'utf8'), '<svg/>')
  // The same file, not a copy of it.
  assert.equal(
    statSync(path.join(link, 'robots.txt')).ino,
    statSync(path.join(assets, 'robots.txt')).ino
  )
  // The monolith's own assets are its own.
  assert.equal(readFileSync(path.join(root, 'public/favicon.ico'), 'utf8'), 'own')

  restorePublic()
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readlinkSync(link), '../../id/public')
  // Taking the hard links away leaves the app's own files.
  assert.equal(readFileSync(path.join(assets, 'robots.txt'), 'utf8'), 'User-agent: *')
})

test('the link is back once the build process exits', () => {
  const { root, link } = layout()
  const module = new URL('../dist/materialise.js', import.meta.url).href
  const seen = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { lstatSync } from 'node:fs'
       const { materialisePublic } = await import(${JSON.stringify(module)})
       materialisePublic(${JSON.stringify(root)}, [${JSON.stringify(link)}])
       process.stdout.write(String(lstatSync(${JSON.stringify(link)}).isDirectory()))`,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(seen, 'true')
  assert.equal(readlinkSync(link), '../../id/public')
})

test('leaves alone what is not a link, or not directly in public/', () => {
  const { root } = layout()
  const own = path.join(root, 'public/favicon.ico')
  const nested = path.join(root, 'public/nested')
  mkdirSync(nested)
  symlinkSync('../../../id/public', path.join(nested, 'id'), 'dir')

  assert.deepEqual(materialisePublic(root, [own, path.join(nested, 'id')]), [])
  assert.equal(lstatSync(path.join(nested, 'id')).isSymbolicLink(), true)
})

/** A build that registered its links, then got `signal` — as Next's build does. */
const signalled = (signal, { nextHandles }) => {
  const { root, link } = layout()
  const module = new URL('../dist/materialise.js', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${nextHandles ? `process.on(${JSON.stringify(signal)}, () => process.exit(130))\n` : ''}
       const { materialisePublic } = await import(${JSON.stringify(module)})
       materialisePublic(${JSON.stringify(root)}, [${JSON.stringify(link)}])
       process.kill(process.pid, ${JSON.stringify(signal)})
       setTimeout(() => {}, 5000)`,
    ],
    { encoding: 'utf8' }
  )
  return { result, link }
}

test('Ctrl+C in a build puts the link back', () => {
  // next build turns SIGINT into process.exit(130), which the exit hook sees
  const { result, link } = signalled('SIGINT', { nextHandles: true })
  assert.equal(result.status, 130)
  assert.equal(readlinkSync(link), '../../id/public')
})

test('a closed terminal puts the link back, and still ends the build', () => {
  // nothing else handles SIGHUP, so the process dies of it as it would have
  const { result, link } = signalled('SIGHUP', { nextHandles: false })
  assert.equal(result.signal, 'SIGHUP')
  assert.equal(readlinkSync(link), '../../id/public')
})

/** A monolith mounting one app, linked once as a build would. */
const mounted = async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'heal-'))
  const root = path.join(base, 'monolith')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mono' }))
  const app = path.join(base, 'id')
  mkdirSync(path.join(app, 'app'), { recursive: true })
  mkdirSync(path.join(app, 'public/icons'), { recursive: true })
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@acme/id' }))
  writeFileSync(path.join(app, 'public/icons/logo.svg'), '<svg/>')
  const start = (phase) =>
    withMonolith({}, { id: { root: '../id' } }, { root, selfReference: false, watch: false })(phase)
  await start('phase-production-server')
  return { root, app, link: path.join(root, 'public/id'), start }
}

/** A build killed outright, after materialising: nothing of it gets to run again. */
const killed = (root, link) => {
  const module = new URL('../dist/materialise.js', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { materialisePublic } = await import(${JSON.stringify(module)})
       materialisePublic(${JSON.stringify(root)}, [${JSON.stringify(link)}])
       process.kill(process.pid, 'SIGKILL')`,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(lstatSync(link).isDirectory(), true, 'left behind')
}

test('the next dev or start puts back the link a killed build left as a directory', async () => {
  for (const phase of ['phase-development-server', 'phase-production-server']) {
    const { root, app, link, start } = await mounted()
    killed(root, link)
    await start(phase)
    assert.equal(lstatSync(link).isSymbolicLink(), true, phase)
    assert.equal(readFileSync(path.join(app, 'public/icons/logo.svg'), 'utf8'), '<svg/>')
  }
})

test('a file someone put in what a killed build left is kept, and named', async () => {
  const { root, app, link, start } = await mounted()
  killed(root, link)
  writeFileSync(path.join(link, 'icons/new.svg'), '<svg>new</svg>')

  await assert.rejects(start('phase-development-server'), (error) => {
    assert.match(error.message, /public\/id should be a link to \.\.\/\.\.\/id\/public/)
    assert.match(error.message, /public\/id\/icons\/new\.svg/)
    return true
  })
  // Nothing was deleted to make way.
  assert.equal(readFileSync(path.join(link, 'icons/new.svg'), 'utf8'), '<svg>new</svg>')
  assert.equal(lstatSync(link).isDirectory(), true)
  assert.deepEqual(strangers(link, path.join(app, 'public')), [path.join(link, 'icons/new.svg')])
  assert.equal(existsSync(path.join(root, 'public/id/icons/logo.svg')), true)
})

test('a copy that matches the app, where hard links could not be made, can go', () => {
  const { assets } = layout()
  const copy = mkdtempSync(path.join(tmpdir(), 'copy-'))
  mkdirSync(path.join(copy, 'icons'))
  writeFileSync(path.join(copy, 'icons/logo.svg'), '<svg/>')
  writeFileSync(path.join(copy, 'robots.txt'), 'User-agent: *')
  assert.deepEqual(strangers(copy, assets), [])

  writeFileSync(path.join(copy, 'robots.txt'), 'edited')
  assert.deepEqual(strangers(copy, assets), [path.join(copy, 'robots.txt')])
})

test("the monolith's own assets are never taken for a build's leftover", async () => {
  // Byte for byte the app's, but the monolith's: nothing recorded it as made.
  const { root, app, start } = await mounted()
  const own = path.join(root, 'public/brand')
  mkdirSync(own, { recursive: true })
  writeFileSync(path.join(own, 'logo.svg'), '<svg/>')
  rmSync(path.join(root, 'public/id'))
  mkdirSync(path.join(root, 'public/id'))
  writeFileSync(path.join(root, 'public/id/logo.svg'), readFileSync(path.join(app, 'public/icons/logo.svg')))

  await assert.rejects(start('phase-production-server'), /serves public\/id \(assets\), which the monolith already has/)
  assert.equal(readFileSync(path.join(root, 'public/id/logo.svg'), 'utf8'), '<svg/>')
})

test('a file saved into the directory while the build ran is not deleted when it ends', () => {
  const { root, link } = layout()
  materialisePublic(root, [link])
  writeFileSync(path.join(link, 'saved.txt'), 'mine')
  restorePublic()
  assert.equal(readFileSync(path.join(link, 'saved.txt'), 'utf8'), 'mine')
})
