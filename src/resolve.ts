import { createRequire } from 'node:module'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { NextConfig } from 'next'
import type { MonolithApp, MonolithApps, ResolvedApp } from './types.ts'

/** Config file names Next itself accepts, in the order Next looks for them. */
const CONFIG_FILES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
]

const isDirectory = (candidate: string): boolean => {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Mount names become URL segments, so keep them to something safe. */
const assertMountName = (name: string): void => {
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    throw new Error(
      `Monolith app name ${JSON.stringify(name)} is not usable as a URL segment. ` +
        'Use letters, digits, dashes and underscores.'
    )
  }
}

/** Where an app's files were taken from, when more than one source was offered. */
export type AppSource = 'path' | 'package'

interface Candidate {
  source: AppSource
  root: string
}

const resolvePackage = (monolithRoot: string, pkg: string): Candidate | undefined => {
  const require = createRequire(path.join(monolithRoot, 'package.json'))
  let resolved: string
  try {
    resolved = path.dirname(require.resolve(`${pkg}/package.json`))
  } catch {
    return undefined
  }

  // A workspace package resolves through node_modules but is a link to the
  // checkout, so it is the same thing as naming its path: it belongs in the
  // committed tree and can be symlinked, not copied.
  const real = realpathSync.native(resolved)
  const installed = real.split(path.sep).includes('node_modules')
  return { source: installed ? 'package' : 'path', root: real }
}

/**
 * An app checked out at a path is usable only if its routes are actually there.
 *
 * A submodule that was never cloned leaves an empty directory behind, which is
 * what a build host produces when it cannot read the submodule's remote.
 */
const hasRoutes = (root: string, app: MonolithApp): boolean => {
  if (app.appDir) return isDirectory(path.resolve(root, app.appDir))
  // Only an App Router tree counts: resolveApps requires one, so accepting a
  // pages-only checkout here would pick it and then fail instead of trying the
  // package that was offered as a fallback.
  return [path.join(root, 'app'), path.join(root, 'src', 'app')].some(isDirectory)
}

/**
 * Locate an app on disk.
 *
 * Paths are taken relative to the monolith and packages are resolved from
 * node_modules. Both may be given, and then the checkout wins when it is
 * there and the package is the fallback — which is how a private module can
 * still build somewhere that could not clone the submodule but can install
 * the package.
 */
const resolveRoot = (
  monolithRoot: string,
  name: string,
  app: MonolithApp
): Candidate => {
  const candidates: Candidate[] = []

  if (app.root) {
    candidates.push({ source: 'path', root: path.resolve(monolithRoot, app.root) })
  }
  if (app.package) {
    const resolved = resolvePackage(monolithRoot, app.package)
    if (resolved) candidates.push(resolved)
  }

  if (candidates.length === 0) {
    if (app.package) {
      throw new Error(
        `Could not resolve monolith app ${JSON.stringify(name)} from package ` +
          `${JSON.stringify(app.package)}. Is it a dependency of the monolith?`
      )
    }
    throw new Error(`Monolith app ${JSON.stringify(name)} needs either "root" or "package".`)
  }

  const usable = candidates.find(
    (candidate) => isDirectory(candidate.root) && hasRoutes(candidate.root, app)
  )
  if (usable) return usable

  // Nothing usable: say which places were looked at rather than just the last.
  const looked = candidates
    .map((candidate) => `${candidate.source} ${candidate.root}`)
    .join(', ')
  throw new Error(
    `Monolith app ${JSON.stringify(name)} has no routes directory. Looked at ${looked}. ` +
      'An empty directory here is usually a submodule that was never cloned.'
  )
}

/** A bare string is a path when it looks like one, otherwise a package name. */
const normalize = (entry: string | MonolithApp): MonolithApp => {
  if (typeof entry !== 'string') return entry
  return entry.startsWith('.') || path.isAbsolute(entry)
    ? { root: entry }
    : { package: entry }
}

const readPackageName = (root: string): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    return typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

const loadNextConfig = async (
  root: string,
  phase: string,
  name: string
): Promise<NextConfig> => {
  const configPath = CONFIG_FILES.map((file) => path.join(root, file)).find(isFile)
  if (!configPath) return {}

  let loaded: unknown
  try {
    loaded = (await import(pathToFileURL(configPath).href)).default
  } catch (cause) {
    throw new Error(
      `Failed to load the Next config for monolith app ${JSON.stringify(name)} ` +
        `at ${configPath}.`,
      { cause }
    )
  }

  const config = typeof loaded === 'function' ? await loaded(phase) : loaded
  return (config ?? {}) as NextConfig
}

export const resolveApps = async (
  monolithRoot: string,
  apps: MonolithApps,
  phase: string
): Promise<ResolvedApp[]> =>
  Promise.all(
    Object.entries(apps).map(async ([name, entry]) => {
      assertMountName(name)
      const app = normalize(entry)
      const { root, source } = resolveRoot(monolithRoot, name, app)

      const appDir = app.appDir
        ? path.resolve(root, app.appDir)
        : [path.join(root, 'app'), path.join(root, 'src', 'app')].find(isDirectory)

      if (!appDir || !isDirectory(appDir)) {
        throw new Error(
          `Monolith app ${JSON.stringify(name)} has no routes directory. ` +
            `Looked for "app/" and "src/app/" in ${root}.`
        )
      }

      const publicDirCandidate = app.publicDir
        ? path.resolve(root, app.publicDir)
        : path.join(root, 'public')

      const pagesDir = app.pagesDir
        ? path.resolve(root, app.pagesDir)
        : [path.join(root, 'pages'), path.join(root, 'src', 'pages')].find(isDirectory)

      const pagesApiDir =
        pagesDir && isDirectory(path.join(pagesDir, 'api'))
          ? path.join(pagesDir, 'api')
          : undefined

      const nextConfig =
        app.nextConfig === false
          ? {}
          : (app.nextConfig ??
            (await loadNextConfig(root, phase, name)))

      return {
        name,
        // '' rather than '/', so prefixing a path is a plain concatenation.
        prefix: app.prefix === '/' || app.prefix === '' ? '' : (app.prefix ?? `/${name}`),
        root,
        packageName: readPackageName(root),
        source,
        appDir,
        publicDir: isDirectory(publicDirCandidate) ? publicDirCandidate : undefined,
        pagesDir: pagesDir && isDirectory(pagesDir) ? pagesDir : undefined,
        pagesApiDir,
        apiViaPages: pagesApiDir !== undefined,
        nextConfig:
          typeof nextConfig === 'function' ? await nextConfig(phase) : nextConfig,
      }
    })
  )
