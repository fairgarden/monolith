import { createRequire } from 'node:module'
import path from 'node:path'
import semver from 'semver'
import { inspectExtends, describeViolations } from '@fairgarden/distribution'
import type { NextConfig } from 'next'
import type { ResolvedApp } from './types.ts'

/**
 * Options that change how every route is served. An app cannot have its own
 * value for these, because the monolith serves all of them from one server.
 */
const SHARED_OPTIONS = [
  'i18n',
  'trailingSlash',
  'skipTrailingSlashRedirect',
  'skipMiddlewareUrlNormalize',
  'output',
  'assetPrefix',
] as const satisfies ReadonlyArray<keyof NextConfig>

/**
 * Options an app can never set, because the monolith owns them and an app's
 * value would silently apply to the whole deployment.
 */
const OWNED_OPTIONS = ['basePath', 'distDir'] as const satisfies ReadonlyArray<
  keyof NextConfig
>

const describe = (value: unknown): string => JSON.stringify(value) ?? String(value)

/** Config this merges. Everything else an app sets is dropped. */
const MERGED_OPTIONS = ['rewrites', 'redirects', 'headers'] as const

/**
 * An app setting anything this cannot merge.
 *
 * Dropping it silently is the failure this is meant to avoid: the app builds
 * alone with the option applied and inside a monolith without it, and nothing
 * says so.
 */
const droppedOptions = (apps: ResolvedApp[]): string[] => {
  const problems: string[] = []

  for (const app of apps) {
    for (const option of Object.keys(app.nextConfig)) {
      if ((MERGED_OPTIONS as readonly string[]).includes(option)) continue
      if ((SHARED_OPTIONS as readonly string[]).includes(option)) continue
      if ((OWNED_OPTIONS as readonly string[]).includes(option)) continue
      problems.push(
        `"${app.name}" sets ${option}, which a monolith cannot merge. Move it ` +
          'to the monolith, or pass `nextConfig: false` for this app to say it ' +
          'is deliberate.'
      )
    }
  }

  return problems
}

/**
 * The Next a package would actually load, rather than the range it asks for.
 *
 * Returns undefined when it cannot be resolved, which is the case while tooling
 * loads a config outside an install. Nothing can be compared then.
 */
const installedNext = (root: string): string | undefined => {
  try {
    const require = createRequire(path.join(root, 'package.json'))
    const version: unknown = require('next/package.json').version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * The monolith compiles every app with its own Next, so an app can never need
 * a newer one than the monolith has.
 *
 * Exact agreement is not required — an app pinned to 16.3.0 is fine inside a
 * monolith on 16.3.5 — but the majors have to match, and the monolith has to be
 * at least as new as the newest app.
 */
const nextVersionProblems = (
  monolithRoot: string,
  apps: ResolvedApp[]
): string[] => {
  const monolithVersion = installedNext(monolithRoot)
  if (!monolithVersion) return []

  const problems: string[] = []

  for (const app of apps) {
    const appVersion = installedNext(app.root)
    if (!appVersion) continue

    if (semver.major(appVersion) !== semver.major(monolithVersion)) {
      problems.push(
        `"${app.name}" is built for Next ${appVersion} but the monolith runs ` +
          `${monolithVersion}. A mounted app is compiled by the monolith's Next, ` +
          'so their major versions have to match.'
      )
      continue
    }

    if (semver.lt(monolithVersion, appVersion)) {
      problems.push(
        `"${app.name}" is built for Next ${appVersion} but the monolith runs ` +
          `${monolithVersion}. The monolith compiles every app, so it has to be ` +
          'at least as new as the newest one.'
      )
    }
  }

  return problems
}

/**
 * Reject app configs the monolith cannot honour, rather than dropping them
 * quietly and leaving a deployment that half-works.
 */
/**
 * A distribution that extends another may not ship anything older than it.
 *
 * Checked here as well as by `fg-dist sync`, because shipping a regression is
 * the kind of thing that should stop a build rather than wait to be noticed.
 */
const extendsProblems = (monolithRoot: string): string[] => {
  // The manifest is the repository root's, which is above the monolith app.
  for (const root of [monolithRoot, path.join(monolithRoot, '..', '..')]) {
    try {
      const report = inspectExtends(path.resolve(root))
      if (report.violations.length > 0) return [describeViolations(report)]
      if (report.parent) return []
    } catch {
      continue
    }
  }
  return []
}

export const assertCompatible = (
  base: NextConfig,
  apps: ResolvedApp[],
  monolithRoot?: string
): void => {
  const problems: string[] = [
    ...(monolithRoot
      ? [...nextVersionProblems(monolithRoot, apps), ...extendsProblems(monolithRoot)]
      : []),
    ...droppedOptions(apps),
  ]

  for (const app of apps) {
    for (const option of OWNED_OPTIONS) {
      if (app.nextConfig[option] !== undefined) {
        problems.push(
          `"${app.name}" sets ${option}, which only the monolith may set. ` +
            `Routes are mounted at ${app.prefix} instead.`
        )
      }
    }

    for (const option of SHARED_OPTIONS) {
      const appValue = app.nextConfig[option]
      if (appValue === undefined) continue

      const baseValue = base[option]
      if (baseValue === undefined) {
        problems.push(
          `"${app.name}" sets ${option} to ${describe(appValue)}, but the monolith ` +
            'does not. Set it on the monolith so every app shares it, or remove it.'
        )
        continue
      }

      if (JSON.stringify(baseValue) !== JSON.stringify(appValue)) {
        problems.push(
          `"${app.name}" sets ${option} to ${describe(appValue)}, but the monolith ` +
            `uses ${describe(baseValue)}. These must match.`
        )
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Incompatible Next config in the monolith:\n  - ${problems.join('\n  - ')}`
    )
  }
}
