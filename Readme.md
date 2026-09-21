# FairGarden Monolith

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
