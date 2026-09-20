/**
 * Environment variable carrying where each app is mounted, as a JSON object
 * keyed by package name.
 *
 * `basePath` is not used, so nothing prefixes an app's own URLs for it. An app
 * that generates absolute paths — an OIDC discovery document, a link back to
 * itself — reads its mount from here and prefixes them itself. Unset when the
 * app runs standalone, which is the same as being mounted at the root.
 */
export const MOUNTS_ENV = 'MONOLITH_MOUNTS'

/**
 * The shape of a `next/link` href, without depending on Next to say so.
 *
 * `pathname` is nullable because Next's own `UrlObject` allows it.
 */
export type Href = string | { pathname?: string | null | undefined }

/**
 * Where this app is mounted, or `''` when it is running on its own.
 *
 * `process.env.MONOLITH_MOUNTS` is written out in full because bundlers only
 * substitute a literal member access — a computed `process.env[NAME]` survives
 * into the bundle and reads as undefined in the browser.
 */
export const mountPrefix = (packageName: string): string => {
  try {
    const mounts = JSON.parse(process.env.MONOLITH_MOUNTS ?? '{}') as Record<
      string,
      string
    >
    return mounts[packageName] ?? ''
  } catch {
    return ''
  }
}

/**
 * Move an app-relative href into the app's mount point.
 *
 * Only paths rooted at `/` belong to the app. Absolute URLs, protocol-relative
 * URLs, fragments and relative paths are left alone, as is a path that already
 * carries the prefix.
 */
export const prefixHref = <T extends Href>(href: T, prefix: string): T => {
  if (!prefix) return href

  if (typeof href === 'string') {
    if (!href.startsWith('/') || href.startsWith('//')) return href
    if (href === prefix || href.startsWith(`${prefix}/`)) return href
    return `${prefix}${href}` as T
  }

  if (href && typeof href === 'object' && typeof href.pathname === 'string') {
    return { ...href, pathname: prefixHref(href.pathname, prefix) } as T
  }

  return href
}

/** Build an app-relative path, for `router.push` and friends. */
export const createHref =
  (packageName: string) =>
  (path: string): string =>
    prefixHref(path, mountPrefix(packageName))
