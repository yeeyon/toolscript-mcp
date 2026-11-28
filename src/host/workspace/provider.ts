// The in-process MCP server of the Workspace (issue #144). `connectAll` links to it with an SDK InMemoryTransport, so
// `search_tools`, the policy, cancellation, the call time limit and the run log treat it as any server. Each tool is
// one entry of WORKSPACE_TOOLS (src/core/workspace.ts) and one handler here. Every file and name that a tool shows
// comes through the confined file system (confined.ts), and no path in the arguments is trusted before it passed
// `pathParts` and the exclusions.

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createHash } from 'node:crypto'
import os from 'node:os'
import {
  LIMITS,
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_VERSION,
  WorkspaceError,
  applyRanges,
  fold,
  includeReach,
  includeTest,
  lineEndWarnings,
  parseDiffInput,
  parseEditInput,
  parseListInput,
  parsePathInput,
  lowered,
  parseSearchInput,
  parseTaskInput,
  parseWriteInput,
  folderParts,
  pathParts,
  planEdits,
  showPath,
  unifiedDiff,
  walkSlotsFor,
  type Change,
  type DiffInput,
  type EditInput,
  type Excluder,
  type ListInput,
  type PathInput,
  type Range,
  type SearchInput,
  type WorkspaceToolName,
  type WriteInput,
} from '../../core/workspace.ts'
import { ignored, parseIgnore, startsClear } from '../../core/ignore.ts'
import { readCapped, type Confined, type Dir, type Kind } from './confined.ts'
import type { TaskRunner } from './task.ts'
import { createLocker, lockKey, type Hold, type LockerOptions } from './write.ts'

export type ProviderOptions = {
  readonly confined: Confined
  /** The tasks of the root entry of the session. `run_task` is listed only when one of them is valid. */
  readonly tasks?: TaskRunner
  /** The real path of the session root: the name of the lock of a file is the hash of its real path. */
  readonly root: string
  /** HOME: the lock files of the changes are under it. */
  readonly home: string
  /** The `write` grant of the root entry. Without it `edit` and `write` are not listed and their handlers refuse. */
  readonly write: boolean
  readonly excluded: Excluder
  /** The folder names that `list` and `search` do not enter. */
  readonly skip: readonly string[]
  /** `false`: `list` and `search` never read the `.gitignore` of the root. Absent: they do. */
  readonly gitignore?: boolean
  /** Tests only: `false` opens each folder, as the walk did before the prune. */
  readonly prune?: boolean
  readonly windows: boolean
  /** The stderr log. Never holds a path, a name or file content. */
  readonly log: (line: string) => void
  /** Tests only: smaller limits, so a test needs fewer files. */
  readonly limits?: {
    readonly searchFiles?: number
    readonly listEntries?: number
    readonly searchMs?: number
    readonly walkSlots?: number
    /** The CPU count that the default of `walkSlots` follows, in place of `os.availableParallelism()`. */
    readonly parallelism?: number
  }
  /** Tests only: shorter lock times. */
  readonly locks?: LockerOptions
}

export type Provider = {
  /** A new in-memory link: the client side of a new server over the shared confined file system. */
  readonly serve: () => Promise<Transport>
  /** The calls that run now. A test waits for 0 after a cancel. */
  readonly inFlight: () => number
  /** Ends the task that runs, with its tree, and refuses each later task. The shutdown of the host calls it first. */
  readonly stopTasks: () => Promise<void>
  readonly close: () => Promise<void>
}

type Entry = { readonly parts: readonly string[]; readonly kind: Kind; readonly size: number }

/** True for a path that the `.gitignore` of the root hides from the walk. */
type Hides = (parts: readonly string[], isFolder: boolean) => boolean

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const cancelled = (signal: AbortSignal): void => {
  if (signal.aborted) throw new WorkspaceError('cancelled', 'the call was cancelled')
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const sha = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const excludedError = (): WorkspaceError => new WorkspaceError('excluded', 'the path is excluded from Workspace')

/** A file whose bytes were read: the bytes, their text without the byte order mark, and the hash of the bytes. */
type Loaded = { readonly bytes: Buffer; readonly text: string; readonly bom: boolean; readonly hash: string }

/** The text of a file, or why it is no text. A byte order mark is dropped from the text. */
const decoded = (bytes: Uint8Array): { text: string; bom: boolean } | 'binary' | 'encoding' => {
  if (bytes.includes(0)) return 'binary'
  try {
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bom }
  } catch {
    return 'encoding'
  }
}

export const createProvider = (options: ProviderOptions): Provider => {
  const { excluded, windows, log } = options
  /**
   * A refusal of the kind of an entry (`not-file`, `not-folder`, `hard-link`) that names an excluded entry through an alias
   * answers `excluded`, as the plain spelling does: no code of the kind tells that the entry is there.
   */
  const unalias = <T>(opened: Promise<T>): Promise<T> =>
    opened.catch((err: unknown) => {
      if (err instanceof WorkspaceError && err.spelled?.some(p => excluded(p)) === true) throw excludedError()
      throw err
    })
  const confined: Confined = {
    ...options.confined,
    dir: parts => unalias(options.confined.dir(parts)),
    file: parts => unalias(options.confined.file(parts)),
    update: parts => unalias(options.confined.update(parts)),
    create: (parts, bytes, guard) => unalias(options.confined.create(parts, bytes, guard)),
  }
  const { parallelism = os.availableParallelism(), ...given } = options.limits ?? {}
  const limits = {
    searchFiles: LIMITS.searchFiles,
    listEntries: LIMITS.listEntries,
    searchMs: LIMITS.searchMs,
    // One slot on a machine with one CPU, else LIMITS.walkSlots. Not a count from the cores (issue #180).
    walkSlots: walkSlotsFor(LIMITS.walkSlots, parallelism),
    ...given,
  }
  const skip = new Set(options.skip.map(fold))
  const servers = new Set<Server>()
  let running = 0

  /** The parts of a path text, after the checks that need no file system call. */
  const target = (text: string, folderPath = false): string[] => {
    const parts = (folderPath ? folderParts : pathParts)(text, windows)
    if (excluded(parts)) throw new WorkspaceError('excluded', 'the path is excluded from Workspace')
    return parts
  }

  /** The proven folder at `parts`. Its real spelling can name an excluded folder that the text did not, as a short name does. */
  const folder = async (parts: readonly string[]): Promise<Dir> => {
    const dir = await confined.dir(parts)
    if (excluded(dir.parts)) {
      await dir.close()
      throw new WorkspaceError('excluded', 'the path is excluded from Workspace')
    }
    return dir
  }

  /**
   * At most `limits.walkSlots` walks of `list` and `search` run at one time (`LIMITS.walkSlots`, 1 on one CPU). Parallel walks share the file threads and
   * the CPU, and each would run to `searchMs` (issue #160). The others wait in order, and the budget of a walk starts
   * when it runs. A call that is cancelled while it waits fails at once and takes no slot. A slot passes on when a walk
   * ends for any reason.
   */
  const turns: (() => void)[] = []
  let walking = 0
  const slotted = async <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> => {
    cancelled(signal)
    if (walking < limits.walkSlots) walking++
    else
      await new Promise<void>((go, stop) => {
        const turn = () => (signal.removeEventListener('abort', quit), go())
        const quit = () => {
          turns.splice(turns.indexOf(turn), 1)
          stop(new WorkspaceError('cancelled', 'the call was cancelled'))
        }
        turns.push(turn)
        signal.addEventListener('abort', quit, { once: true })
      })
    try {
      return await task()
    } finally {
      const next = turns.shift()
      if (next === undefined) walking--
      else next()
    }
  }

  /**
   * The bound of one walk: `left` names (`searchFiles`, less each name read so far) and `searchMs`. A name counts when
   * it is read, whatever it is (a file, a folder, a link, a name that `include` drops), except an excluded name, which
   * only the time bounds. So a tree with no match for the `include`, or one of folders only, ends too.
   */
  const budget = () => {
    const began = performance.now()
    return { left: limits.searchFiles, cut: false, timely: () => performance.now() - began <= limits.searchMs }
  }

  /**
   * Visits each entry below `dir` in sorted order, down to `levels` levels. The names of a folder are read to its end
   * or to the budget before any folder below it is entered. A name from the listing is a candidate: `lstat` and each
   * open prove it. An excluded name is never read into the walk, a link is visited and never entered, and a folder
   * that vanished or became a link while the walk ran is left out. Returns false when a visit or the time stopped the
   * walk. A read that the budget or the time cut sets `within.cut`, and the walk goes on with the names it holds.
   */
  const walk = async (
    dir: Dir,
    levels: number,
    visit: (entry: Entry, dir: Dir, name: string) => Promise<boolean>,
    signal: AbortSignal,
    within: ReturnType<typeof budget>,
    hides?: Hides,
    reach?: (folder: readonly string[]) => boolean,
  ): Promise<boolean> => {
    const read = await dir.names({
      keep: name => !excluded([...dir.parts, name]),
      room: within.left,
      alive: () => (cancelled(signal), within.timely()),
    })
    within.left -= read.names.length
    if (read.more) within.cut = true
    const names = read.names.sort(byText)
    for (const name of names) {
      cancelled(signal)
      if (!within.timely()) return false
      const parts = [...dir.parts, name]
      const entry = await dir.lstat(name)
      if (entry === undefined) continue
      // An ignored name still counted as a visited one above. An ignored folder is never entered.
      if (hides?.(parts, entry.kind === 'folder') === true) continue
      if (!(await visit({ parts, kind: entry.kind, size: entry.size }, dir, name))) return false
      if (entry.kind !== 'folder' || levels <= 1 || read.more || skip.has(fold(name))) continue
      // No glob of `include` reaches below this folder: its entry was visited, its names are not read.
      if (reach?.(parts) === false) continue
      const child = await dir.openDir(name).catch((err: unknown) => {
        if (
          err instanceof WorkspaceError &&
          (err.code === 'link' || err.code === 'not-found' || err.code === 'not-folder')
        )
          return undefined
        throw err
      })
      if (child === undefined) continue
      try {
        if (!(await walk(child, levels - 1, visit, signal, within, hides, reach))) return false
      } finally {
        await child.close()
      }
    }
    return true
  }

  // Names compare with no regard to case on Windows and macOS, as the exclusions do.
  const folds = windows || confined.method === 'nofollow-any'

  /** The rules of the `.gitignore` of the root, read again at each call. A file that cannot be used gives no rules. */
  const ignoreRules = async () => {
    if (options.gitignore === false || excluded(['.gitignore'])) return []
    const opened = await confined.file(['.gitignore']).catch((err: unknown) => {
      if (err instanceof WorkspaceError && err.code !== 'cancelled' && err.code !== 'root-changed') return undefined
      throw err
    })
    if (opened === undefined) return []
    try {
      if (excluded(opened.parts) || opened.size > LIMITS.ignoreBytes) return []
      const bytes = await readCapped(opened.handle, LIMITS.ignoreBytes)
      const text = bytes === undefined ? 'binary' : decoded(bytes)
      return typeof text === 'string' ? [] : parseIgnore(text.text, folds)
    } finally {
      await opened.handle.close().catch(() => {})
    }
  }

  /**
   * What the `.gitignore` hides from one `list` or `search` that starts at `start`: discovery only. A start that is
   * ignored, or inside an ignored folder, hides nothing, as `path` can name a folder of `skip`.
   */
  const hidesFor = async (start: readonly string[]): Promise<Hides | undefined> => {
    const rules = await ignoreRules()
    if (rules.length === 0 || !startsClear(rules, start, folds)) return undefined
    return (parts, isFolder) => ignored(rules, parts, isFolder, folds)
  }

  const reachOf = (globs: readonly string[]) => (options.prune === false ? undefined : includeReach(globs))

  const list = async (input: ListInput, signal: AbortSignal) => {
    const start = target(input.path, true)
    const inList = includeTest(input.include)
    const entries: { path: string; type: Kind; size?: number }[] = []
    const within = budget()
    let truncated = false
    const dir = await folder(start)
    try {
      const hides = await hidesFor(dir.parts)
      const complete = await walk(
        dir,
        input.depth,
        async ({ parts, kind, size }) => {
          if (!inList(parts)) return true
          if (entries.length >= limits.listEntries) {
            truncated = true
            return false
          }
          entries.push({ path: showPath(parts), type: kind, ...(kind === 'file' && { size }) })
          return true
        },
        signal,
        within,
        hides,
        reachOf(input.include),
      )
      if (!complete || within.cut) truncated = true
    } finally {
      await dir.close()
    }
    return { entries: entries.sort((a, b) => byText(a.path, b.path)), truncated }
  }

  const search = async (input: SearchInput, signal: AbortSignal) => {
    const start = target(input.path, true)
    const inList = includeTest(input.include)
    const written = typeof input.query === 'string' ? [input.query] : input.query
    const needles = written.map(q => (input.ignoreCase ? lowered(q) : q))
    // Per term: the matches taken, and whether a match past `maxMatches` was seen. The walk ends when every term has.
    const taken = needles.map(() => 0)
    const over = needles.map(() => false)
    const matches: { path: string; line: number; column: number; text: string; query?: string; term: number }[] = []
    const within = budget()
    let truncated = false
    let scanned = 0
    let skipped = 0
    const dir = await folder(start)
    try {
      const hides = await hidesFor(dir.parts)
      const complete = await walk(
        dir,
        Infinity,
        async ({ parts, kind }, parent, name) => {
          if (kind !== 'file' || !inList(parts)) return true
          const opened = await parent.openFile(name).catch((err: unknown) => {
            if (err instanceof WorkspaceError && err.code !== 'cancelled' && err.code !== 'root-changed')
              return undefined
            throw err
          })
          if (opened === undefined) {
            skipped++
            return true
          }
          try {
            if (excluded(opened.parts)) return true
            const bytes =
              opened.size > LIMITS.searchFileBytes ? undefined : await readCapped(opened.handle, LIMITS.searchFileBytes)
            const text = bytes === undefined ? 'binary' : decoded(bytes)
            if (typeof text === 'string') {
              skipped++
              return true
            }
            scanned++
            const path = showPath(opened.parts)
            const lines = text.text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              const raw = lines[i]!.endsWith('\r') ? lines[i]!.slice(0, -1) : lines[i]!
              const line = input.ignoreCase ? lowered(raw) : raw
              for (let t = 0; t < needles.length; t++) {
                const needle = needles[t]!
                if (over[t]) continue
                for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + needle.length)) {
                  if (taken[t]! >= input.maxMatches) {
                    over[t] = true
                    truncated = true
                    break
                  }
                  taken[t]!++
                  const shown = raw.slice(0, LIMITS.lineChars)
                  matches.push(
                    typeof input.query === 'string'
                      ? { path, line: i + 1, column: at + 1, text: shown, term: t }
                      : { path, line: i + 1, column: at + 1, text: shown, query: written[t]!, term: t },
                  )
                }
              }
              if (over.every(Boolean)) return false
            }
            return true
          } finally {
            await opened.handle.close().catch(() => {})
          }
        },
        signal,
        within,
        hides,
        reachOf(input.include),
      )
      if (!complete || within.cut) truncated = true
    } finally {
      await dir.close()
    }
    matches.sort((a, b) => byText(a.path, b.path) || a.line - b.line || a.column - b.column || a.term - b.term)
    return { matches: matches.map(({ term: _, ...match }) => match), truncated, filesScanned: scanned, skipped }
  }

  /**
   * The bytes of a file through `read`, as text: the limits and the refusals of `read`. The size can be old, so `read`
   * returns at most `max + 1` bytes of the file, or undefined when the file holds more than `max`.
   */
  const loadText = async (size: number, read: (max: number) => Promise<Buffer | undefined>): Promise<Loaded> => {
    const tooLarge = () => new WorkspaceError('too-large', `the file is larger than ${LIMITS.readBytes} bytes`)
    if (size > LIMITS.readBytes) throw tooLarge()
    const bytes = await read(LIMITS.readBytes)
    if (bytes === undefined) throw tooLarge()
    const text = decoded(bytes)
    if (text === 'binary') throw new WorkspaceError('binary', 'the file has a NUL byte, so it is not text')
    if (text === 'encoding') throw new WorkspaceError('encoding', 'the file is not valid UTF-8')
    return { bytes, text: text.text, bom: text.bom, hash: sha(bytes) }
  }

  const read = async (input: PathInput) => {
    const parts = target(input.path)
    if (parts.length === 0) throw new WorkspaceError('not-file', 'the path is the root, which is a folder')
    const opened = await confined.file(parts)
    try {
      if (excluded(opened.parts)) throw excludedError()
      const loaded = await loadText(opened.size, max => readCapped(opened.handle, max))
      return {
        path: showPath(opened.parts),
        content: loaded.text,
        hash: loaded.hash,
        encoding: loaded.bom ? ('utf-8-bom' as const) : ('utf-8' as const),
        size: loaded.bytes.length,
      }
    } finally {
      await opened.handle.close().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Pull request B: diff, edit and write

  const locker = createLocker(options.home, options.locks)
  /** The name of the lock of a file: the path is folded on every system, so two spellings share a lock. */
  const keyOf = (parts: readonly string[]): string => lockKey(options.root, parts)

  const stale = (): WorkspaceError =>
    new WorkspaceError('stale', 'the file has changed since expectedHash. Read it again, then redo the change')

  /** The path of a file: the root is a folder. */
  const fileTarget = (text: string): string[] => {
    const parts = target(text)
    if (parts.length === 0) throw new WorkspaceError('not-file', 'the path is the root, which is a folder')
    return parts
  }

  const writable = (): void => {
    if (!options.write)
      throw new WorkspaceError(
        'read-only',
        'the root of this session has no "write": true, so Workspace changes nothing',
      )
  }

  /**
   * The change of `ranges` in `old` (undefined for a new file): the new bytes, the diff and the hashes. It keeps the
   * byte order mark of the old file and changes no byte outside the ranges. `applied` is the caller's word.
   */
  const changeOf = (
    parts: readonly string[],
    old: Loaded | undefined,
    ranges: readonly Range[],
    applied: boolean,
  ): { change: Change; bytes: Buffer } => {
    const next = applyRanges(old?.text ?? '', ranges)
    const bytes = Buffer.concat([old?.bom === true ? BOM : Buffer.alloc(0), Buffer.from(next, 'utf8')])
    if (bytes.length > LIMITS.readBytes)
      throw new WorkspaceError('too-large', `the new file would be larger than ${LIMITS.readBytes} bytes`)
    const { diff, diffTruncated, added, removed } = unifiedDiff(showPath(parts), old?.text, ranges)
    return {
      bytes,
      change: {
        path: showPath(parts),
        applied,
        created: old === undefined,
        changed: old === undefined || !bytes.equals(old.bytes),
        oldHash: old?.hash ?? null,
        newHash: sha(bytes),
        diff,
        diffTruncated,
        added,
        removed,
        warnings: old === undefined ? [] : lineEndWarnings(old.text, next),
      },
    }
  }

  const whole = (text: string, content: string): Range[] => [{ start: 0, end: text.length, text: content, edit: 0 }]

  /**
   * Runs `fn` with the lock of the file. The lock is taken before the file is opened, under the spelling of the text
   * of the path. `fn` takes the lock of the real spelling too, when the proof found another one. The lock goes after
   * a failed or cancelled call as after a good one.
   */
  const locked = async <T>(
    parts: readonly string[],
    signal: AbortSignal,
    fn: (hold: Hold) => Promise<T>,
  ): Promise<T> => {
    const hold = await locker.hold(keyOf(parts), signal)
    try {
      cancelled(signal)
      return await fn(hold)
    } finally {
      await hold.release()
    }
  }

  /** A change to a file that exists: lock, open and prove, hash check, write. Stops at the first step that fails. */
  const replace = (
    parts: readonly string[],
    expectedHash: string,
    signal: AbortSignal,
    plan: (text: string) => Range[],
  ): Promise<Change> =>
    locked(parts, signal, async hold => {
      const file = await confined.update(parts)
      try {
        if (excluded(file.parts)) throw excludedError()
        await hold.also(keyOf(file.parts))
        const old = await loadText(file.size, max => file.read(max))
        if (old.hash !== expectedHash) throw stale()
        const { change, bytes } = changeOf(file.parts, old, plan(old.text), true)
        if (!change.changed) return { ...change, applied: false }
        // The last point where a cancel changes nothing: after it the write starts.
        cancelled(signal)
        await file.replace(bytes)
        return change
      } finally {
        await file.close()
      }
    })

  const edit = (input: EditInput, signal: AbortSignal): Promise<Change> => {
    writable()
    return replace(fileTarget(input.path), input.expectedHash, signal, text => planEdits(text, input.edits))
  }

  const write = async (input: WriteInput, signal: AbortSignal): Promise<Change> => {
    writable()
    const parts = fileTarget(input.path)
    if (input.expectedHash !== undefined)
      return replace(parts, input.expectedHash, signal, text => whole(text, input.content))
    return locked(parts, signal, async () => {
      const { change, bytes } = changeOf(parts, undefined, whole('', input.content), true)
      cancelled(signal)
      const made = await confined
        .create(parts, bytes, real => {
          if (excluded(real)) throw excludedError()
        })
        .catch(async (err: unknown) => {
          // A file is there: when its real spelling (a short name) is excluded, that is the answer, as in `vacant`.
          if (err instanceof WorkspaceError && err.code === 'exists') {
            const there = await confined.file(parts).catch((e: unknown) => {
              if (e instanceof WorkspaceError && e.code === 'excluded') throw e
              return undefined
            })
            if (there !== undefined) {
              await there.handle.close().catch(() => {})
              if (excluded(there.parts)) throw excludedError()
            }
          }
          throw err
        })
      return { ...change, path: showPath(made) }
    })
  }

  /** Nothing is at `parts`, and no folder on the way is a link: a new file can go there. Changes nothing. */
  const vacant = async (parts: readonly string[]): Promise<void> => {
    for (let k = 0; k < parts.length; k++) {
      const dir = await folder(parts.slice(0, k)).catch((err: unknown) => {
        if (err instanceof WorkspaceError && err.code === 'not-found') return undefined
        throw err
      })
      // A folder is missing, so the file is.
      if (dir === undefined) return
      await dir.close()
    }
    const present = await confined.file(parts).then(
      async opened => {
        await opened.handle.close().catch(() => {})
        // The real spelling can name an excluded file that the text did not, as a short name does.
        if (excluded(opened.parts)) throw excludedError()
        return true
      },
      (err: unknown) => {
        if (!(err instanceof WorkspaceError)) throw err
        if (err.code === 'not-found') return false
        // A link, a folder or a file with other names is something: a new file cannot take its place.
        if (err.code === 'link' || err.code === 'not-file' || err.code === 'hard-link') return true
        throw err
      },
    )
    if (present)
      throw new WorkspaceError(
        'exists',
        'something is already at this path. To replace a file, read it and pass its hash as expectedHash',
      )
  }

  const diff = async (input: DiffInput): Promise<Change> => {
    const parts = fileTarget(input.path)
    if (input.edits === undefined && input.expectedHash === undefined) {
      await vacant(parts)
      return changeOf(parts, undefined, whole('', input.content ?? ''), false).change
    }
    const opened = await confined.file(parts)
    try {
      if (excluded(opened.parts)) throw excludedError()
      const old = await loadText(opened.size, max => readCapped(opened.handle, max))
      if (input.expectedHash !== undefined && input.expectedHash !== old.hash) throw stale()
      const ranges = input.edits !== undefined ? planEdits(old.text, input.edits) : whole(old.text, input.content ?? '')
      return changeOf(opened.parts, old, ranges, false).change
    } finally {
      await opened.handle.close().catch(() => {})
    }
  }

  const stat = async (input: PathInput) => {
    const parts = target(input.path)
    const last = parts.at(-1)
    if (last === undefined) return { path: '.', type: 'folder' as const }
    const missing = { path: showPath(parts), type: 'missing' as const }
    // A path below a file has nothing at it, as a path below a folder that is not there.
    const parent = await folder(parts.slice(0, -1)).catch((err: unknown) => {
      if (err instanceof WorkspaceError && (err.code === 'not-found' || err.code === 'not-folder')) return undefined
      throw err
    })
    if (parent === undefined) return missing
    try {
      // Where the volume can spell a name in another case or by a short name, ask for the real spelling, so an alias cannot pass.
      const entry = await parent.lstat(last, true)
      if (entry === undefined) return missing
      const real = [...parent.parts, entry.real]
      // A file with a second name in the folder: the alias is excluded when any of its names is.
      if (excluded(real) || (entry.alike ?? []).some(n => excluded([...parent.parts, n])))
        throw new WorkspaceError('excluded', 'the path is excluded from Workspace')
      if (entry.kind === 'link')
        throw new WorkspaceError('link', 'the path is a link: Workspace never follows a symlink or a junction')
      return { path: showPath(real), type: entry.kind, ...(entry.kind === 'file' && { size: entry.size }) }
    } finally {
      await parent.close()
    }
  }

  const runner = options.tasks !== undefined && options.tasks.names.length > 0 ? options.tasks : undefined

  const run: Partial<Record<WorkspaceToolName, (args: unknown, signal: AbortSignal) => Promise<unknown>>> = {
    // Bad input and a bad path answer at once and take no slot.
    list: async (args, signal) => {
      const input = parseListInput(args)
      target(input.path, true)
      return slotted(signal, () => list(input, signal))
    },
    search: async (args, signal) => {
      const input = parseSearchInput(args)
      target(input.path, true)
      return slotted(signal, () => search(input, signal))
    },
    read: args => read(parsePathInput(args)),
    stat: args => stat(parsePathInput(args)),
    diff: args => diff(parseDiffInput(args)),
    edit: (args, signal) => edit(parseEditInput(args), signal),
    write: (args, signal) => write(parseWriteInput(args), signal),
    // Only a root entry with a valid task has the tool: a session whose entry has none runs no task.
    ...(runner !== undefined && { run_task: (args, signal) => runner.run(parseTaskInput(args).task, signal) }),
  }

  /** The tool as `tools/list` shows it. `run_task` names the tasks, and says what a task is. */
  const described = (name: WorkspaceToolName) => {
    const { description, inputSchema, outputSchema, class: toolClass } = WORKSPACE_TOOLS[name]
    if (toolClass === 'exec')
      return {
        name,
        description: `${description} Tasks: ${runner?.names.join(', ') ?? ''}.`,
        inputSchema: {
          ...inputSchema,
          properties: { task: { type: 'string', enum: runner?.names ?? [], description: 'The name of the task.' } },
        },
        outputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      }
    return {
      name,
      description,
      inputSchema,
      outputSchema,
      annotations:
        toolClass === 'read'
          ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
          : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }
  }

  const makeServer = (): Server => {
    const server = new Server(
      { name: 'toolscript-workspace', version: WORKSPACE_VERSION },
      { capabilities: { tools: {} } },
    )
    // The tool list is the capability list: a change tool is listed only with the `write` grant.
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: WORKSPACE_TOOL_NAMES.filter(
        name => run[name] !== undefined && (options.write || WORKSPACE_TOOLS[name].class !== 'write'),
      ).map(described) as never,
    }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
      const handler = Object.hasOwn(run, params.name) ? run[params.name as WorkspaceToolName] : undefined
      if (handler === undefined) return fail('bad-input: unknown tool')
      running++
      try {
        const result = await handler(params.arguments ?? {}, extra.signal)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        }
      } catch (err) {
        if (err instanceof WorkspaceError) return fail(err.message)
        // The text of an unexpected error can hold a path, so it never reaches the model or the log.
        log(
          `workspace: ${params.name} failed with an unexpected error (${(err as NodeJS.ErrnoException)?.code ?? 'no code'})`,
        )
        return fail('io: the call failed')
      } finally {
        running--
      }
    })
    return server
  }

  return {
    serve: async () => {
      const [client, side] = InMemoryTransport.createLinkedPair()
      const server = makeServer()
      servers.add(server)
      server.onclose = () => void servers.delete(server)
      await server.connect(side)
      return client
    },
    inFlight: () => running,
    stopTasks: async () => void (await options.tasks?.stop()),
    close: async () => {
      await options.tasks?.stop()
      await Promise.allSettled([...servers].map(s => s.close()))
      await confined.close()
    },
  }
}
