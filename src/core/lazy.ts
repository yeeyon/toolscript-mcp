// Lazy start (issue #63, slice 5, decision 028): a per-session stdio server starts on its first use and stops when idle.
// The Claude Code bridge is lazy by default. Any other stdio server is lazy only with `"lazy": true`. The tool list of
// a server that is asleep comes from a cache on disk, which is for display only. Pure: the host reads and writes the file.

import type { DownstreamTool } from './catalog.ts'
import type { ServerEntry, ServerKey, StdioServer } from './config.ts'
import type { Bridges } from './policy.ts'

/** The idle time before a lazy server stops: the same as the broker's children. */
export const LAZY_IDLE_MS = 10 * 60_000

/** The least `TOOLSCRIPT_LAZY_IDLE_MS`: a test or the bench shortens the idle time down to this. */
export const MIN_LAZY_IDLE_MS = 1000

/** The idle time: `TOOLSCRIPT_LAZY_IDLE_MS` when it is a whole number of at least MIN_LAZY_IDLE_MS, else the default. */
export const lazyIdleMs = (value: string | undefined): number => {
  if (value === undefined || !/^\d{1,9}$/.test(value)) return LAZY_IDLE_MS
  const ms = Number(value)
  return ms >= MIN_LAZY_IDLE_MS ? ms : LAZY_IDLE_MS
}

/**
 * True when the server starts on first use. Only a stdio server can: a bridge unless its entry says `"lazy": false`,
 * any other server only with `"lazy": true`. `on` is the switch (`TOOLSCRIPT_LAZY=0` turns it off for every server).
 */
export const isLazy = (key: ServerKey, server: ServerEntry, bridges: Bridges, on: boolean): server is StdioServer =>
  on && server.kind === 'stdio' && (server.lazy ?? bridges.has(key))

/** A tool list as a person's config of the last run: at most this many bytes of file, entries and tools per entry. */
export const MAX_CACHE_BYTES = 4_000_000
export const MAX_CACHE_ENTRIES = 64
export const MAX_CACHE_TOOLS = 500
/** The most characters of the JSON of one cached tool. */
const MAX_TOOL_CHARS = 100_000
const MAX_NAME_CHARS = 256
const MAX_DESCRIPTION_CHARS = 20_000

/** One cached list: the tools that `tools/list` returned, and when. */
export type CachedList = { readonly at: number; readonly tools: readonly DownstreamTool[] }

/** The cache by entry key (the hash of the launch). */
export type ToolsCache = ReadonlyMap<string, CachedList>

const VERSION = 1

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A JSON value that fits in the cap, or undefined. The text came from JSON.parse, so it holds only JSON values. */
const jsonValue = (value: unknown): unknown => {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  return text !== undefined && text.length <= MAX_TOOL_CHARS ? value : undefined
}

/** One cached tool, or undefined when its name is not a text. A field of the wrong type is dropped, never kept as is. */
const toolOf = (raw: unknown): DownstreamTool | undefined => {
  if (!isObject(raw) || typeof raw.name !== 'string' || raw.name === '' || raw.name.length > MAX_NAME_CHARS)
    return undefined
  const { description, inputSchema, outputSchema, annotations, _meta } = raw
  const tool = {
    name: raw.name,
    ...(typeof description === 'string' && { description: description.slice(0, MAX_DESCRIPTION_CHARS) }),
    ...(isObject(inputSchema) && jsonValue(inputSchema) !== undefined && { inputSchema }),
    ...(isObject(outputSchema) && jsonValue(outputSchema) !== undefined && { outputSchema }),
    ...(isObject(annotations) && jsonValue(annotations) !== undefined && { annotations }),
    ...(isObject(_meta) && jsonValue(_meta) !== undefined && { _meta }),
  }
  return tool
}

/**
 * The tools file as a cache. The file is read as written by an attacker: a text over MAX_CACHE_BYTES, a text that is not
 * JSON of this version, or an entry that does not parse gives no cache for it. At most MAX_CACHE_ENTRIES entries and
 * MAX_CACHE_TOOLS tools of each load. `problem` is a short fixed text, never content of the file.
 */
export const parseToolsCache = (text: string): { cache: ToolsCache; problem?: string } => {
  const none = (problem: string) => ({ cache: new Map<string, CachedList>(), problem })
  if (text.length > MAX_CACHE_BYTES) return none('the file is too large')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return none('the file is not JSON')
  }
  if (!isObject(json) || json.version !== VERSION || !isObject(json.entries))
    return none('the file is not a tools cache')
  const cache = new Map<string, CachedList>()
  try {
    for (const [id, raw] of Object.entries(json.entries)) {
      if (cache.size >= MAX_CACHE_ENTRIES) break
      if (!/^[0-9a-f]{64}$/.test(id) || !isObject(raw) || !Number.isFinite(raw.at) || !Array.isArray(raw.tools))
        continue
      if (raw.tools.length > MAX_CACHE_TOOLS) continue
      const tools: DownstreamTool[] = []
      for (const t of raw.tools) {
        const tool = toolOf(t)
        if (tool !== undefined) tools.push(tool)
      }
      cache.set(id, { at: raw.at as number, tools })
    }
  } catch {
    // A value nested so deep that JSON.stringify throws on it: no cache, and the next write replaces the file.
    return none('the file could not be read')
  }
  return { cache }
}

/** The tools of one live list, as the cache holds them: the five fields that `catalogOf` reads, no other. */
export const cachedTools = (tools: readonly DownstreamTool[]): DownstreamTool[] =>
  tools.map(({ name, description, inputSchema, outputSchema, annotations, _meta }) => ({
    name,
    ...(description !== undefined && { description }),
    ...(inputSchema !== undefined && { inputSchema }),
    ...(outputSchema !== undefined && { outputSchema }),
    ...(annotations !== undefined && { annotations }),
    ...(_meta !== undefined && { _meta }),
  }))

/**
 * The file text of the cache. The newest MAX_CACHE_ENTRIES entries stay, and a list over MAX_CACHE_TOOLS tools is not
 * cached (the entry is dropped), so the file always parses back.
 */
export const toolsCacheText = (cache: ToolsCache): string => {
  const entries = [...cache]
    .filter(([, list]) => list.tools.length <= MAX_CACHE_TOOLS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_CACHE_ENTRIES)
  return JSON.stringify({
    version: VERSION,
    entries: Object.fromEntries(entries.map(([id, list]) => [id, { at: list.at, tools: cachedTools(list.tools) }])),
  })
}

/**
 * The text that names a launch in the cache: the command, the arguments in order, the env of the config (after ${VAR}
 * expansion, not the env that the host inherits: its PATH differs by shell) and the folder. Not the server key or the folder of the session, so the cache is the same over folders. Never print it: it
 * holds env values. The host hashes it, so only the hash goes to disk.
 */
export const toolsKeyText = (server: StdioServer, env: Readonly<Record<string, string>>): string => {
  const names = Object.keys(env).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([
    'toolscript-tools',
    server.command,
    server.args,
    names.map(n => [n, env[n]]),
    server.cwd ?? null,
  ])
}

/** Two lists as the cache holds them: equal when the cache would write the same text for both. */
export const sameTools = (a: readonly DownstreamTool[], b: readonly DownstreamTool[]): boolean =>
  JSON.stringify(cachedTools(a)) === JSON.stringify(cachedTools(b))
