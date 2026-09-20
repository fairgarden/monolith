import {
  readdirSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import {
  lstat,
  writeFile,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import {
  async as syncDirectoryAsync,
  sync as syncDirectorySync,
} from 'sync-directory'
import type { LinkStrategy, ResolvedApp } from './types.ts'

export interface LinkOptions {
  strategy: LinkStrategy
  watch: boolean
  /** Committed App Router directory, absolute. */
  sourceDir: string
  /** Committed Pages Router directory, absolute. */
  sourcePagesDir: string
  selfReference?: boolean
}

/**
 * Dropped into a derived tree so a later run knows it built it.
 *
 * Without it there is no way to tell a tree this created from one the monolith
 * keeps its own routes in — and the difference decides whether clearing it is
 * routine or destroys someone's work. A dotfile is not a route.
 */
const MARKER = '.fg-monolith'

const markDerived = async (target: string): Promise<void> => {
  await mkdir(target, { recursive: true })
  await writeFile(
    path.join(target, MARKER),
    'Built by withMonolith from the committed tree. Safe to delete; do not edit.\n'
  )
}

const isDerived = async (target: string): Promise<boolean> =>
  (await lstat(path.join(target, MARKER)).catch(() => undefined)) !== undefined

/** Directories that are never part of an app's routes. */
const IGNORED = new Set(['node_modules', '.next', '.turbo', '.git'])

/**
 * Remove whatever currently occupies a mount point.
 *
 * Only ever called for paths generated inside the monolith, and refuses
 * anything else — deleting the wrong directory here would take an app's real
 * source with it.
 */
const clear = async (target: string, monolithRoot: string): Promise<void> => {
  const relative = path.relative(monolithRoot, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to replace ${target}, which is outside ${monolithRoot}.`)
  }

  let stats
  try {
    // lstat, not stat: a symlink must be unlinked rather than followed.
    stats = await lstat(target)
  } catch {
    return
  }

  if (stats.isSymbolicLink() || stats.isFile()) {
    await unlink(target)
    return
  }

  await rm(target, { recursive: true, force: true })
}

const pointsAt = async (link: string, expected: string): Promise<boolean> => {
  const current = await readlink(link).catch(() => undefined)
  return (
    current !== undefined && path.resolve(path.dirname(link), current) === expected
  )
}

/**
 * Point a committed symlink at an app's directory.
 *
 * These are the readable view of the composition: they live in git, and GitHub
 * renders them as links you can follow. Writing them is idempotent so a repeat
 * run leaves no diff.
 */
const linkSource = async (
  source: string,
  target: string,
  monolithRoot: string
): Promise<void> => {
  const existing = await lstat(target).catch(() => undefined)
  if (existing?.isSymbolicLink() && (await pointsAt(target, source))) return

  await mkdir(path.dirname(target), { recursive: true })
  await clear(target, monolithRoot)
  // Relative so the tree stays valid if the repo is moved or mounted elsewhere.
  await symlink(path.relative(path.dirname(target), source), target, 'dir')
}

/**
 * Recreate `source`'s directory tree under `target`, symlinking each file.
 *
 * Real directories are what `next dev` needs to walk; symlinked files keep the
 * content resolving back to the app, so edits never go stale.
 */
const mirrorTree = async (
  source: string,
  target: string,
  preserve: ReadonlySet<string> = new Set()
): Promise<void> => {
  await mkdir(target, { recursive: true })

  // A missing source is an empty one: every app may be package-sourced, in
  // which case nothing was ever linked into the committed tree.
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  const expected = new Set<string>()

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    expected.add(entry.name)

    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    // Follow symlinks, so an app linked into the source tree is walked too.
    const stats = await stat(from).catch(() => undefined)
    if (!stats) continue

    // Never mirror something that resolves into node_modules. Turbopack will
    // not process a route whose real path is there, and such an entry is
    // either stale or a link that should never have been committed.
    const real = await realpath(from).catch(() => from)
    if (real.split(path.sep).includes('node_modules')) continue

    if (stats.isDirectory()) {
      const existing = await lstat(to).catch(() => undefined)
      if (existing && !existing.isDirectory()) await rm(to, { force: true })
      await mirrorTree(from, to)
      continue
    }

    const existing = await lstat(to).catch(() => undefined)
    if (existing) {
      if (existing.isSymbolicLink() && (await pointsAt(to, from))) continue
      await rm(to, { recursive: true, force: true })
    }
    await symlink(path.relative(path.dirname(to), from), to, 'file')
  }

  // Drop anything the source no longer has, so deleted routes stop being
  // served — except mounts that are copied in rather than derived from here.
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === MARKER) continue
    if (!expected.has(entry.name) && !preserve.has(entry.name)) {
      await rm(path.join(target, entry.name), { recursive: true, force: true })
    }
  }
}

const duplicate = async (
  source: string,
  target: string,
  type: 'hardlink' | 'copy',
  shouldWatch: boolean
): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true })
  const options = {
    type,
    deleteOrphaned: true,
    // sync-directory knows `staySymlink`, not `supportSymlink`; the latter was
    // silently ignored. Symlinks in the source are followed and their contents
    // copied, which is what a derived tree wants.
    staySymlink: false,
    exclude: [...IGNORED].map((name) => new RegExp(`(^|[/\\\\])${name}([/\\\\]|$)`)),
  }

  if (shouldWatch) {
    await syncDirectoryAsync(source, target, { ...options, watch: true })
    return
  }
  syncDirectorySync(source, target, options)
}

/** Held so the watchers are not collected while the dev server runs. */
const watchers = new Set<FSWatcher>()

/**
 * Re-mirror when files are added or removed.
 *
 * Content changes need no watcher — the symlinks already resolve to the app —
 * so this only has to catch the tree changing shape.
 */
const watchMirror = (
  source: string,
  target: string,
  preserve: ReadonlySet<string>
): void => {
  let pending: NodeJS.Timeout | undefined

  const rebuild = (): void => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      void mirrorTree(source, target, preserve).catch(() => {})
    }, 50)
  }

  const add = (dir: string): void => {
    try {
      const watcher = watch(dir, { recursive: true }, rebuild)
      watcher.unref()
      watchers.add(watcher)
    } catch {
      // A directory that cannot be watched is not worth failing dev over.
    }
  }

  add(source)

  // On Linux a recursive watch does not follow directory symlinks, and every
  // app in the committed tree is one — so routes added inside an app would go
  // unnoticed until a restart. Watch each mount's real directory as well.
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue
    const full = path.join(source, entry.name)
    const real = realpathSync(full)
    if (real !== full && statSync(real).isDirectory()) add(real)
  }
}

/**
 * Make an app resolvable by its own package name from inside its own tree.
 *
 * Apps import their own modules by package name, because relative imports stop
 * working once the routes are mounted elsewhere. Turbopack resolves a mounted
 * file from its real location, so the monolith's `node_modules` is not on the
 * lookup path and the app has to be able to find itself.
 *
 * Leaves a real installed package alone, and only replaces a symlink it would
 * have created itself.
 */
export const linkSelfReference = async (app: ResolvedApp): Promise<void> => {
  if (!app.packageName) return

  const target = path.join(app.root, 'node_modules', app.packageName)
  const existing = await lstat(target).catch(() => undefined)

  if (existing) {
    if (!existing.isSymbolicLink()) return
    if (await pointsAt(target, app.root)) return
    await unlink(target)
  }

  await mkdir(path.dirname(target), { recursive: true })
  await symlink(path.relative(path.dirname(target), app.root), target, 'dir')
}

interface Claim {
  target: string
  source: string
  app: string
  what: string
}

/** Everything each app would put into the monolith, before anything is written. */
const claimsOf = async (
  monolithRoot: string,
  apps: ResolvedApp[],
  options: LinkOptions
): Promise<Claim[]> => {
  const claims: Claim[] = []

  const entries = async (from: string): Promise<string[]> =>
    (await readdir(from, { withFileTypes: true }).catch(() => []))
      .filter((entry) => !IGNORED.has(entry.name))
      .map((entry) => entry.name)

  for (const app of apps) {
    const places: Array<[from: string | undefined, into: string, what: string]> = [
      [app.appDir, options.sourceDir, 'routes'],
      [app.publicDir, path.join(monolithRoot, 'public'), 'assets'],
      [app.pagesApiDir, path.join(options.sourcePagesDir, 'api'), 'api routes'],
    ]

    for (const [from, into, what] of places) {
      if (!from) continue

      // At the root an app claims each of its entries; anywhere else it claims
      // one directory named after the mount.
      if (app.prefix === '') {
        for (const entry of await entries(from)) {
          claims.push({
            target: path.join(into, entry),
            source: path.join(from, entry),
            app: app.name,
            what,
          })
        }
      } else {
        claims.push({
          target: path.join(into, app.name),
          source: from,
          app: app.name,
          what,
        })
      }
    }
  }

  return claims
}

/**
 * Apps that cannot be served together from one deployment.
 *
 * Two apps claiming the same path, or an app claiming one the monolith already
 * serves, is not something a monolith can resolve — the path can only belong to
 * one of them. Most distributions never collide; the ones that do have to be
 * deployed separately, a subdomain each.
 */
const findCollisions = async (
  monolithRoot: string,
  claims: Claim[]
): Promise<string[]> => {
  const problems: string[] = []
  const byTarget = new Map<string, Claim[]>()

  for (const claim of claims) {
    byTarget.set(claim.target, [...(byTarget.get(claim.target) ?? []), claim])
  }

  for (const [target, claimants] of byTarget) {
    const where = path.relative(monolithRoot, target)

    if (claimants.length > 1) {
      const names = [...new Set(claimants.map((c) => `"${c.app}"`))]
      problems.push(
        `${names.join(' and ')} both serve ${where} (${claimants[0].what}).`
      )
      continue
    }

    const [claim] = claimants
    const existing = await lstat(target).catch(() => undefined)
    if (!existing) continue

    // A symlink pointing where this app would point is a previous run's.
    if (existing.isSymbolicLink() && (await pointsAt(target, claim.source))) continue
    if (existing.isSymbolicLink()) continue

    problems.push(
      `"${claim.app}" serves ${where} (${claim.what}), which the monolith ` +
        'already has.'
    )
  }

  return problems
}

/**
 * Mount an app at the site root, entry by entry.
 *
 * An app served at `/` has no directory of its own — its `about/` becomes the
 * monolith's `about/`. So each entry is linked individually. Whether any of
 * them clash with the monolith's own files, or another app's, is settled by
 * the collision check before anything here runs.
 */
const linkAtRoot = async (
  from: string,
  into: string,
  monolithRoot: string
): Promise<string[]> => {
  const linked: string[] = []
  await mkdir(into, { recursive: true })

  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue

    const source = path.join(from, entry.name)
    const target = path.join(into, entry.name)
    await linkSource(source, target, monolithRoot)
    linked.push(target)
  }

  return linked
}

/**
 * Mount an app's Pages Router routes.
 *
 * `pages/api` gets its own mount at `pages/api/<name>`, because Next only
 * treats files directly under `pages/api/` as API routes — nesting it under
 * `pages/<name>/api` would turn the handlers into pages. Anything else is
 * linked entry by entry so that split stays possible.
 */
const linkPages = async (
  app: ResolvedApp,
  sourcePagesDir: string,
  monolithRoot: string
): Promise<string[]> => {
  if (!app.pagesDir) return []
  const mounted: string[] = []

  if (app.pagesApiDir) {
    // At the site root its api routes are the monolith's: /api/x, not /api/www/x.
    const target =
      app.prefix === ''
        ? path.join(sourcePagesDir, 'api')
        : path.join(sourcePagesDir, 'api', app.name)
    if (app.prefix === '') {
      mounted.push(...(await linkAtRoot(app.pagesApiDir, target, monolithRoot)))
    } else {
      await linkSource(app.pagesApiDir, target, monolithRoot)
      mounted.push(target)
    }
  }

  for (const entry of await readdir(app.pagesDir, { withFileTypes: true })) {
    if (entry.name === 'api' || IGNORED.has(entry.name)) continue
    const target = path.join(sourcePagesDir, app.name, entry.name)
    await linkSource(path.join(app.pagesDir, entry.name), target, monolithRoot)
    mounted.push(target)
  }

  return mounted
}

/**
 * Point the committed symlinks at each app, then produce whatever Next reads.
 *
 * `public/<name>` is served straight through its symlink — only route
 * discovery needs the derived tree.
 */
/**
 * Refuse a layout where the derived tree would be written over the monolith's
 * own routes.
 *
 * `app/` and `pages/` are rebuilt and cleared on every run, so they cannot also
 * be where the monolith keeps its source. A conventional Next app puts them
 * exactly there, and deriving over it would delete the lot.
 *
 * Checked before anything is written, since mounting creates the committed tree
 * and would otherwise make this look like a layout that was always derived.
 */
const assertDerivable = async (
  monolithRoot: string,
  options: LinkOptions
): Promise<void> => {
  for (const [source, name] of [
    [options.sourceDir, 'app'],
    [options.sourcePagesDir, 'pages'],
  ] as const) {
    const target = path.join(monolithRoot, name)
    const targetExists = (await lstat(target).catch(() => undefined)) !== undefined
    const sourceExists = (await lstat(source).catch(() => undefined)) !== undefined
    // A tree this built before is ours to rebuild, however it looks now.
    const ours = targetExists && (await isDerived(target))

    if (
      path.resolve(source) === path.resolve(target) ||
      (targetExists && !sourceExists && !ours)
    ) {
      throw new Error(
        `The monolith keeps its routes in ${name}/, which is where the mounted ` +
          `tree is built and cleared. Move them to ${path.relative(monolithRoot, source)}/ ` +
          `— that is the tree that is committed, and ${name}/ is derived from it.`
      )
    }
  }
}

export const linkApps = async (
  monolithRoot: string,
  apps: ResolvedApp[],
  options: LinkOptions
): Promise<string[]> => {
  await assertDerivable(monolithRoot, options)

  const mounted: string[] = []

  // An app resolved from node_modules cannot be linked into the committed
  // tree: the path is machine-specific, and Turbopack will not process a route
  // whose real path is inside node_modules. Its files are copied instead.
  const fromPackage = apps.filter((app) => app.source === 'package')
  const fromPath = apps.filter((app) => app.source !== 'package')

  // Only one app can be served at the site root.
  const atRoot = apps.filter((app) => app.prefix === '')
  if (atRoot.length > 1) {
    throw new Error(
      `Only one app can be served at the site root; ${atRoot
        .map((app) => `"${app.name}"`)
        .join(' and ')} both are.`
    )
  }

  const collisions = await findCollisions(
    monolithRoot,
    await claimsOf(monolithRoot, apps, options)
  )
  if (collisions.length > 0) {
    throw new Error(
      [
        'These apps cannot be served from one deployment:',
        ...collisions.map((problem) => `  - ${problem}`),
        'A path can only belong to one of them. Rename a mount, or deploy the ' +
          'apps separately — a subdomain each — rather than as a monolith.',
      ].join('\n')
    )
  }

  for (const app of fromPath) {
    if (options.selfReference !== false) await linkSelfReference(app)

    if (app.prefix === '') {
      mounted.push(
        ...(await linkAtRoot(app.appDir, options.sourceDir, monolithRoot))
      )
      if (app.publicDir) {
        mounted.push(
          ...(await linkAtRoot(
            app.publicDir,
            path.join(monolithRoot, 'public'),
            monolithRoot
          ))
        )
      }
      mounted.push(...(await linkPages(app, options.sourcePagesDir, monolithRoot)))
      continue
    }

    const routes = path.join(options.sourceDir, app.name)
    await linkSource(app.appDir, routes, monolithRoot)
    mounted.push(routes)

    if (app.publicDir) {
      const assets = path.join(monolithRoot, 'public', app.name)
      await linkSource(app.publicDir, assets, monolithRoot)
      mounted.push(assets)
    }

    mounted.push(...(await linkPages(app, options.sourcePagesDir, monolithRoot)))
  }

  const appTarget = path.join(monolithRoot, 'app')
  const pagesTarget = path.join(monolithRoot, 'pages')

  // Only path-sourced apps write into the committed pages tree; a
  // package-sourced one is copied straight into `pages/` further down, so
  // counting it here would sync from a source that was never created.
  const hasPages = fromPath.some((app) => app.pagesDir !== undefined)

  // Next refuses to start when `app` and `pages` live in different folders, so
  // once the Pages Router forces a derived tree the App Router needs one too.
  // A package-sourced app forces one as well, having nothing in the committed
  // tree to be read from.
  const strategy =
    options.strategy === 'source' && (hasPages || fromPackage.length > 0)
      ? 'mirror'
      : options.strategy

  if (strategy === 'source') {
    // Next falls through to the committed tree only when these are absent, so
    // leftovers from a dev session must not be allowed to shadow it.
    await clear(appTarget, monolithRoot)
    await clear(pagesTarget, monolithRoot)
    return mounted
  }

  const stale = await lstat(appTarget).catch(() => undefined)
  if (stale?.isSymbolicLink()) await clear(appTarget, monolithRoot)

  // Names copied in below, which deriving the tree must not treat as orphans.
  const copied = new Set(fromPackage.map((app) => app.name))

  if (strategy === 'mirror') {
    await mirrorTree(options.sourceDir, appTarget, copied)
    if (options.watch) watchMirror(options.sourceDir, appTarget, copied)
  } else {
    await duplicate(options.sourceDir, appTarget, strategy, options.watch)
  }
  await markDerived(appTarget)
  mounted.push(appTarget)

  const materialise = strategy === 'copy' ? 'copy' : 'hardlink'

  if (hasPages) {
    await duplicate(
      options.sourcePagesDir,
      pagesTarget,
      materialise,
      options.watch
    )
    await markDerived(pagesTarget)
    mounted.push(pagesTarget)
  } else if (fromPackage.every((app) => app.pagesApiDir === undefined)) {
    await clear(pagesTarget, monolithRoot)
  }

  // After each tree exists, so deriving it cannot delete these again.
  for (const app of fromPackage) {
    const routes = path.join(appTarget, app.name)
    await duplicate(app.appDir, routes, materialise, options.watch)
    mounted.push(routes)

    if (app.publicDir) {
      const assets = path.join(monolithRoot, 'public', app.name)
      await duplicate(app.publicDir, assets, materialise, false)
      mounted.push(assets)
    }

    if (app.pagesApiDir) {
      const api = path.join(pagesTarget, 'api', app.name)
      await duplicate(app.pagesApiDir, api, materialise, options.watch)
      await markDerived(pagesTarget)
      mounted.push(api)
    }
  }

  return mounted
}
