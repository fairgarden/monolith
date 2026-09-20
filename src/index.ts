import path from 'node:path'
import type { NextConfig } from 'next'
import { assertCompatible } from './compat.ts'
import { linkApps } from './link.ts'
import { resolveApps } from './resolve.ts'
import { mergeHeaders, mergeRedirects, mergeRewrites } from './routes.ts'
import { MOUNTS_ENV } from './mounts.ts'
import type {
  LinkStrategy,
  MonolithApps,
  MonolithOptions,
  ResolvedApp,
} from './types.ts'

export type {
  LinkStrategy,
  MonolithApp,
  MonolithApps,
  MonolithOptions,
  ResolvedApp,
} from './types.ts'
export { prefixPath } from './routes.ts'

export { MOUNTS_ENV } from './mounts.ts'
export {
  withMonolithicPortability,
  findPortabilityProblems,
  type PortabilityOptions,
} from './portability.ts'

const PHASE_DEVELOPMENT_SERVER = 'phase-development-server'

/**
 * Set by the CLI, which loads the monolith's config only to discover which apps
 * it composes and must not touch the file tree while doing so.
 */
const skipLinking = (): boolean => process.env.FG_MONOLITH_SKIP_LINK === '1'

/** Apps seen by the most recent `withMonolith` evaluation, for the CLI. */
let registered: ResolvedApp[] = []

export const getRegisteredApps = (): ResolvedApp[] => registered

/**
 * `next build` follows the committed symlinks, so it reads the source tree as
 * it stands. `next dev` does not discover routes through a symlinked
 * directory, so it gets a derived tree with the files symlinked individually.
 */
const pickStrategy = (
  strategy: MonolithOptions['strategy'],
  phase: string
): LinkStrategy => {
  if (strategy && strategy !== 'auto') return strategy
  return phase === PHASE_DEVELOPMENT_SERVER ? 'mirror' : 'source'
}

/**
 * Compose several Next.js apps into one deployable app.
 *
 * Each app's routes are mounted at `/<name>` and its assets at
 * `public/<name>`, and its rewrites, redirects and headers are merged into the
 * monolith's with that same prefix.
 *
 * ```ts
 * export default withMonolith(
 *   { reactStrictMode: true },
 *   { id: '@fairgarden/id', membership: '@fairgarden/membership' }
 * )
 * ```
 *
 * Apps may live in the surrounding monorepo or be plain dependencies. Because
 * `basePath` is not used, links inside an app are not prefixed automatically —
 * see the package README.
 */
export const withMonolith = (
  nextConfig: NextConfig = {},
  apps: MonolithApps = {},
  options: MonolithOptions = {}
): ((phase: string) => Promise<NextConfig>) => {
  return async (phase: string): Promise<NextConfig> => {
    const root = options.root ?? process.cwd()
    const resolved = await resolveApps(root, apps, phase)

    assertCompatible(nextConfig, resolved, root)
    registered = resolved

    if (!skipLinking()) {
      const strategy = pickStrategy(options.strategy, phase)
      const sourceDir = path.resolve(
        root,
        options.sourceDir ?? path.join('src', 'app')
      )
      await linkApps(root, resolved, {
        strategy,
        sourceDir,
        sourcePagesDir: path.join(path.dirname(sourceDir), 'pages'),
        selfReference: options.selfReference,
        // Only needed to notice routes being added or removed.
        watch:
          options.watch ??
          (strategy !== 'source' && phase === PHASE_DEVELOPMENT_SERVER),
      })
    }

    const mounts = Object.fromEntries(
      resolved.flatMap((app) =>
        app.packageName ? [[app.packageName, app.prefix]] : []
      )
    )

    return {
      ...nextConfig,
      env: { ...nextConfig.env, [MOUNTS_ENV]: JSON.stringify(mounts) },
      rewrites: await mergeRewrites(nextConfig, resolved),
      redirects: await mergeRedirects(nextConfig, resolved),
      headers: await mergeHeaders(nextConfig, resolved),
    }
  }
}

export default withMonolith
