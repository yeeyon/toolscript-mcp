// The tool lists of lazy servers across sessions: the file `~/.toolscript-mcp/learned/tools.json`, which shows a server
// that is asleep in `search_tools`. It is for display only: no check of a run reads it. The file sits in the folder that
// `guardedDirs` lists, and it is read as written by an attacker (`parseToolsCache`). Only a hash of each launch is on disk.

import { createHash } from 'node:crypto'
import { toolsFile } from '../core/paths.ts'
import {
  MAX_CACHE_BYTES,
  parseToolsCache,
  toolsCacheText,
  toolsKeyText,
  type CachedList,
  type ToolsCache,
} from '../core/lazy.ts'
import { errorText } from '../core/protocol.ts'
import { childEnv, type StdioServer } from '../core/config.ts'
import type { DownstreamTool } from '../core/catalog.ts'
import { childEnvironment } from './childtransport.ts'
import { writeConfig } from './configfile.ts'
import type { ToolsStore } from './downstream.ts'
import { readText, retried, SHAPES_WAIT_MS, within } from './shapes.ts'
import fs from 'node:fs'
import path from 'node:path'

/** The key of a launch: SHA-256 of its command, arguments, child environment and folder. */
export const toolsKey = (server: StdioServer): string =>
  createHash('sha256')
    .update(toolsKeyText(server, childEnvironment(childEnv(server))))
    .digest('hex')

/**
 * The cache as it is on disk. `readable` false: the file exists and could not be read, so a write must not replace it.
 * A file that is read and is unusable is readable: the next write replaces it. One log line, no content.
 */
const read = async (home: string, log: (line: string) => void): Promise<{ cache: ToolsCache; readable: boolean }> => {
  try {
    const text = await readText(toolsFile(home), MAX_CACHE_BYTES)
    if (text === undefined) return { cache: new Map(), readable: true }
    const { cache, problem } = parseToolsCache(text)
    if (problem !== undefined) log(`the tool cache was not loaded: ${problem}`)
    return { cache, readable: true }
  } catch (err) {
    log(`the tool cache was not loaded: ${errorText(err)}`)
    return { cache: new Map(), readable: false }
  }
}

/** The cache for the start of the server. Never throws, and a stuck read costs the start SHAPES_WAIT_MS at most. */
export const loadToolsCache = (home: string, log: (line: string) => void): Promise<ToolsCache> =>
  within(
    read(home, log).then(r => r.cache),
    SHAPES_WAIT_MS,
    new Map<string, CachedList>(),
  )

/**
 * Saves one entry: reads the file again, merges the entry on top and replaces the file with a 0600 temp file and a
 * rename, as the shapes file. The last writer wins. A failure logs one line and never throws.
 */
export const saveToolsEntry = (
  home: string,
  id: string,
  tools: readonly DownstreamTool[],
  log: (line: string) => void,
): Promise<void> => {
  // One write at a time in this process: two lazy servers that list together would else read the same file, and the
  // second rename would drop the entry of the first.
  const next = writes.then(() => within(write(home, id, tools, log), SHAPES_WAIT_MS, undefined)).then(() => undefined)
  writes = next
  return next
}

let writes: Promise<void> = Promise.resolve()

const write = async (
  home: string,
  id: string,
  tools: readonly DownstreamTool[],
  log: (line: string) => void,
): Promise<void> => {
  try {
    const current = await read(home, log)
    if (!current.readable) return
    const next = new Map(current.cache).set(id, { at: Date.now(), tools })
    const file = toolsFile(home)
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await retried(() => writeConfig(file, toolsCacheText(next), true))
  } catch (err) {
    log(`the tool cache was not saved: ${errorText(err)}`)
  }
}

/** The store of a running host, over the file under `home`. */
export const toolsStore = (home: string, log: (line: string) => void): ToolsStore => ({
  key: toolsKey,
  load: () => loadToolsCache(home, log),
  save: (id, tools) => saveToolsEntry(home, id, tools, log),
})
