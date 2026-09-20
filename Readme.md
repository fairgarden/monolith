# FairGarden Monolith

Composes several Next.js apps into one deployable app.

Versioning, submodules and scaffolding live in `@fairgarden/distribution` and
its `fg-dist` command; this package is only about mounting apps into one Next
deployment. A distribution that extends another may not ship a module older
than its parent, and `withMonolith` refuses to build when it does.

Next.js only supports `basePath` when using monorepos. This is best when creating production applications as it allows each package to be built separately and only the necessary packages are built when changes are made. It also allows different Next.js configurations for each app.

Although, when you are developing software that can be self hosted, you may want a monolithic application that can be deployed as a single unit where everything in bundled in a cohesive package. This method should be limited to the `core` or `starter` style distributions where not many advanced features are needed. The `enterprise` or `full` distributions should be split into separate deployments.

In the simplest case, the monolithic application could be shipped as a single binary. This is great for demos.

## Starting a repository

Both kinds of repository can be scaffolded without installing anything:

```bash
pnpx @fairgarden/distribution init monolith acme --url https://github.com/acme/acme.git
pnpx @fairgarden/distribution init module acme-widget --name @acme/widget \
  --url https://github.com/acme/widget.git
```

`--url` is where the repository will live. It becomes the `origin` remote and
the `repository` field, and matters most for a module, since a monolith adds it
as a submodule by that URL.

A **monolith** repo is a pnpm workspace with `apps/monolith` in it, ready to
mount modules. A **module** repo is an ordinary Next app with the portability
check, the lint rules and a portable `Link` already wired up. Both run `git
init`, which `--no-git` skips, and neither will write over a directory that
already has anything in it.

Add a module to a monolith:

```bash
fg-dist add-module git@github.com:acme/widget.git
```

That adds it as a submodule under `apps/`, depends on it from the monolith, and
writes the mount into the monolith's `next.config.ts`:

```ts
  {
    'my-widget': '@acme/widget',
    // mount name -> module, added by `fg-dist add-module`
  }
```

The config is parsed to find where the mount map is and the entry is spliced
into the original text, so the rest of the file keeps its formatting and its
comments. When the config is shaped in a way it cannot edit — the apps declared
somewhere else, say — it says so and prints the line to add, rather than failing
a command that has already added the submodule.

## Submodule URLs

`.gitmodules` is committed, so whatever URL is recorded there is what every
later clone uses — including a build host that has no SSH key. Vercel clones
submodules over HTTPS and only public ones, so an `scp`-style or `ssh://` URL
checks out fine locally and then fails in the build.

`add-module` and `init --url` therefore rewrite SSH URLs to HTTPS and say that
they did. `--ssh` records the URL as given, for a module only a developer's
machine will ever clone.

`sync` reports submodules already recorded with an SSH URL, and
`fg-dist use-https` rewrites them in one go:

```bash
fg-dist use-https             # rewrite every ssh url
fg-dist use-https id design   # only these
fg-dist use-https --dry-run   # report without changing .gitmodules
```

It updates `.gitmodules`, runs `git submodule sync` so the existing checkouts
follow, and leaves the change for you to commit. HTTPS is necessary but not
sufficient, so it then checks whether each one can actually be read with no
credentials — which is the question a build host asks — and exits non-zero when
any cannot:

```
  apps/id  public
  apps/members  not readable

1 of these cannot be read anonymously, so a build host still cannot clone them.
Make them public, or expect the build to fail.
```

`--no-verify` skips the check.

## When a module cannot be cloned

A module does not have to come from a submodule. Give an app both a `root` and
a `package` and the checkout is used when its routes are there, with the package
as the fallback:

```ts
withMonolith(config, {
  id: { root: '../id', package: '@fairgarden/id' },
})
```

An empty directory is what a build host leaves behind when it cannot read a
submodule's remote, and that is exactly when the package takes over. A private
package installs with a token, which is a credential a build host can be given,
whereas a private submodule needs an SSH key it cannot have.

The files are copied rather than linked, which is not an optimisation: Turbopack
will not process a route whose real path is inside `node_modules`, so a mounted
package has to be materialised outside it. That happens automatically — a
package-sourced app is copied while the others are still symlinked.


## Getting Started

```ts
// apps/monolith/next.config.ts

import { withMonolith } from '@fairgarden/monolith'

export default withMonolith(
  {
    // Add your Next.js config here
  },
  {
    id: '@fairgarden/id',
    membership: '@fairgarden/membership',
  }
)
```

Each key is the path the app is mounted at. Apps included in the monolith can be
within the current monorepo, or they can just be dependencies — a bare string is
treated as a path when it looks like one and as a package name otherwise:

```ts
withMonolith(config, {
  id: '@fairgarden/id', // resolved from node_modules
  membership: '../membership', // resolved relative to the monolith
  admin: { root: '../admin', appDir: 'src/app' }, // explicit
})
```

This maintains a symlink per app, which are committed:

```bash
src/app/
  id/ -> ../../../id/app/ OR ../../node_modules/@fairgarden/id/app/
  membership/ -> ../../../membership/app/ OR ../../node_modules/@fairgarden/membership/app/
public/
  id/ -> ../../id/public/ OR ../node_modules/@fairgarden/id/public/
  membership/ -> ../../membership/public/ OR ../node_modules/@fairgarden/membership/public/
src/pages/api/
  id/ -> ../../../../id/pages/api/ OR ../../../node_modules/@fairgarden/id/pages/api/
```

These are the readable view of the composition: GitHub renders them as links you
can follow straight to the app they point at, so the repository shows what the
monolith is made of without anyone having to read the config.

## Symlinks and `next dev`

`next build` follows a symlinked directory, so it reads `src/app/` as committed
and needs nothing generated. **`next dev` does not** — it serves a 404 for every
route underneath a symlinked directory. So `app/` is derived from `src/app/` for
development only, and is gitignored:

| Strategy | What it produces | Used by |
| --- | --- | --- |
| `source` | nothing; Next reads `src/app/` | `next build` |
| `mirror` | `app/`: real directories, one symlink per file | `next dev` |
| `hardlink` / `copy` | `app/`: duplicated files | opt-in, for filesystems without usable symlinks |

`mirror` gives `next dev` the real directories it needs to walk, while each
route file stays a symlink. `next dev` will not follow a symlinked *directory*
but does follow a symlinked *file*, and because a symlink resolves by path
rather than by inode, edits show up immediately even when an editor saves by
writing a new file and renaming it over the old one — which is exactly where
`hardlink` goes stale. A watcher re-derives the tree when files are added or
removed.

`public/` needs none of this: static assets are served straight through the
committed symlink, in both development and production.

The **Pages Router is different**: Next resolves a route to its real path, and a
Pages Router route reached through a symlink loses track of its `pages/` root.
The build then fails looking for `/_document` while rendering the 404 — a
confusing symptom of a resolution problem. So `pages/` is always materialised as
real files (`hardlink`, falling back to `copy`), never symlinked, whatever the
App Router is doing. And because Next refuses to run when `app` and `pages` sit
in different folders, an app with a Pages Router forces `app/` to be derived
too, so `source` quietly becomes `mirror`.

`auto` (the default) picks `source` for builds and `mirror` for `next dev`.
Override it if you need to:

```ts
withMonolith(config, apps, { strategy: 'copy' })
```

The committed directory defaults to `src/app` and can be moved with
`{ sourceDir: 'routes' }`. Because Next prefers `app/` over `src/app/` when both
exist, a build clears any `app/` left behind by a dev session rather than let it
shadow the committed tree.

## Next versions

The monolith compiles every app with its own Next, so an app can never need a
newer one than the monolith has. Exact agreement is not required — an app pinned
to 16.3.0 is fine inside a monolith on 16.3.5 — but the majors have to match and
the monolith has to be at least as new as the newest app. `withMonolith` reads
the Next each package actually resolves, not the range it asks for, and refuses
to start otherwise:

```
Incompatible Next config in the monolith:
  - "membership" is built for Next 16.9.0 but the monolith runs 16.3.5. The
    monolith compiles every app, so it has to be at least as new as the newest one.
```

The check is skipped when a version cannot be resolved, which is the case while
tooling loads a config outside an install.

## Serving an app at the root

An app mounted as `www` would serve `/www/about`. A marketing site wants
`/about`, so give it the root:

```ts
withMonolith(config, {
  www: { package: '@fairgarden/www', prefix: '/' },
  id: '@fairgarden/id',
})
```

`www` then supplies `/` and `/about`, while `id` stays at `/id/login`. Its
paths are not prefixed at all, and its files sit alongside the monolith's own
rather than under a directory of their own — its `layout.tsx` becomes the
monolith's root layout.

That last part means the monolith cannot also have one. A clash is refused by
name rather than silently resolved, since two files cannot both be
`/page.tsx`, and only one app can take the root.

## When a monolith will not do

Every app's routes have to fit in one tree, and a path can only belong to one of
them. Before anything is mounted, `withMonolith` works out what each app would
serve and refuses when two of them, or an app and the monolith, want the same
path:

```
These apps cannot be served from one deployment:
  - "www" and "id" both serve src/app/id (routes).
A path can only belong to one of them. Rename a mount, or deploy the apps
separately — a subdomain each — rather than as a monolith.
```

This covers routes, static assets and Pages Router api routes, and it runs
before any file is written: a colliding mount used to quietly replace whatever
was there.

Most distributions never collide — a mount name is a whole path segment, and
apps rarely claim each other's. The ones that do are the ones that cannot be a
monolith at all, which is worth finding out at build time rather than in
production. Deploy those apps separately, a subdomain each; a distribution
scaffolded with `--separate` is that shape.

## Configuration merging

Each app's `next.config.*` is loaded and its `rewrites`, `redirects` and
`headers` are merged into the monolith's, with every `source` and `destination`
moved under the app's mount point. Next's own paths (`/_next/...`) and absolute
URLs are left alone. The monolith's own entries stay ahead of the apps', and
rewrite phases (`beforeFiles`, `afterFiles`, `fallback`) are preserved.

Many of the configurations need to be the same across all apps. Localization has
to be enabled on all or none. Rather than merge these silently, `withMonolith`
refuses to start when an app disagrees with the monolith about `i18n`,
`trailingSlash`, `skipTrailingSlashRedirect`, `skipMiddlewareUrlNormalize`,
`output` or `assetPrefix`, or when an app sets `basePath` or `distDir` — which
only the monolith may set. This is why it is recommended to only use the
monolith functionality for the `core` or `starter` distributions.

## The Pages Router

An app's `pages/api` mounts at `pages/api/<name>`, so its routes are served from
`/api/<name>/...` — **not** `/<name>/api/...`. Next only treats files directly
under `pages/api/` as API routes, so nesting the directory under the app's mount
would turn the handlers into pages. Anything else in an app's `pages/` is
mounted at `pages/<name>/` as usual.

Paths in the app's config follow the same rule, so a rewrite of
`/oidc/:path*` -> `/api/oidc/:path*` becomes
`/id/oidc/:path*` -> `/api/id/oidc/:path*`. This only applies to apps that
actually have a `pages/api`; for everything else `/api/...` is an App Router
route handler and moves under the app's mount like any other path.

## Knowing where an app is mounted

`basePath` is not used, so nothing prefixes an app's own URLs for it. An app is
told where it lives through the `MONOLITH_MOUNTS` environment variable, a JSON
object keyed by package name, which `withMonolith` sets. It is unset when the
app runs on its own, which is the same as being mounted at the root, so the same
code works either way.

### Links

Build a `Link` once per app and use it in place of `next/link`:

```tsx
// lib/link.ts
import { createLink } from '@fairgarden/monolith/link'

export const Link = createLink('@fairgarden/id')
```

`<Link href="/settings">` renders `/settings` standalone and `/id/settings`
mounted. Absolute URLs, protocol-relative URLs, fragments and relative paths are
left alone, and a path that already carries the prefix is not prefixed twice.
Object hrefs have their `pathname` moved and everything else kept.

`createHref('@fairgarden/id')` does the same for imperative navigation
(`router.push`), and `mountPrefix('@fairgarden/id')` gives the raw prefix for
anything else that builds a URL — an OIDC discovery document, a callback URL.

These read the mount at module scope so the bundler folds it into a constant.
Note that `process.env.MONOLITH_MOUNTS` has to be written out in full wherever
it is read: bundlers only substitute a literal member access, and a computed
`process.env[name]` survives into the bundle and reads as undefined in the
browser.

## Checking an app stays portable

Wrap an app's own config to have it report, on every build, whatever would not
survive being mounted:

```ts
// apps/id/next.config.ts
import { withMonolithicPortability } from '@fairgarden/monolith'

export default withMonolithicPortability(nextConfig)
```

It changes nothing about how the app runs on its own. It reports:

- **Config the monolith owns** — `basePath` and `distDir`, which would fight the
  monolith, and `i18n`, `trailingSlash`, `skipTrailingSlashRedirect`,
  `skipMiddlewareUrlNormalize`, `output` and `assetPrefix`, which have to agree
  across every app because one server serves all of them.
- **Conventions a deployment only gets one of** — `proxy`/`middleware`,
  `instrumentation`, `pages/_app` and `pages/_document`. An app can use these on
  its own, but mounting several apps means only one could ever win, so rather
  than let one app's copy silently disappear it says so.
- **Routes that only mean anything at the site root** — `robots`, `sitemap` and
  `manifest`, which end up at `/<name>/robots.txt` where nothing looks for them.

`level: 'error'` makes it a gate rather than a reminder, and `ignore` accepts a
finding by the text before its colon:

```ts
withMonolithicPortability(nextConfig, { level: 'error', ignore: ['proxy.ts'] })
```

`findPortabilityProblems(config, root)` returns the same list, for a test or a
CI check that would rather assert than scrape log output.

## Dependencies

Listing an app as a dependency of the monolith gets you most of the way: an App
Router route is only symlinked, so Turbopack resolves it at its real path inside
the app and finds the app's own `node_modules` from there. It is not quite
enough, for two reasons.

- **Pages Router files are copied**, so their real path is inside the monolith
  and the app's `node_modules` is no longer above them. Nothing they import
  resolves.
- **TypeScript resolves from where the file sits in the monolith**, not from the
  symlink's target, so even App Router routes fail to type check against the
  app's dependencies. Turbopack compiles them happily, which makes this easy to
  miss — the build gets all the way to `Running TypeScript` first.

So `fg-monolith merge-package-json` reads what the route trees actually import
and folds just those into the monolith's `package.json`, resolving conflicting
ranges by semver rather than by whichever app happens to be last:

```bash
fg-monolith merge-package-json           # writes package.json
fg-monolith merge-package-json --check   # exits 1 if out of date, for CI
fg-monolith merge-package-json --all     # every dependency, not just imports
fg-monolith link                         # mount without starting Next
fg-monolith list                         # print the apps and where they resolved to
```

Only *direct* imports are taken. Anything an app reaches through its own package
name resolves via the monolith's link to the app and carries on from there, so
it needs nothing. Workspace and link ranges are skipped, since those are linked
rather than installed, and a `@types/` package is taken along with whatever it
describes.

In this repository that is the difference between 15 packages and 24: scanning
leaves behind the app's own lint plugins and the dependencies of a proxy that
the monolith does not mount. Use `--all` if something outside the route trees is
resolved from the monolith.

The app list comes from the monolith's own `next.config.*`, so it stays the
single source of truth.

## Keeping modules up to date

Modules are git submodules, so a module's version is the commit the repository
pins. `sync` compares each one against the version tags its repository carries:

```bash
fg-dist sync
```

```
apps/id          v1.0.0  -> v1.0.1 (patch), v1.1.0 (minor), v2.0.0 (major)
packages/design  v0.3.0  -> v0.3.1 (patch)
apps/members     untagged  no version tags

2 module(s) have newer versions. Run `fg-dist bump` to take them, or
`fg-dist bump --major` to include the 1 major upgrade(s).
```

`bump` moves each submodule to its newest version, holding majors back unless
asked. It changes nothing but the checkout — no `package.json` is touched, so
pnpm stays in charge of package versions — and leaves the new pointers for you
to commit:

```bash
fg-dist bump                 # newest patch or minor
fg-dist bump --major         # include majors
fg-dist bump id design       # only these
fg-dist bump --dry-run       # report without moving
```

Both fetch first; `--no-fetch` uses the refs you already have, and an
unreachable remote is reported rather than fatal.

Only tags that name a version count as an upgrade. Commits past the newest tag
are counted and shown, but never bumped to — a commit carries no statement about
what changed, which is what the version is for. A module with no tags at all is
listed and left alone.

`bump` refuses to move a submodule with uncommitted changes, rather than fail
part way through or discard the work.

## Importing within an app

A mounted app's route files are not where they appear to be. Under `next dev`
the App Router tree is rebuilt with each file symlinked, and the Pages Router
tree is always duplicated outright — so a relative import that climbs out of
`app/` or `pages/` no longer lands anywhere:

```ts
// apps/id/app/[locale]/page.tsx
import { defaultLocale } from '../../../lib/constants/localization'
```

That compiles perfectly on its own, and in the monolith Turbopack cannot resolve
it from `pages/`, while from `app/` it resolves but fails the type check. Both
are integration-time failures for something a lint rule can catch immediately.

Import by package name instead, which resolves from anywhere because
`withMonolith` gives each app a self-reference:

```ts
import { defaultLocale } from '@fairgarden/id/lib/constants/localization'
```

The ESLint plugin enforces this:

```js
// apps/id/eslint.config.mjs
import monolith from '@fairgarden/monolith/eslint'

export default [...monolith.configs.recommended]
```

- **`no-escaping-relative-imports`** (error) — a relative import inside `app/`
  or `pages/` may not resolve above that directory. Relative imports that stay
  inside the tree are fine, since the tree moves as a unit. Autofixes to the
  package-name import, taking the name from the app's own `package.json` or from
  `{ packageName }`. Covers re-exports and dynamic `import()` too.
- **`no-next-link`** (warn) — `next/link` does not prefix hrefs with the app's
  mount. Point it at your own Link with
  `{ replacement: '@fairgarden/id/lib/link' }`.

Both only apply to files inside a route tree; a shared `lib/` is left alone.

## Limitations

Because `basePath` isn't enabled for each app, links won't have `/id/` prefixed
to them automatically. This means that a monolith deployment only works with a
wildcard domain or a subdomain. This is a limitation of the monolith deployment.

Otherwise, `next/link` would have to be extended to include the prefix. It might
be that `next/link` has to be extended anyway to support custom localization and
other features.
