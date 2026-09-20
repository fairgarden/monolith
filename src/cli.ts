#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { statSync } from 'node:fs'
import { linkApps } from './link.ts'
import { mergeAppDependencies, writePackageJson } from './package-json.ts'
import { getRegisteredApps } from './index.ts'
import type { LinkStrategy, ResolvedApp } from './types.ts'

// Piping into `head` closes stdout early; that is ordinary use, not a failure.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
}

const USAGE = `Usage: fg-monolith <command> [options]

Commands:
  link                 Mount every app's routes and assets into the monolith
  merge-package-json   Fold every app's dependencies into the monolith's package.json
  list                 Print the apps the monolith composes

Options:
  --cwd <dir>          Monolith directory (default: the working directory)
  --strategy <name>    source | mirror | hardlink | copy (default: source)
  --check              Report what would change without writing (merge-package-json)
  --all                Take every app dependency, not only what its pages need

Submodules, versions and scaffolding are handled by \`fg-dist\`, in
@fairgarden/distribution.
`

const CONFIG_FILES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
]

interface Args {
  command: string | undefined
  cwd: string
  strategy: LinkStrategy
  check: boolean
  all: boolean
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    command: undefined,
    cwd: process.cwd(),
    strategy: 'source',
    check: false,
    all: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cwd') {
      args.cwd = path.resolve(argv[++index] ?? '.')
    } else if (arg === '--strategy') {
      args.strategy = (argv[++index] ?? 'source') as LinkStrategy
    } else if (arg === '--check') {
      args.check = true
    } else if (arg === '--all') {
      args.all = true
    } else if (!arg.startsWith('-') && !args.command) {
      args.command = arg
    } else {
      throw new Error(`Unrecognized argument: ${arg}`)
    }
  }

  return args
}

/**
 * The monolith's own Next config is the single source of truth for which apps
 * it composes, so load it — with linking disabled — and read back what it
 * registered.
 */
const loadApps = async (cwd: string): Promise<ResolvedApp[]> => {
  const configPath = CONFIG_FILES.map((file) => path.join(cwd, file)).find((file) => {
    try {
      return statSync(file).isFile()
    } catch {
      return false
    }
  })

  if (!configPath) {
    throw new Error(`No Next config found in ${cwd}.`)
  }

  process.env.FG_MONOLITH_SKIP_LINK = '1'
  const loaded = (await import(pathToFileURL(configPath).href)).default
  if (typeof loaded === 'function') await loaded('phase-production-build')

  const apps = getRegisteredApps()
  if (apps.length === 0) {
    throw new Error(
      `${configPath} did not register any apps. Is it using withMonolith()?`
    )
  }
  return apps
}

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2))

  if (!args.command || args.command === 'help') {
    process.stdout.write(USAGE)
    return args.command ? 0 : 1
  }

  if (args.command === 'list') {
    for (const app of await loadApps(args.cwd)) {
      process.stdout.write(`${app.prefix}\t${app.source}\t${app.root}\n`)
    }
    return 0
  }

  if (args.command === 'link') {
    const apps = await loadApps(args.cwd)
    const mounted = await linkApps(args.cwd, apps, {
      strategy: args.strategy,
      sourceDir: path.resolve(args.cwd, 'src', 'app'),
      sourcePagesDir: path.resolve(args.cwd, 'src', 'pages'),
      watch: false,
    })
    for (const target of mounted) {
      process.stdout.write(`${path.relative(args.cwd, target)}\n`)
    }
    return 0
  }

  if (args.command === 'merge-package-json') {
    const apps = await loadApps(args.cwd)
    const file = path.join(args.cwd, 'package.json')
    const { packageJson, changed, taken } = await mergeAppDependencies(file, apps, {
      all: args.all,
    })

    if (!changed) {
      process.stdout.write('package.json is already up to date.\n')
      return 0
    }

    if (args.check) {
      process.stderr.write('package.json is out of date; run without --check.\n')
      return 1
    }

    await writePackageJson(file, packageJson)
    for (const [name, packages] of taken) {
      process.stdout.write(`${name}: ${packages.join(', ')}\n`)
    }
    process.stdout.write(`Updated ${path.relative(process.cwd(), file)}.\n`)
    return 0
  }

  process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`)
  return 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
)
