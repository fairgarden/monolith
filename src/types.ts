import type { NextConfig } from 'next'

/**
 * How the routes Next reads are produced from the committed source tree.
 *
 * The symlinks under `src/app/` are the readable view — they are committed, and
 * GitHub renders them as links you can follow to the app they point at. What
 * Next reads is derived from them:
 *
 * - `source` produces nothing. `next build` follows the committed symlinks, so
 *   it reads `src/app/` directly and there is no generated copy to go stale.
 * - `mirror` recreates the tree at `app/` and symlinks each file. `next dev`
 *   does not discover routes through a symlinked *directory*, but it does
 *   through a symlinked *file*, and because a symlink resolves by path, edits
 *   show up even when an editor saves by writing a new file and renaming it.
 * - `hardlink` and `copy` duplicate the files, for filesystems without usable
 *   symlinks. Both go stale when an editor replaces a file rather than writing
 *   through it, so they lean on the watcher.
 *
 * This chooses how the App Router tree is produced. The Pages Router tree is
 * always duplicated: Next resolves a route to its real path, and a Pages Router
 * route reached through a symlink loses its `pages/` root, which surfaces as a
 * missing `/_document` when the 404 is rendered.
 */
export type LinkStrategy = 'source' | 'mirror' | 'hardlink' | 'copy'

export interface MonolithApp {
  /** Directory of the app, relative to the monolith. */
  root?: string
  /**
   * Package to resolve the app from, e.g. `@fairgarden/id`.
   *
   * May be given alongside `root`, and is then the fallback: the checkout is
   * used when its routes are there, and the package when they are not. That is
   * what lets a private module build somewhere that could install the package
   * but not clone the submodule.
   */
  package?: string
  /** Routes directory. Defaults to `app/`, falling back to `src/app/`. */
  appDir?: string
  /** Static asset directory. Defaults to `public/`, omitted when absent. */
  publicDir?: string
  /**
   * Pages Router directory. Defaults to `pages/`, falling back to `src/pages/`,
   * and omitted when absent.
   */
  pagesDir?: string
  /**
   * Path to serve this app at. Defaults to `/<mount name>`.
   *
   * `/` serves it at the site root, which is what a `www` app wants: its
   * routes become `/about` rather than `/www/about`. Only one app can have it,
   * and its files sit alongside the monolith's own rather than under a
   * directory of their own.
   */
  prefix?: string
  /**
   * Config to merge for this app. Defaults to the app's own `next.config.*`.
   * Pass `false` to mount the routes without merging any config.
   */
  nextConfig?: NextConfig | NextConfigFn | false
}

export type NextConfigFn = (phase: string) => NextConfig | Promise<NextConfig>

/** Mount name -> app. A bare string is shorthand for a package name or path. */
export type MonolithApps = Record<string, string | MonolithApp>

export interface MonolithOptions {
  /**
   * Defaults to `auto`: `symlink` for builds, `hardlink` for `next dev`.
   * @see LinkStrategy
   */
  strategy?: LinkStrategy | 'auto'
  /** Monolith directory. Defaults to `process.cwd()`. */
  root?: string
  /**
   * Committed routes directory holding the app symlinks, relative to the
   * monolith. Defaults to `src/app`. Next reads it directly during builds.
   * The Pages Router tree is its `pages` sibling — `src/pages` by default.
   */
  sourceDir?: string
  /** Watch each app for changes. Defaults to true when mirroring for `next dev`. */
  watch?: boolean
  /**
   * Make each app resolvable by its own package name from inside itself.
   * Defaults to true. @see linkSelfReference
   */
  selfReference?: boolean
}

export interface ResolvedApp {
  /** Mount name; routes are served under `/<name>`. */
  name: string
  /** Path prefix the app is mounted at, e.g. `/id`. */
  prefix: string
  root: string
  /** The app's own package name, when it has one. */
  packageName: string | undefined
  /** Whether the files came from the checkout or from node_modules. */
  source: 'path' | 'package'
  appDir: string
  publicDir: string | undefined
  pagesDir: string | undefined
  /** The app's `pages/api`, when it has one. */
  pagesApiDir: string | undefined
  /**
   * Whether `/api/...` paths in this app's config are Pages Router API routes.
   *
   * Those mount at `/api/<name>/...`, because Next only treats files directly
   * under `pages/api/` as API routes — so unlike every other path, the prefix
   * goes after `/api`, not before it.
   */
  apiViaPages: boolean
  nextConfig: NextConfig
}
