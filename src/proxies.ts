import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import type { ResolvedApp } from './types.ts'

/**
 * The one kind of app proxy a monolith can run.
 *
 * A deployment has one proxy, so an app's own is never mounted. The locale
 * proxy from `@fairgarden/indicators` is different: `createLocaleProxy` takes
 * every app by its mount, so the monolith's proxy runs the same negotiation for
 * each app at its own root, and an app whose proxy is only that gives nothing
 * up by being mounted.
 *
 * (Not named `proxy.ts`: Next takes any file of that name near a project for
 * the project's own proxy.)
 */

// Taken from what the parser returns rather than from @babel/types, whose
// version need not be the one the parser was built against.
type Statement = ReturnType<typeof parse>['program']['body'][number]
type Declarator = Extract<Statement, { type: 'VariableDeclaration' }>['declarations'][number]
type ExportDefault = Extract<Statement, { type: 'ExportDefaultDeclaration' }>

const LOCALE_PROXY_MODULE = '@fairgarden/indicators/proxy'
const LOCALE_PROXY = 'createLocaleProxy'

/** What Next reads as a proxy, `middleware` being its older name. */
const PROXY_NAMES = ['proxy', 'middleware']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** A project's proxy, at its root or under `src/`, as Next looks for one. */
export const findProxy = (root: string): string | undefined => {
  for (const dir of ['', 'src']) {
    for (const name of PROXY_NAMES) {
      for (const extension of EXTENSIONS) {
        const candidate = path.join(root, dir, `${name}${extension}`)
        if (isFile(candidate)) return candidate
      }
    }
  }
  return undefined
}

const statementsOf = (file: string): Statement[] | undefined => {
  try {
    const ast = parse(readFileSync(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })
    return ast.program.body
  } catch {
    return undefined
  }
}

/**
 * Whether a proxy file is only the locale proxy: `proxy` (or `middleware`, or
 * the default export) is a call to `createLocaleProxy`, and the only other
 * export is `config`.
 *
 * Anything it cannot read that plainly — a wrapper around the call, a
 * re-export, another export — counts as a proxy of the app's own, which is
 * the safe answer: that one does need moving to the monolith.
 */
export const isLocaleProxy = (file: string): boolean => {
  const statements = statementsOf(file)
  if (!statements) return false

  // What the import is called here, which it may have been renamed to.
  const names = new Set<string>()
  for (const statement of statements) {
    if (statement.type !== 'ImportDeclaration') continue
    if (statement.source.value !== LOCALE_PROXY_MODULE) continue
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        specifier.imported.name === LOCALE_PROXY
      ) {
        names.add(specifier.local.name)
      }
    }
  }
  if (names.size === 0) return false

  const isCall = (node: Declarator['init'] | ExportDefault['declaration']): boolean =>
    node?.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    names.has(node.callee.name)

  let proxies = 0
  for (const statement of statements) {
    if (statement.type === 'ExportAllDeclaration') return false
    if (statement.type === 'ExportDefaultDeclaration') {
      if (!isCall(statement.declaration)) return false
      proxies += 1
      continue
    }
    if (statement.type !== 'ExportNamedDeclaration') continue
    if (statement.specifiers.length > 0) return false
    if (statement.declaration?.type !== 'VariableDeclaration') return false
    for (const declarator of statement.declaration.declarations) {
      if (declarator.id.type !== 'Identifier') return false
      if (declarator.id.name === 'config') continue
      if (!PROXY_NAMES.includes(declarator.id.name) || !isCall(declarator.init)) return false
      proxies += 1
    }
  }
  return proxies === 1
}

const keyName = (node: { type: string; name?: unknown; value?: unknown }): string | undefined =>
  node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : node.type === 'StringLiteral' && typeof node.value === 'string'
      ? node.value
      : undefined

/**
 * The paths a proxy file's `config.matcher` names, read from the source as
 * Next reads it. Undefined when there is no literal matcher to read, in which
 * case the proxy runs for every path.
 */
export const proxyMatcher = (file: string): string[] | undefined => {
  for (const statement of statementsOf(file) ?? []) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    if (statement.declaration?.type !== 'VariableDeclaration') continue
    for (const declarator of statement.declaration.declarations) {
      if (declarator.id.type !== 'Identifier' || declarator.id.name !== 'config') continue
      if (declarator.init?.type !== 'ObjectExpression') return undefined
      for (const property of declarator.init.properties) {
        if (property.type !== 'ObjectProperty' || keyName(property.key) !== 'matcher') continue
        const entries =
          property.value.type === 'ArrayExpression' ? property.value.elements : [property.value]
        return entries.flatMap((entry) => {
          if (entry?.type === 'StringLiteral') return [entry.value]
          if (entry?.type !== 'ObjectExpression') return []
          const source = entry.properties.find(
            (field) => field.type === 'ObjectProperty' && keyName(field.key) === 'source'
          )
          return source?.type === 'ObjectProperty' && source.value.type === 'StringLiteral'
            ? [source.value.value]
            : []
        })
      }
      return undefined
    }
  }
  return undefined
}

export interface UnservedProxy {
  app: ResolvedApp
  message: string
}

/**
 * Mounted apps with a locale proxy that the monolith's own proxy does not run
 * at their mount, so nobody arriving at that app's root is offered their
 * language.
 *
 * Only an app root counts: that is the one path the locale proxy acts on. A
 * monolith proxy with no literal matcher runs everywhere and is taken on trust.
 */
export const unservedLocaleProxies = (
  monolithRoot: string,
  apps: ResolvedApp[]
): UnservedProxy[] => {
  const withLocaleProxy = apps.flatMap((app) => {
    const file = findProxy(app.root)
    return file && isLocaleProxy(file) ? [{ app, file }] : []
  })
  if (withLocaleProxy.length === 0) return []

  const own = findProxy(monolithRoot)
  const matcher = own ? proxyMatcher(own) : []
  if (matcher === undefined) return []

  const where = own ? path.relative(monolithRoot, own) : 'proxy.ts'
  return withLocaleProxy
    .filter(({ app }) => !matcher.includes(app.prefix || '/'))
    .map(({ app, file }) => {
      const mount = app.prefix || '/'
      return {
        app,
        message:
          `"${app.name}" negotiates its locale in ${path.basename(file)}, which a ` +
          `monolith does not mount; its own ${where} has to do it at ${mount}. ` +
          `Add the app to createLocaleProxy({ '${mount}': ... }) there, and '${mount}' ` +
          'to its config.matcher.',
      }
    })
}
