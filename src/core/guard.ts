// The guard of the folders in `guardedDirs`, at each nested call. It refuses a call when a string in its arguments
// names a guarded folder: as a path (also through `..`, another letter case, a symlink, a junction, an 8.3 name, a
// `file://` URL or a trailing dot or space on a name) or as text of any length that holds the name of the folder,
// such as `~/.toolscript-mcp/hints` in a shell command, also with a `%XX` in it. It is a net for a confused model and
// for the simple injected program, not containment: a shell command that no marker matches, a tool that writes from
// an id or a URL, a hard link and a change between the check and the write pass it.
// Pure code: the host passes `realpath`, so a test counts the file system calls with a fake.

import { foldCase, isUnder, isUnderAnyCase } from './hints.ts'
import { GUARD_MARKERS, guardedDirs, normalizePath } from './paths.ts'

/** The nesting of `args` that the walk reads: a string inside 16 objects or arrays is read, a deeper one is not. */
export const GUARD_DEPTH = 16
/** A path candidate has at most this many characters. A string of any length gets the text check. */
export const GUARD_STRING_CHARS = 4096
/** The real path walks of one call: a path with `..` or a doubled `/` takes 2. The later ones get the lexical check only. */
export const GUARD_REALPATHS = 16
/** The parent steps of one `realpath` for a path that does not exist yet. */
export const GUARD_PARENT_STEPS = 32

/** `fs.promises.realpath`: rejects when the path does not exist. */
export type Realpath = (path: string) => Promise<string>

/** One guarded folder: the name that a refusal gives, and its absolute path as written. */
export type GuardedDir = { readonly label: string; readonly dir: string }

/** A guarded folder with its real path, when that differs: both forms count. */
export type GuardForm = { readonly label: string; readonly dirs: readonly string[] }

/** The guarded folders under `home` and `project`, each with the name that a refusal gives. */
export const guardedList = (home: string, project: string): GuardedDir[] => {
  const homePath = normalizePath(home)
  const projectPath = normalizePath(project)
  return guardedDirs(home, project).map(dir => ({
    dir,
    label:
      home && isUnder(dir, homePath)
        ? `~${dir.slice(homePath.length)}`
        : dir.slice(projectPath.replace(/\/$/, '').length + 1),
  }))
}

// Each string of the arguments with its key path (`edits[0].new`), in order, to GUARD_DEPTH. Object keys are never read as
// text. A key shows only when it is a property name of the input schema at that place (the schema walks with the
// arguments: `properties`, then `items`). Any other key shows as `…`, so a key that holds data (a token) never reaches the
// refusal. A long path is cut.
const PLAIN_KEY = /^[A-Za-z0-9_$-]{1,40}$/
const KEY_PATH_CHARS = 100
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)
function* stringsOf(value: unknown, level: number, at = '', schema: unknown = undefined): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [at.length > KEY_PATH_CHARS ? `${at.slice(0, KEY_PATH_CHARS)}…` : at, value]
    return
  }
  if (level >= GUARD_DEPTH || typeof value !== 'object' || value === null) return
  if (Array.isArray(value)) {
    const items = isRec(schema) ? own(schema, 'items') : undefined
    for (const [i, item] of value.entries()) yield* stringsOf(item, level + 1, `${at}[${i}]`, items)
    return
  }
  const properties = isRec(schema) ? own(schema, 'properties') : undefined
  for (const [key, item] of Object.entries(value)) {
    const known = isRec(properties) && Object.hasOwn(properties, key) && PLAIN_KEY.test(key)
    const name = known ? key : '…'
    yield* stringsOf(item, level + 1, at === '' ? name : `${at}.${name}`, known ? properties[key] : undefined)
  }
}

const WORD = /^[\p{L}\p{N}_.-]$/u

/**
 * The marker that `text` holds at a name boundary, case-folded and with `\` as `/`, or undefined. The character before
 * must not be a letter, a digit, `_`, `-` or `.`. A run of `.` after the marker is part of its name, as Windows drops
 * it: the character after the run must not be a letter, a digit, `_` or `-`. So `.toolscript-mcp/hints-old`,
 * `.toolscript-mcp/hints.bak` and `my.toolscript-mcp/hints` pass. A trailing dot or space on the state folder does not
 * hide the marker. A string with `%` is read again with each `%XX` below `%80` decoded one time.
 */
export const markerIn = (text: string): string | undefined => markerOf(text) ?? decodedMarker(text)

// The marker that shows only after the `%XX` decode, or undefined. Decoding gives ASCII only, so a state name that
// decoding makes needs a decoded letter or `-`. A name that is in the text already is decoded for the boundary around
// it. Other text with `%` cannot gain a marker.
const decodedMarker = (text: string): string | undefined =>
  text.includes('%') && (foldCase(text).includes(STATE_NAME) || /%(?:[4-7][0-9a-f]|2d)/i.test(text))
    ? markerOf(decodeOnce(text))
    : undefined

/** The most lines that a refusal lists for one string: 10 and one more, to tell that there are more. */
export const GUARD_LINES = 11

/** A marker that a string holds, and the lines of the string where a marker of the list stands (see `markerHit`). */
export type MarkerHit = { readonly marker: string; readonly lines: readonly number[] }

/**
 * `markerIn` with the line numbers of the match, for the refusal. `lines` has at most GUARD_LINES numbers in rising
 * order, each a line (1 + the `\n` before it) that holds a marker of the list at a name boundary, not only the marker
 * that `marker` names. It is empty for a string with no `\n` and for a match that shows only after the `%XX` decode
 * (a decoded `%0A` adds a line). The folds of `markerOf` add and remove no `\n`, so the count on the folded text is the
 * count on the text as written.
 */
export const markerHit = (text: string): MarkerHit | undefined => {
  const found = scan(text)
  if (found !== undefined) {
    return { marker: found.marker, lines: text.includes('\n') ? linesOf(found.folded) : [] }
  }
  const marker = decodedMarker(text)
  return marker === undefined ? undefined : { marker, lines: [] }
}

const STATE = GUARD_MARKERS[0]!.slice(0, GUARD_MARKERS[0]!.indexOf('/'))
const STATE_NAME = STATE.slice(1)
const STATE_TAIL = new RegExp(`${STATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[. ]+(?=/)`, 'g')

// `%XX` below `%80`, in each letter case. A table lookup is 4 times faster than `parseInt` for a 1 MB string.
const ESCAPES: Record<string, string> = {}
for (let code = 0; code < 0x80; code++) {
  const hex = code.toString(16).padStart(2, '0')
  for (const spelling of [hex, hex.toUpperCase(), hex[0] + hex[1]!.toUpperCase(), hex[0]!.toUpperCase() + hex[1]])
    ESCAPES[`%${spelling}`] = String.fromCharCode(code)
}

// Each `%XX` below `%80` decoded one time. A bad sequence such as `%zz` or `%E0%` stays as written and throws nothing.
const decodeOnce = (text: string): string => text.replace(/%[0-7][0-9a-fA-F]/g, escape => ESCAPES[escape]!)

const markerOf = (text: string): string | undefined => scan(text)?.marker

// A marker at `at` in `folded` counts at a name boundary only (the rule of `markerIn`).
const atBoundary = (folded: string, marker: string, at: number): boolean => {
  let end = at + marker.length
  while (folded.charAt(end) === '.') end++
  return !WORD.test(at > 0 ? folded.charAt(at - 1) : '') && !WORD.test(folded.charAt(end))
}

// The first marker at a name boundary, with the folded text that the lines count on, or undefined.
const scan = (text: string): { marker: string; folded: string } | undefined => {
  // Every marker holds the name of the state folder, and the steps after the fold change no letter: a text without
  // the name has no marker, so the cheap fold runs first and the separator steps run only for a text that has it.
  const cased = foldCase(text)
  if (!cased.includes(STATE_NAME)) return undefined
  // A doubled separator or a `/./` does not change the path, so it must not hide the marker.
  const folded = cased
    .replaceAll('\\', '/')
    .replace(/\/(?:\.?\/)+/g, '/')
    .replace(STATE_TAIL, STATE)
  for (const marker of GUARD_MARKERS) {
    for (let at = folded.indexOf(marker); at >= 0; at = folded.indexOf(marker, at + 1)) {
      if (atBoundary(folded, marker, at)) return { marker, folded }
    }
  }
  return undefined
}

// The lines of the folded text that hold a marker at a name boundary, rising, at most GUARD_LINES. One pass for each
// marker: the `\n` are counted forward one time and the scan of a marker stops at GUARD_LINES lines, so the first
// GUARD_LINES of all markers are the first GUARD_LINES of the union.
const linesOf = (folded: string): number[] => {
  const found = new Set<number>()
  for (const marker of GUARD_MARKERS) {
    let line = 1
    let last = 0
    let kept = 0
    let nl = folded.indexOf('\n')
    for (let at = folded.indexOf(marker); at >= 0 && kept < GUARD_LINES; at = folded.indexOf(marker, at + 1)) {
      if (!atBoundary(folded, marker, at)) continue
      for (; nl >= 0 && nl < at; nl = folded.indexOf('\n', nl + 1)) line++
      if (line === last) continue
      found.add(line)
      last = line
      kept++
    }
  }
  return [...found].sort((a, b) => a - b).slice(0, GUARD_LINES)
}

// A scheme of 2 or more characters, then `//` or a word (`data:text/plain`): not a path. `C:a` and `C:\a` are drives.
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]+:(?:\/\/|[^\s/\\])/
// A `..` part: a string that has one stays a path candidate, as the file system may read `ab:x/..` as a relative path.
const DOT_DOT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/** True when `text` can be a path: no line break, NUL or URL, and it starts as a path or holds a separator. */
export const isPathLike = (text: string): boolean =>
  text.length > 0 &&
  text.length <= GUARD_STRING_CHARS &&
  !/[\n\r\0]/.test(text) &&
  !(SCHEME_URL.test(text) && !DOT_DOT.test(text)) &&
  /^(?:[/~\\.]|[A-Za-z]:[\\/])|[/\\]/.test(text)

/**
 * The path that a `file://` URL names, in any letter case, with its `%XX` decoded one time, or undefined. An empty host
 * and `localhost` are local, and `/C:/x` is `C:/x`. Another host gives `//host/path`. A `?` or `#` stays in the path.
 */
export const fileUrlPath = (text: string): string | undefined => {
  if (text.length > GUARD_STRING_CHARS) return undefined
  const match = /^file:\/\/([^/\\]*)(.*)$/is.exec(text)
  if (match === null) return undefined
  const [, host = '', rest = ''] = match
  const path = decodeOnce(rest)
  if (/[\n\r\0]/.test(path)) return undefined
  if (host !== '' && host.toLowerCase() !== 'localhost') return `//${host}${path}`
  return /^\/[A-Za-z]:(?:\/|$)/.test(path) ? path.slice(1) : path || '/'
}

/**
 * `text` as an absolute path with its `..` parts kept: `~` is `home`, a relative path is under `cwd`. `\` counts as
 * `/`. The real path needs the parts as written: a `..` after a symlink leaves the folder that the link points to.
 */
export const rawPath = (text: string, home: string, cwd: string): string => {
  const path = text.replaceAll('\\', '/')
  return path === '~' || path.startsWith('~/')
    ? home + path.slice(1)
    : path.startsWith('/') || /^[A-Za-z]:(?:\/|$)/.test(path)
      ? path
      : `${cwd}/${path}`
}

/**
 * True for a bare file name that can be a link in the folder of the server: no separator or space (so no URL), at
 * most 255 characters, and an extension. A word of prose has none, so it costs no file system call. A name with `@` or
 * an extension of digits only (`v2.0`, `10.0.0.1`, `user@example.com`) is a version or an address, not a link.
 */
export const isFileName = (text: string): boolean =>
  text.length <= 255 && /^[^\s/\\@]+\.(?!\d+$)[A-Za-z0-9]{1,10}$/.test(text)

/** `text` as an absolute, normalized path: the lexical form, with `..` resolved by name. */
export const absolutePath = (text: string, home: string, cwd: string): string => normalizePath(rawPath(text, home, cwd))

// The folder that holds `path`, as written, or undefined at the root.
const parentOf = (path: string): string | undefined => {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return undefined
  const head = path.slice(0, cut)
  const parent = head === '' ? '/' : /^[A-Za-z]:$/.test(head) ? `${head}/` : head
  return parent === path ? undefined : parent
}

// What realpath returns on Windows can start with the prefix of a long path.
const plain = (real: string): string =>
  real
    .replaceAll('\\', '/')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')

/**
 * The real path of `path`: the real path of its deepest part that exists, then the rest. A folder that does not exist
 * yet gets the real path of its parent. Undefined when no part within GUARD_PARENT_STEPS exists. Pass a path with its
 * `..` parts kept (`rawPath`): the file system resolves each link before the `..` that follows it. The parent steps cut
 * the text at the last `/`, so they never fold a `..` by name. A doubled `/` and a `/./` go first, as they change no
 * path, so they cannot spend the parent steps. A leading `//` stays: it starts a UNC path.
 */
export const realPathOf = async (path: string, realpath: Realpath): Promise<string | undefined> => {
  const rest: string[] = []
  let current = path.replace(/(?<=.)\/(?:\.?\/)+/g, '/')
  for (let step = 0; step <= GUARD_PARENT_STEPS; step++) {
    try {
      const real = plain(await realpath(current))
      return normalizePath(rest.length === 0 ? real : `${real}/${rest.join('/')}`)
    } catch {
      // not there yet: try its parent
    }
    const parent = parentOf(current)
    if (parent === undefined) return undefined
    rest.unshift(current.slice(current.lastIndexOf('/') + 1))
    current = parent
  }
  return undefined
}

/** The guarded folders with their real paths. The host calls it one time for each run. */
export const resolveGuarded = (list: readonly GuardedDir[], realpath: Realpath): Promise<GuardForm[]> =>
  Promise.all(
    list.map(async ({ label, dir }) => {
      const real = await realPathOf(dir, realpath)
      return { label, dirs: real === undefined || real === dir ? [dir] : [dir, real] }
    }),
  )

// Windows drops the dots and spaces at the end of a name, so `oauth.` is `oauth`. `.` and `..` keep their meaning.
// hitIn applies it to the path and to the guarded folder on every OS, so a home part that ends in a dot still matches.
const dropTrailing = (path: string): string =>
  normalizePath(
    path
      .split('/')
      .map(part => (part === '.' || part === '..' ? part : part.replace(/[. ]+$/, '')))
      .join('/'),
  )

const hitIn = (path: string, forms: readonly GuardForm[]): string | undefined => {
  const plainPath = dropTrailing(path)
  return forms.find(form => form.dirs.some(dir => isUnderAnyCase(plainPath, dropTrailing(dir))))?.label
}

export type GuardSetup = {
  readonly home: string
  /** The folder that a relative path counts from: the `cwd` of the server entry, else the one of the host. */
  readonly cwd: string
  readonly list: readonly GuardedDir[]
  /** The guarded folders with their real paths. Called only when a call has a path candidate. */
  readonly forms: () => Promise<readonly GuardForm[]>
  readonly realpath: Realpath
  /** The input schema of the tool, for the key path of a refusal: a key shows only when the schema names it. */
  readonly schema?: unknown
  /** True on Windows, where `//host/share` and `\\host\share` are UNC paths that a real path would connect to. */
  readonly windows: boolean
}

/**
 * The guarded folder that the arguments of a call name, as the refusal gives it, or undefined. A call with no path
 * candidate makes no file system call. The first GUARD_REALPATHS walks get a real path, the others the lexical
 * check. A bare file name with an extension, such as `notes.json`, can be a link in the folder of the server: the
 * first GUARD_REALPATHS of them get one `realpath` each, with no parent steps.
 */
export const guardHit = async (args: unknown, setup: GuardSetup): Promise<string | undefined> =>
  (await guardFind(args, setup))?.label

/** A guarded folder that a call names, and the key path of the argument that names it (`''` for the arguments as a whole). */
export type GuardFound = {
  readonly label: string
  readonly at: string
  /** The lines of a multi-line string that hold a guarded folder, rising, at most GUARD_LINES. Absent when none is known. */
  readonly lines?: readonly number[]
}

/** `guardHit` with the key path of the string that hit. */
export const guardFind = async (args: unknown, setup: GuardSetup): Promise<GuardFound | undefined> => {
  const lexical = setup.list.map(({ label, dir }) => ({ label, dirs: [dir] }))
  const paths: { abs: string; raw: string; remote: boolean; at: string }[] = []
  const names: { name: string; at: string }[] = []
  for (const [at, original] of stringsOf(args, 0, '', setup.schema)) {
    const found = markerHit(original)
    if (found !== undefined) {
      const label = `~/${found.marker}`
      return found.lines.length === 0 ? { label, at } : { label, at, lines: found.lines }
    }
    const url = fileUrlPath(original)
    if (url === undefined && !isPathLike(original)) {
      if (names.length < GUARD_REALPATHS && isFileName(original)) names.push({ name: `${setup.cwd}/${original}`, at })
      continue
    }
    // `\\?\C:\x` and `\\.\C:\x` are the local path `C:\x`: Node writes through them.
    const text = (url ?? original).replace(/^[\\/]{2}[?.][\\/](?=[A-Za-z]:)/, '')
    const abs = absolutePath(text, setup.home, setup.cwd)
    const hit = hitIn(abs, lexical)
    if (hit !== undefined) return { label: hit, at }
    // On Windows, a UNC path (`\\host\share`) gets the lexical check only: a real path would open a connection to that host.
    paths.push({
      abs,
      raw: rawPath(text, setup.home, setup.cwd),
      remote: setup.windows && /^[\\/]{2}/.test(text),
      at,
    })
  }
  if ((paths.length === 0 && names.length === 0) || setup.list.length === 0) return undefined
  const forms = await setup.forms()
  for (const { abs, at } of paths) {
    const hit = hitIn(abs, forms)
    if (hit !== undefined) return { label: hit, at }
  }
  // The form as written resolves a link before a `..` after it (POSIX). The form with `..` folded by name resolves a
  // link name after a `..`, as a server that calls `path.resolve` first writes it. Both count, to GUARD_REALPATHS.
  const walks = paths.flatMap(({ raw, abs, remote, at }) =>
    remote ? [] : (raw === abs ? [raw] : [raw, abs]).map(path => ({ path, at })),
  )
  for (const { path, at } of walks.slice(0, GUARD_REALPATHS)) {
    const real = await realPathOf(path, setup.realpath)
    const hit = real === undefined ? undefined : hitIn(real, forms)
    if (hit !== undefined) return { label: hit, at }
  }
  for (const { name, at } of names) {
    const real = await setup.realpath(name).then(plain, () => undefined)
    const hit = real === undefined ? undefined : hitIn(normalizePath(real), forms)
    if (hit !== undefined) return { label: hit, at }
  }
  return undefined
}
