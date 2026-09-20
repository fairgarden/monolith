import type { NextConfig } from 'next'
import type { ResolvedApp } from './types.ts'

type Rewrite = { source: string; destination: string; basePath?: false }
type Redirect = { source: string; destination: string }
type Header = { source: string }
type Rewrites = Awaited<ReturnType<NonNullable<NextConfig['rewrites']>>>

/** Next's own internals are served from the monolith root, never per app. */
const RESERVED = ['/_next/', '/__next', '/api/__']

/**
 * Move a path into an app's mount point.
 *
 * Absolute URLs and Next's internal paths are left alone; everything else is a
 * route belonging to the app and moves under `/<name>`.
 *
 * Pages Router API routes are the one exception. Next only treats files
 * directly under `pages/api/` as API routes, so an app's `pages/api` mounts at
 * `pages/api/<name>` and its paths become `/api/<name>/...` — the prefix goes
 * after `/api`, not before it.
 */
export const prefixPath = (
  value: string,
  prefix: string,
  apiViaPages = false
): string => {
  // An app served at the site root has nothing to prefix, and '/' must stay
  // '/' rather than becoming the empty prefix.
  if (prefix === '') return value
  if (!value.startsWith('/')) return value
  if (RESERVED.some((reserved) => value.startsWith(reserved))) return value
  if (apiViaPages && (value === '/api' || value.startsWith('/api/'))) {
    return `/api${prefix}${value.slice('/api'.length)}`
  }
  if (value === '/') return prefix
  return `${prefix}${value}`
}

const prefixRewrite = (rewrite: Rewrite, app: ResolvedApp): Rewrite => ({
  ...rewrite,
  source: prefixPath(rewrite.source, app.prefix, app.apiViaPages),
  destination: prefixPath(rewrite.destination, app.prefix, app.apiViaPages),
})

const prefixRedirect = <T extends Redirect>(redirect: T, app: ResolvedApp): T => ({
  ...redirect,
  source: prefixPath(redirect.source, app.prefix, app.apiViaPages),
  destination: prefixPath(redirect.destination, app.prefix, app.apiViaPages),
})

const prefixHeader = <T extends Header>(header: T, app: ResolvedApp): T => ({
  ...header,
  source: prefixPath(header.source, app.prefix, app.apiViaPages),
})

/** Rewrites are either a flat list or the three-phase object; normalize both. */
const toPhases = (
  rewrites: Rewrites | undefined
): { beforeFiles: Rewrite[]; afterFiles: Rewrite[]; fallback: Rewrite[] } => {
  if (!rewrites) return { beforeFiles: [], afterFiles: [], fallback: [] }
  if (Array.isArray(rewrites)) {
    return { beforeFiles: [], afterFiles: rewrites as Rewrite[], fallback: [] }
  }
  return {
    beforeFiles: (rewrites.beforeFiles ?? []) as Rewrite[],
    afterFiles: (rewrites.afterFiles ?? []) as Rewrite[],
    fallback: (rewrites.fallback ?? []) as Rewrite[],
  }
}

const call = async <T>(
  value: (() => T | Promise<T>) | undefined
): Promise<T | undefined> => (value ? await value() : undefined)

/**
 * Build the monolith's `rewrites`, keeping each phase's ordering: the
 * monolith's own entries stay ahead of the apps', and apps keep the order they
 * were declared in.
 */
export const mergeRewrites = async (
  base: NextConfig,
  apps: ResolvedApp[]
): Promise<NonNullable<NextConfig['rewrites']>> => {
  return async () => {
    const merged = toPhases(await call(base.rewrites))

    for (const app of apps) {
      const phases = toPhases(await call(app.nextConfig.rewrites))
      merged.beforeFiles.push(
        ...phases.beforeFiles.map((rule) => prefixRewrite(rule, app))
      )
      merged.afterFiles.push(
        ...phases.afterFiles.map((rule) => prefixRewrite(rule, app))
      )
      merged.fallback.push(...phases.fallback.map((rule) => prefixRewrite(rule, app)))
    }

    return merged
  }
}

export const mergeRedirects = async (
  base: NextConfig,
  apps: ResolvedApp[]
): Promise<NonNullable<NextConfig['redirects']>> => {
  return async () => {
    const merged = [...((await call(base.redirects)) ?? [])]
    for (const app of apps) {
      const redirects = (await call(app.nextConfig.redirects)) ?? []
      merged.push(...redirects.map((rule) => prefixRedirect(rule, app)))
    }
    return merged
  }
}

export const mergeHeaders = async (
  base: NextConfig,
  apps: ResolvedApp[]
): Promise<NonNullable<NextConfig['headers']>> => {
  return async () => {
    const merged = [...((await call(base.headers)) ?? [])]
    for (const app of apps) {
      const headers = (await call(app.nextConfig.headers)) ?? []
      merged.push(...headers.map((rule) => prefixHeader(rule, app)))
    }
    return merged
  }
}
