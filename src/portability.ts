import { statSync } from 'node:fs'
import path from 'node:path'
import type { NextConfig } from 'next'

/**
 * Options the monolith owns for the whole deployment. An app that sets one is
 * either fighting the monolith or silently changing every other app.
 */
const OWNED_OPTIONS = ['basePath', 'distDir'] as const

/** Options that have to agree across every app, because one server serves all. */
const SHARED_OPTIONS = [
  'i18n',
  'trailingSlash',
  'skipTrailingSlashRedirect',
  'skipMiddlewareUrlNormalize',
  'output',
  'assetPrefix',
] as const

/**
 * Conventions Next allows exactly one of per deployment. An app can use them on
 * its own, but mounting several apps means only one could ever win — so rather
 * than let one app's copy silently disappear, say so.
 */
const SINGLETON_FILES: Array<{ names: string[]; why: string }> = [
  {
    names: ['proxy', 'middleware', 'src/proxy', 'src/middleware'],
    why: 'a deployment has one proxy; the monolith would have to run it and strip the mount prefix itself',
  },
  {
    names: ['instrumentation', 'src/instrumentation'],
    why: 'a deployment has one instrumentation hook',
  },
  {
    names: ['pages/_app', 'src/pages/_app'],
    why: 'a deployment has one Pages Router app shell',
  },
  {
    names: ['pages/_document', 'src/pages/_document'],
    why: 'a deployment has one Pages Router document',
  },
]

/**
 * Files that generate a route which only means anything at the site root.
 * Mounted, they end up at `/<name>/robots.txt`, where nothing looks for them.
 */
const ROOT_ONLY_ROUTES = ['robots', 'sitemap', 'manifest']

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

const exists = (candidate: string): boolean => {
  try {
    statSync(candidate)
    return true
  } catch {
    return false
  }
}

const findFile = (root: string, name: string): string | undefined =>
  EXTENSIONS.map((extension) => `${name}${extension}`).find((file) =>
    exists(path.join(root, file))
  )

export interface PortabilityOptions {
  /**
   * The app to check. Defaults to the directory of the config that called
   * this, not the working directory — a monolith loading an app's config
   * would otherwise have the app checked against the monolith's own files.
   */
  root?: string
  /** `warn` reports and continues, `error` refuses to build. Defaults to `warn`. */
  level?: 'warn' | 'error'
  /** Findings to accept, by the text before the colon. */
  ignore?: string[]
}

/**
 * Everything about this app that would not survive being mounted in a monolith.
 *
 * Exported separately so a test or a CI check can assert on the list rather
 * than scrape log output.
 */
export const findPortabilityProblems = (
  nextConfig: NextConfig,
  root: string
): string[] => {
  const problems: string[] = []

  for (const option of OWNED_OPTIONS) {
    if (nextConfig[option] !== undefined) {
      problems.push(
        `${option}: only the monolith may set this; mounted apps are served from their mount point instead`
      )
    }
  }

  for (const option of SHARED_OPTIONS) {
    if (nextConfig[option] !== undefined) {
      problems.push(
        `${option}: has to match every other app in the monolith, so it belongs on the monolith`
      )
    }
  }

  for (const { names, why } of SINGLETON_FILES) {
    const found = names.map((name) => findFile(root, name)).find(Boolean)
    if (found) problems.push(`${found}: ${why}`)
  }

  for (const name of ROOT_ONLY_ROUTES) {
    const found =
      findFile(root, path.join('app', name)) ??
      findFile(root, path.join('src', 'app', name))
    if (found) {
      problems.push(
        `${found}: serves a route that only works at the site root, and would be mounted under the app's prefix`
      )
    }
  }

  return problems
}

/**
 * Next reads the config in the main process and again in a build worker.
 * Marking the environment keeps the report to one, since the worker inherits it.
 */
/**
 * The directory of the config that called this.
 *
 * A monolith loads each app's own config, so the working directory is the
 * monolith's and would attribute its files to whichever app is being loaded.
 */
const callerDirectory = (): string | undefined => {
  const original = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_, stack) => stack
    const stack = new Error().stack as unknown as NodeJS.CallSite[]
    for (const frame of stack ?? []) {
      const file = frame.getFileName?.()
      if (!file || file.includes('node_modules') || !file.includes('next.config')) {
        continue
      }
      return path.dirname(file.replace(/^file:\/\//, ''))
    }
  } catch {
    return undefined
  } finally {
    Error.prepareStackTrace = original
  }
  return undefined
}

const REPORTED_ENV = '__FG_MONOLITH_PORTABILITY_REPORTED'

const alreadyReported = (root: string): boolean =>
  (process.env[REPORTED_ENV] ?? '').split(path.delimiter).includes(root)

const markReported = (root: string): void => {
  const seen = (process.env[REPORTED_ENV] ?? '').split(path.delimiter).filter(Boolean)
  process.env[REPORTED_ENV] = [...seen, root].join(path.delimiter)
}

const describe = (problems: string[]): string =>
  [
    `This app would not port cleanly into a monolith:`,
    ...problems.map((problem) => `  - ${problem}`),
    `See @fairgarden/monolith for what a mounted app can rely on.`,
  ].join('\n')

/**
 * Check that an app can be mounted into a monolith, from the app's own config.
 *
 * Wrap the app's config with this and it reports, on every build, whatever
 * would not survive being served under a prefix alongside other apps. It
 * changes nothing about how the app runs on its own.
 *
 * ```ts
 * // apps/id/next.config.ts
 * export default withMonolithicPortability({ redirects: async () => [...] })
 * ```
 *
 * Set `level: 'error'` in CI to make it a gate rather than a reminder.
 */
export const withMonolithicPortability = (
  nextConfig: NextConfig = {},
  options: PortabilityOptions = {}
): NextConfig => {
  const root = options.root ?? callerDirectory() ?? process.cwd()
  const ignore = new Set(options.ignore ?? [])

  const problems = findPortabilityProblems(nextConfig, root).filter(
    (problem) => !ignore.has(problem.slice(0, problem.indexOf(':')))
  )

  if (problems.length > 0) {
    if (options.level === 'error') throw new Error(describe(problems))
    if (!alreadyReported(root)) {
      markReported(root)
      process.stderr.write(`${describe(problems)}\n`)
    }
  }

  return nextConfig
}
