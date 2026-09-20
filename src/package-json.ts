import { readFile, readdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import mergePackageJson from 'merge-package.json'
import type { ResolvedApp } from './types.ts'

const DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

type PackageJson = Record<string, unknown>

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
])

/** `import x from 'y'`, `import 'y'`, `import('y')` and `require('y')`. */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

const read = async (file: string): Promise<PackageJson> =>
  JSON.parse(await readFile(file, 'utf8')) as PackageJson

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
const packageOf = (specifier: string): string => {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const sourceFiles = async (dir: string): Promise<string[]> => {
  const found: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(full)))
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full)
    }
  }

  return found
}

/**
 * Packages the app's route files import directly.
 *
 * Both route trees need these from the monolith, for different reasons. Pages
 * Router files are copied, so their real path is inside the monolith and the
 * app's `node_modules` is no longer above them. App Router files are only
 * symlinked, and Turbopack does resolve those against the app — but TypeScript
 * resolves from where the file sits in the monolith, so it needs them too.
 *
 * Only *direct* imports matter. Anything an app reaches through its own package
 * name resolves via the monolith's link to the app and carries on from there.
 */
export const routeImports = async (app: ResolvedApp): Promise<Set<string>> => {
  const imported = new Set<string>()
  const roots = [app.appDir, app.pagesDir].filter(
    (root): root is string => root !== undefined
  )

  for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
    const contents = await readFile(file, 'utf8').catch(() => '')
    for (const [, specifier] of contents.matchAll(SPECIFIER)) {
      if (specifier.startsWith('.') || isBuiltin(specifier)) continue
      const name = packageOf(specifier)
      // Resolves through the monolith's link to the app, not its own deps.
      if (name === app.packageName) continue
      imported.add(name)
    }
  }

  return imported
}

/** `@scope/name` -> `@types/scope__name`, matching DefinitelyTyped's layout. */
const typesPackageOf = (name: string): string =>
  name.startsWith('@')
    ? `@types/${name.slice(1).replace('/', '__')}`
    : `@types/${name}`

/**
 * Workspace siblings are linked, not installed, so carrying their version
 * ranges into the monolith would pin it against its own workspace.
 */
const isInstallable = (range: unknown): boolean =>
  typeof range === 'string' &&
  !range.startsWith('workspace:') &&
  !range.startsWith('link:')

const pick = (pkg: PackageJson, wanted: Set<string>): PackageJson => {
  const picked: PackageJson = {}

  for (const key of DEPENDENCY_KEYS) {
    const deps = pkg[key] as Record<string, string> | undefined
    if (!deps) continue

    const taken = Object.entries(deps).filter(
      ([name, range]) => wanted.has(name) && isInstallable(range)
    )
    if (taken.length > 0) picked[key] = Object.fromEntries(taken)
  }

  return picked
}

const everything = (pkg: PackageJson): PackageJson => {
  const picked: PackageJson = {}
  for (const key of DEPENDENCY_KEYS) {
    const deps = pkg[key] as Record<string, string> | undefined
    if (!deps) continue
    const taken = Object.entries(deps).filter(([, range]) => isInstallable(range))
    if (taken.length > 0) picked[key] = Object.fromEntries(taken)
  }
  return picked
}

export interface MergeOptions {
  /**
   * Take every dependency rather than only what the route trees import.
   * Use when something outside the route trees is resolved from the monolith.
   */
  all?: boolean
}

export interface MergeResult {
  packageJson: PackageJson
  changed: boolean
  /** What was taken from each app, for reporting. */
  taken: Map<string, string[]>
}

/**
 * Fold what each app needs from the monolith into its package.json.
 *
 * Uses a three-way merge against an empty base so conflicting ranges are
 * resolved by semver rather than by whichever app happens to be last.
 */
export const mergeAppDependencies = async (
  monolithPackageJsonPath: string,
  apps: ResolvedApp[],
  options: MergeOptions = {}
): Promise<MergeResult> => {
  const original = await read(monolithPackageJsonPath)
  let merged = JSON.stringify(original)
  const taken = new Map<string, string[]>()

  for (const app of apps) {
    const appPkg = await read(path.join(app.root, 'package.json'))

    let incoming: PackageJson
    if (options.all) {
      incoming = everything(appPkg)
    } else {
      const wanted = await routeImports(app)
      // Type declarations are resolved from the monolith too.
      for (const name of [...wanted]) wanted.add(typesPackageOf(name))
      incoming = pick(appPkg, wanted)
    }

    const names = DEPENDENCY_KEYS.flatMap((key) =>
      Object.keys((incoming[key] as Record<string, string>) ?? {})
    )
    if (names.length === 0) continue

    taken.set(app.name, names)
    merged = mergePackageJson(merged, JSON.stringify({}), JSON.stringify(incoming))
  }

  const packageJson = JSON.parse(merged) as PackageJson
  return {
    packageJson,
    // Compared by content, not by key order: the merge re-sorts, and a
    // monolith whose dependencies sit in any other order would otherwise fail
    // `--check` on every run with nothing to actually change.
    changed: !sameDependencies(original, packageJson),
    taken,
  }
}

/** Whether two manifests declare the same dependencies, order aside. */
const sameDependencies = (a: PackageJson, b: PackageJson): boolean =>
  DEPENDENCY_KEYS.every((key) => {
    const left = (a[key] ?? {}) as Record<string, string>
    const right = (b[key] ?? {}) as Record<string, string>
    const names = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...names].every((name) => left[name] === right[name])
  })

export const writePackageJson = async (
  file: string,
  packageJson: PackageJson
): Promise<void> => {
  await writeFile(file, `${JSON.stringify(packageJson, null, 2)}\n`)
}
