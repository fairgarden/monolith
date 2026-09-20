import NextLink from 'next/link'
import type { ComponentProps } from 'react'
import { mountPrefix, prefixHref } from './mounts.ts'

export { createHref, mountPrefix, prefixHref, MOUNTS_ENV } from './mounts.ts'

type NextLinkProps = ComponentProps<typeof NextLink>

/**
 * A `next/link` that knows where its app is mounted.
 *
 * The monolith does not use `basePath`, so nothing prefixes an app's own hrefs
 * for it. Build one of these per app and use it in place of `next/link`:
 *
 * ```tsx
 * // lib/link.ts
 * export const Link = createLink('@fairgarden/id')
 * ```
 *
 * Standalone the prefix is empty and this is `next/link` with an extra call.
 */
export const createLink = (packageName: string) => {
  const prefix = mountPrefix(packageName)

  const MonolithLink = ({ href, ...props }: NextLinkProps) => (
    <NextLink href={prefixHref(href, prefix)} {...props} />
  )
  MonolithLink.displayName = `MonolithLink(${packageName})`
  return MonolithLink
}
