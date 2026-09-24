# FairGarden Monolith

<!-- fg:version -->

Version **0.1.0-alpha.1**

<!-- /fg:version -->

<!-- fg:releasing -->

## Releasing

This module releases on its own. `0.1.0-alpha.1` is what main is working towards,
not what is published — the version here is always the next one.

1. **Publish it.** Run the *Publish* workflow from the Actions tab, picking the
   dist tag. It refuses if that version is already on npm.
2. **Move it on.** `pnpm release` — opens a pull request bumping this branch
   to `0.1.0-alpha.2`, or `pnpm release --id rc` to change
   identifier. A prerelease gets no maintenance branch; there is no released
   line behind it yet.

Every push to main publishes `@fairgarden/monolith@canary`. A canary is not a release and
carries no promise; it is there so main can be tried without a checkout.

<!-- /fg:releasing -->

Compose several Next.js apps into one deployable app.

```ts
// apps/monolith/next.config.ts
import { withMonolith } from '@fairgarden/monolith'

export default withMonolith(
  {},
  {
    www: { package: '@fairgarden/www', prefix: '/' },
    id: '@fairgarden/id',
  }
)
```

`id`'s routes are served from `/id`, its assets from `public/id`, and its Pages
Router API from `/api/id`. `www` takes the site root.

## Documentation

The docs are a site in this repository. Run them with:

```bash
pnpm --filter @fairgarden/monolith-docs dev
```

- **Overview** — what mounting an app actually does
- **Mounting** — symlinks, and why `next dev` needs different treatment
- **Routing** — how rewrites, redirects and headers are merged
- **What a monolith can serve** — root mounts, and when apps collide
- **Next versions** — which versions can be mounted together
- **Dependencies** — what the monolith has to install
- **Portability** — keeping an app mountable
- **Functions** — `withMonolith`, `createLink`, `prefixPath` and the rest

## Install

```bash
pnpm add @fairgarden/monolith
```

| Import | For |
| --- | --- |
| `@fairgarden/monolith` | the monolith's `next.config.ts`, and an app's portability check |
| `@fairgarden/monolith/link` | an app's own components |
| `@fairgarden/monolith/eslint` | an app's `eslint.config.mjs` |

It also installs `fg-monolith`, for the things that happen around a build:

```bash
fg-monolith link                 # mount without starting Next
fg-monolith merge-package-json   # fold each app's dependencies in
fg-monolith list                 # print the apps it composes
```

Submodules, versions and scaffolding are a separate concern, handled by
`fg-dist` in `@fairgarden/distribution`.
