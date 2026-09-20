import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Minimal shapes from ESLint's rule API.
 *
 * Declared here rather than depending on `@types/eslint`, which would pull a
 * whole toolchain into a package apps install to run their own builds.
 */
interface SourceNode {
  value?: unknown
  range?: [number, number]
}
interface ImportNode {
  source?: SourceNode | null
  arguments?: SourceNode[]
  callee?: { type?: string; name?: string }
  type?: string
}
interface RuleContext {
  filename?: string
  getFilename?: () => string
  options: unknown[]
  report: (descriptor: {
    node: unknown
    message: string
    fix?: (fixer: { replaceText: (node: unknown, text: string) => unknown }) => unknown
  }) => void
}
type Visitor = Record<string, ((node: ImportNode) => void) | undefined>
interface Rule {
  meta: Record<string, unknown>
  create: (context: RuleContext) => Visitor
}

/** Directory names Next treats as a route tree. */
const ROUTE_DIRS = ['app', 'pages']

const filenameOf = (context: RuleContext): string =>
  context.filename ?? context.getFilename?.() ?? ''

const packageRootCache = new Map<string, string | undefined>()

/** Nearest directory above `from` holding a package.json. */
const packageRoot = (from: string): string | undefined => {
  const cached = packageRootCache.get(from)
  if (cached !== undefined || packageRootCache.has(from)) return cached

  let current = from
  let found: string | undefined
  for (;;) {
    if (existsSync(path.join(current, 'package.json'))) {
      found = current
      break
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  packageRootCache.set(from, found)
  return found
}

const packageNameOf = (root: string): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    return typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

/**
 * The route tree this file belongs to, if any.
 *
 * Looks for `app/` or `pages/` directly under the package root, or under
 * `src/`, which is where Next looks too.
 */
const routeRootOf = (filename: string, root: string): string | undefined => {
  const relative = path.relative(root, filename)
  if (relative.startsWith('..')) return undefined

  const segments = relative.split(path.sep)
  const [first, second] = segments
  if (ROUTE_DIRS.includes(first)) return path.join(root, first)
  if (first === 'src' && ROUTE_DIRS.includes(second)) {
    return path.join(root, 'src', second)
  }
  return undefined
}

const isRelative = (request: string): boolean =>
  request === '.' || request === '..' || /^\.\.?\//.test(request)

const sourcesOf = (node: ImportNode): SourceNode[] => {
  if (node.source) return [node.source]
  // `import()` is an ImportExpression, whose argument list is `arguments`;
  // `require()` is a CallExpression whose callee is the identifier.
  if (node.type === 'ImportExpression' && node.arguments) return node.arguments
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments
  ) {
    return node.arguments
  }
  return []
}

const escapingImports: Rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow relative imports that reach outside a route tree, which do not survive being mounted in a monolith',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: { packageName: { type: 'string' } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = filenameOf(context)
    const root = packageRoot(path.dirname(filename))
    if (!root) return {}

    const routeRoot = routeRootOf(filename, root)
    if (!routeRoot) return {}

    const option = (context.options[0] ?? {}) as { packageName?: string }
    const packageName = option.packageName ?? packageNameOf(root)

    const check = (node: ImportNode): void => {
      for (const source of sourcesOf(node)) {
        const request = source.value
        if (typeof request !== 'string' || !isRelative(request)) continue

        const resolved = path.resolve(path.dirname(filename), request)
        const inside = path.relative(routeRoot, resolved)
        if (!inside.startsWith('..')) continue

        const fromRoot = path.relative(root, resolved).split(path.sep).join('/')
        // An import that climbs out of the package has no package-name form;
        // offering one would fix working code into `@scope/name/../outside`.
        const insidePackage = !fromRoot.startsWith('..')
        const replacement =
          packageName && insidePackage ? `${packageName}/${fromRoot}` : undefined

        context.report({
          node: source,
          message: replacement
            ? `Relative import reaches outside ${path.basename(routeRoot)}/ and breaks once this app is mounted. Use '${replacement}'.`
            : `Relative import reaches outside ${path.basename(routeRoot)}/ and breaks once this app is mounted. Import it by package name.`,
          ...(replacement && source.range
            ? {
                fix: (fixer) =>
                  fixer.replaceText(source, `'${replacement}'`),
              }
            : {}),
        })
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      CallExpression: check,
    }
  },
}

const nextLink: Rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow next/link in route trees, whose hrefs are not prefixed when the app is mounted',
    },
    schema: [
      {
        type: 'object',
        properties: { replacement: { type: 'string' } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = filenameOf(context)
    const root = packageRoot(path.dirname(filename))
    if (!root || !routeRootOf(filename, root)) return {}

    const option = (context.options[0] ?? {}) as { replacement?: string }

    const check = (node: ImportNode): void => {
      for (const source of sourcesOf(node)) {
        if (source.value !== 'next/link') continue
        context.report({
          node: source,
          message: option.replacement
            ? `next/link does not prefix hrefs with the app's mount point. Use '${option.replacement}'.`
            : "next/link does not prefix hrefs with the app's mount point. Use a Link built with createLink() from '@fairgarden/monolith/link'.",
        })
      }
    }

    return { ImportDeclaration: check, ImportExpression: check }
  },
}

export const rules = {
  'no-escaping-relative-imports': escapingImports,
  'no-next-link': nextLink,
}

/**
 * ESLint plugin keeping an app's routes mountable.
 *
 * ```js
 * // eslint.config.mjs
 * import monolith from '@fairgarden/monolith/eslint'
 *
 * export default [...monolith.configs.recommended]
 * ```
 */
const plugin = {
  meta: { name: '@fairgarden/monolith' },
  rules,
  configs: {} as Record<string, unknown[]>,
}

plugin.configs.recommended = [
  {
    name: '@fairgarden/monolith/recommended',
    plugins: { '@fairgarden/monolith': plugin },
    rules: {
      '@fairgarden/monolith/no-escaping-relative-imports': 'error',
      '@fairgarden/monolith/no-next-link': 'warn',
    },
  },
]

export default plugin
