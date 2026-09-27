import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

/**
 * Make an app's assets real files for as long as a build runs.
 *
 * `public/<name>` is a committed symlink to the app's own `public/`: GitHub
 * shows where the assets come from, and `next start` follows it. What deploys
 * a build does not. Vercel's adapter copies each entry of `public/` as it is,
 * so a relative link lands in `.next/output/static` pointing at nothing —
 * every asset under it would 404 — and Vercel's builder then fails on it
 * outright: "Cannot copy '../../id/public' to a subdirectory of itself".
 *
 * So while the build runs, each link is a directory of hard links to the same
 * files — nothing is copied unless the files are on another device — and when
 * the build process exits the committed link is put back, leaving the checkout
 * as it was — on Ctrl+C too, which Next turns into an exit, and when the
 * terminal closes. Only a build killed outright, or out of memory, leaves the
 * directory behind, and the next `dev`, `build` or `start` puts the link back
 * before anything else — only where the record below says it made one, and
 * only when that loses nothing: see `strangers`.
 */

/** The same file under another name, or a copy when it is on another device. */
const linkFile = (source: string, target: string): void => {
  try {
    linkSync(source, target)
  } catch {
    copyFileSync(source, target)
  }
}

/** `source`'s tree at `target`, following links inside it, as the build would. */
const linkTree = (source: string, target: string): void => {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source)) {
    const from = path.join(source, entry)
    const to = path.join(target, entry)
    if (statSync(from).isDirectory()) linkTree(from, to)
    else linkFile(from, to)
  }
}

/**
 * What this has materialised and not yet put back, kept on disk so a later
 * process knows it. A real directory where a link belongs is only ever taken
 * for a build's leftover when it is recorded here: the monolith's own files
 * can be byte for byte an app's — a boilerplate \`page.tsx\`, a favicon — and
 * guessing from what is inside would replace them. Beside the installed
 * packages, where git does not look and a clean install clears it.
 */
const recordFile = (monolithRoot: string): string =>
  path.join(monolithRoot, 'node_modules', '.cache', '@fairgarden', 'monolith', 'materialised.json')

/** Where each materialised path is, relative to the monolith, and what its link said. */
type Record_ = Record<string, string>

const readRecord = (monolithRoot: string): Record_ => {
  try {
    return JSON.parse(readFileSync(recordFile(monolithRoot), 'utf8')) as Record_
  } catch {
    return {}
  }
}

const writeRecord = (monolithRoot: string, record: Record_): void => {
  const file = recordFile(monolithRoot)
  if (Object.keys(record).length === 0) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

const keyOf = (monolithRoot: string, at: string): string => path.relative(monolithRoot, at)

/**
 * Whether what is at `target` is a build's leftover: recorded as materialised,
 * and still real files rather than the link.
 */
export const isLeftover = (monolithRoot: string, target: string): boolean => {
  if (!(keyOf(monolithRoot, target) in readRecord(monolithRoot))) return false
  const stats = lstatSync(target, { throwIfNoEntry: false })
  return stats !== undefined && !stats.isSymbolicLink()
}

/** The link is back, so the record of it can go. */
export const forgetLeftover = (monolithRoot: string, target: string): void => {
  const record = readRecord(monolithRoot)
  const key = keyOf(monolithRoot, target)
  if (!(key in record)) return
  delete record[key]
  writeRecord(monolithRoot, record)
}

interface Materialised {
  monolithRoot: string
  link: string
  /** What the link said, exactly, so it is put back as it was committed. */
  target: string
  directory: boolean
}

const pending: Materialised[] = []

const restore = (): void => {
  for (const { monolithRoot, link, target, directory } of pending.splice(0)) {
    try {
      // Saved into while the build ran: kept, and the record with it, so the
      // next dev, build or start says what is in the way.
      const foreign = strangers(link, path.resolve(path.dirname(link), target))
      if (foreign.length > 0) {
        process.stderr.write(
          `${keyOf(monolithRoot, link)} was left as a directory, not put back as the link to ` +
            `${target}: it has files the app does not.\n`
        )
        continue
      }
      rmSync(link, { recursive: true, force: true })
      symlinkSync(target, link, directory ? 'dir' : 'file')
      forgetLeftover(monolithRoot, link)
    } catch {
      // Exiting: nowhere to report it. The record says what is left, and the
      // next dev, build or start links it again.
    }
  }
}

/**
 * Next's build turns Ctrl+C and SIGTERM into an exit, which \`restore\` is
 * already waiting for; a closed terminal it leaves to kill the process. Once
 * the links are back, whoever else listens decides what the signal means — and
 * with nobody, it means what it would have without this.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

const onSignal = (signal: NodeJS.Signals): void => {
  restore()
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}

const listen = (): void => {
  process.once('exit', restore)
  for (const signal of SIGNALS) process.once(signal, onSignal)
}

/**
 * Whether \`copy\` is the app's \`file\`: the same file, or — where hard links
 * could not be made — the same bytes. Only asked of a recorded leftover, which
 * this made from the app's files.
 */
const isCopyOf = (copy: string, file: string): boolean => {
  const original = statSync(file, { throwIfNoEntry: false })
  if (!original?.isFile()) return false
  const ours = statSync(copy)
  if (ours.ino === original.ino && ours.dev === original.dev) return true
  return ours.size === original.size && readFileSync(copy).equals(readFileSync(file))
}

/**
 * What is in a build's leftover at \`target\` that is not the app's at \`source\`.
 *
 * The app's own files can go: it has every one. Anything else was put there
 * by someone after the build stopped — saved into what looked like the app's
 * assets — and deleting it to make way for the link would lose it, so it is
 * listed instead.
 */
export const strangers = (target: string, source: string): string[] => {
  const stats = lstatSync(target, { throwIfNoEntry: false })
  if (!stats || stats.isSymbolicLink()) return []
  if (!stats.isDirectory()) return isCopyOf(target, source) ? [] : [target]

  const found: string[] = []
  for (const entry of readdirSync(target)) {
    const here = path.join(target, entry)
    const there = path.join(source, entry)
    const kind = lstatSync(here)
    if (kind.isDirectory()) {
      if (statSync(there, { throwIfNoEntry: false })?.isDirectory()) found.push(...strangers(here, there))
      else found.push(here)
    } else if (!kind.isFile() || !isCopyOf(here, there)) {
      // Materialising follows links, so one here was not made by it.
      found.push(here)
    }
  }
  return found
}

/**
 * Replace each symlink among \`paths\` inside \`public/\` with real files, until
 * the process exits.
 *
 * Only the links the monolith made: anything else in \`public/\` is the
 * monolith's own, and left as it is.
 */
export const materialisePublic = (monolithRoot: string, paths: string[]): string[] => {
  const publicDir = path.join(monolithRoot, 'public')
  const done: string[] = []

  for (const link of paths) {
    if (path.dirname(link) !== publicDir) continue
    const stats = lstatSync(link, { throwIfNoEntry: false })
    if (!stats?.isSymbolicLink()) continue

    const target = readlinkSync(link)
    const resolved = path.resolve(path.dirname(link), target)
    const pointed = statSync(resolved, { throwIfNoEntry: false })
    if (!pointed) continue

    // Recorded before anything is touched, so a process killed at any point
    // after leaves something the next one recognises.
    writeRecord(monolithRoot, { ...readRecord(monolithRoot), [keyOf(monolithRoot, link)]: target })
    rmSync(link)
    if (pending.length === 0) listen()
    pending.push({ monolithRoot, link, target, directory: pointed.isDirectory() })
    if (pointed.isDirectory()) linkTree(resolved, link)
    else linkFile(resolved, link)
    done.push(link)
  }

  return done
}

/** Put every link back now, rather than at exit. For tests. */
export const restorePublic = restore
