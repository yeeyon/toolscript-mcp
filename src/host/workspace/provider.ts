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
import {
  LIMITS,
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_VERSION,
  WorkspaceError,
  fold,
  includeTest,
  parseListInput,
  parsePathInput,
  parseSearchInput,
  parseTaskInput,
  pathParts,
  showPath,
  type Excluder,
  type ListInput,
  type PathInput,
  type SearchInput,
  type WorkspaceToolName,
} from '../../core/workspace.ts'
import { readCapped, type Confined, type Dir, type Kind } from './confined.ts'
import type { TaskRunner } from './task.ts'

export type ProviderOptions = {
  readonly confined: Confined
  /** The tasks of the root entry of the session. `run_task` is listed only when one of them is valid. */
  readonly tasks?: TaskRunner
  readonly excluded: Excluder
  /** The folder names that `list` and `search` do not enter. */
  readonly skip: readonly string[]
  readonly windows: boolean
  /** The stderr log. Never holds a path, a name or file content. */
  readonly log: (line: string) => void
  /** Tests only: smaller limits, so a test needs fewer files. */
  readonly limits?: { readonly searchFiles?: number; readonly listEntries?: number; readonly searchMs?: number }
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

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const cancelled = (signal: AbortSignal): void => {
  if (signal.aborted) throw new WorkspaceError('cancelled', 'the call was cancelled')
}

/** `text` in lower case, one UTF-16 unit for one unit, so a column in the folded line is a column in the line. */
const lowered = (text: string): string => {
  const whole = text.toLowerCase()
  return whole.length === text.length
    ? whole
    : text.replace(/[^]/g, c => (c.toLowerCase().length === 1 ? c.toLowerCase() : c))
}

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
  const { confined, excluded, windows, log } = options
  const limits = {
    searchFiles: LIMITS.searchFiles,
    listEntries: LIMITS.listEntries,
    searchMs: LIMITS.searchMs,
    ...options.limits,
  }
  const skip = new Set(options.skip.map(fold))
  const servers = new Set<Server>()
  let running = 0

  /** The parts of a path text, after the checks that need no file system call. */
  const target = (text: string): string[] => {
    const parts = pathParts(text, windows)
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
   * The bound of one walk: false once it has seen `searchFiles` names (every name counts, whatever it is) or has run
   * `searchMs`. So a tree with no match for the `include`, or one of folders only, ends too.
   */
  const budget = (): (() => boolean) => {
    const began = performance.now()
    let seen = 0
    return () => seen++ < limits.searchFiles && performance.now() - began <= limits.searchMs
  }

  /**
   * Visits each entry below `dir` in sorted order, down to `levels` levels. A name from the listing is a candidate:
   * `lstat` and each open prove it. An excluded name is never visited, a link is visited and never entered, and a
   * folder that vanished or became a link while the walk ran is left out. Returns false when a visit or the `within`
   * budget stopped the walk before its end.
   */
  const walk = async (
    dir: Dir,
    levels: number,
    visit: (entry: Entry, dir: Dir, name: string) => Promise<boolean>,
    signal: AbortSignal,
    within: () => boolean,
  ): Promise<boolean> => {
    const names = (await dir.names()).sort(byText)
    for (const name of names) {
      cancelled(signal)
      if (!within()) return false
      const parts = [...dir.parts, name]
      if (excluded(parts)) continue
      const entry = await dir.lstat(name)
      if (entry === undefined) continue
      if (!(await visit({ parts, kind: entry.kind, size: entry.size }, dir, name))) return false
      if (entry.kind !== 'folder' || levels <= 1 || skip.has(fold(name))) continue
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
        if (!(await walk(child, levels - 1, visit, signal, within))) return false
      } finally {
        await child.close()
      }
    }
    return true
  }

  const list = async (input: ListInput, signal: AbortSignal) => {
    const start = target(input.path)
    const inList = includeTest(input.include)
    const entries: { path: string; type: Kind; size?: number }[] = []
    let truncated = false
    const dir = await folder(start)
    try {
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
        budget(),
      )
      if (!complete) truncated = true
    } finally {
      await dir.close()
    }
    return { entries: entries.sort((a, b) => byText(a.path, b.path)), truncated }
  }

  const search = async (input: SearchInput, signal: AbortSignal) => {
    const start = target(input.path)
    const inList = includeTest(input.include)
    const query = input.ignoreCase ? lowered(input.query) : input.query
    const matches: { path: string; line: number; column: number; text: string }[] = []
    let truncated = false
    let scanned = 0
    let skipped = 0
    const dir = await folder(start)
    try {
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
              for (let at = line.indexOf(query); at >= 0; at = line.indexOf(query, at + query.length)) {
                if (matches.length >= input.maxMatches) {
                  truncated = true
                  return false
                }
                matches.push({ path, line: i + 1, column: at + 1, text: raw.slice(0, LIMITS.lineChars) })
              }
            }
            return true
          } finally {
            await opened.handle.close().catch(() => {})
          }
        },
        signal,
        budget(),
      )
      if (!complete) truncated = true
    } finally {
      await dir.close()
    }
    matches.sort((a, b) => byText(a.path, b.path) || a.line - b.line || a.column - b.column)
    return { matches, truncated, filesScanned: scanned, skipped }
  }

  const read = async (input: PathInput) => {
    const parts = target(input.path)
    if (parts.length === 0) throw new WorkspaceError('not-file', 'the path is the root, which is a folder')
    const opened = await confined.file(parts)
    try {
      if (excluded(opened.parts)) throw new WorkspaceError('excluded', 'the path is excluded from Workspace')
      const tooLarge = () => new WorkspaceError('too-large', `the file is larger than ${LIMITS.readBytes} bytes`)
      if (opened.size > LIMITS.readBytes) throw tooLarge()
      // The size can be old: read at most one byte more than the limit, and refuse when the file holds more.
      const bytes = await readCapped(opened.handle, LIMITS.readBytes)
      if (bytes === undefined) throw tooLarge()
      const text = decoded(bytes)
      if (text === 'binary') throw new WorkspaceError('binary', 'the file has a NUL byte, so it is not text')
      if (text === 'encoding') throw new WorkspaceError('encoding', 'the file is not valid UTF-8')
      return {
        path: showPath(opened.parts),
        content: text.text,
        hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        encoding: text.bom ? ('utf-8-bom' as const) : ('utf-8' as const),
        size: bytes.length,
      }
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
      // Where the volume can spell a name in another case, ask it for the real spelling, so an alias cannot pass.
      const entry = await parent.lstat(last, confined.method !== 'proc')
      if (entry === undefined) return missing
      const real = [...parent.parts, entry.real]
      if (excluded(real)) throw new WorkspaceError('excluded', 'the path is excluded from Workspace')
      if (entry.kind === 'link')
        throw new WorkspaceError('link', 'the path is a link: Workspace never follows a symlink or a junction')
      return { path: showPath(real), type: entry.kind, ...(entry.kind === 'file' && { size: entry.size }) }
    } finally {
      await parent.close()
    }
  }

  const runner = options.tasks !== undefined && options.tasks.names.length > 0 ? options.tasks : undefined

  const run: Partial<Record<WorkspaceToolName, (args: unknown, signal: AbortSignal) => Promise<unknown>>> = {
    list: (args, signal) => list(parseListInput(args), signal),
    search: (args, signal) => search(parseSearchInput(args), signal),
    read: args => read(parsePathInput(args)),
    stat: args => stat(parsePathInput(args)),
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }
  }

  const makeServer = (): Server => {
    const server = new Server(
      { name: 'toolscript-workspace', version: WORKSPACE_VERSION },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: WORKSPACE_TOOL_NAMES.filter(name => run[name] !== undefined).map(described) as never,
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
