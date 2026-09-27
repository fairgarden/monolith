# Changelog

## 0.1.0-alpha.1

- Each app is told what the apps mounted beside it say about themselves — `MONOLITH_APPS`, each one's mount and the `fairgarden` part of its package.json — so they can wire themselves to one another, an identity service enrolling the apps that sign in with it ([#3](https://github.com/fairgarden/monolith/pull/3))
- Deploys to Vercel: an app's `public/` assets are real files while `next build` runs, so they are no longer copied as broken links ([#1](https://github.com/fairgarden/monolith/pull/1))

## 0.1.0-alpha.0
