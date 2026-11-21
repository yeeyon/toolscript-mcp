// The learned result shapes across sessions: the file `~/.toolscript-mcp/learned/shapes.json`, which `search_tools`
// shows as `returned earlier`. The file is alone in its folder, and `guardedDirs` lists the folder. The file is read
// as written by an attacker: `parseShapes` keeps only entries that fully parse as a shape that `learnedShape` makes.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { shapesFile, shapesFolder } from '../core/paths.ts'
import {
  MAX_SHAPES_BYTES,
  canonicalJson,
  errorText,
  mergeShapes,
  parseShapes,
  shapesText,
  type Shapes,
  type StoredShape,
} from '../core/protocol.ts'
import { writeConfig } from './configfile.ts'

const hashes = new WeakMap<object, string>()

/** The hash of a tool's `inputSchema`: SHA-256 of its JSON with sorted keys, cut to 32 hex characters. */
export const schemaHash = (inputSchema: unknown): string => {
  const key = inputSchema !== null && typeof inputSchema === 'object' ? inputSchema : undefined
  const known = key === undefined ? undefined : hashes.get(key)
  if (known !== undefined) return known
  const hash = createHash('sha256').update(canonicalJson(inputSchema)).digest('hex').slice(0, 32)
  if (key !== undefined) hashes.set(key, hash)
  return hash
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const TRIES = 4
const RETRY_MS = 25

// Windows answers EPERM or EBUSY to an open or a rename of a file that another process has open: try again a few times.
const retried = async <T>(op: () => Promise<T>): Promise<T> => {
  for (let tries = 1; ; tries++) {
    try {
      return await op()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (tries >= TRIES || code === undefined || !BUSY.has(code)) throw err
      await new Promise(resolve => setTimeout(resolve, RETRY_MS))
    }
  }
}

/** The text of the file, undefined when it is absent. A file over MAX_SHAPES_BYTES is not read past that. */
const readText = async (file: string): Promise<string | undefined> => {
  const handle = await retried(() => fs.promises.open(file, 'r')).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  })
  if (handle === undefined) return undefined
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.allocUnsafe(Math.min(size, MAX_SHAPES_BYTES) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    // One byte past the cap: the parse refuses the text, so it never gets a file of that size.
    return buffer.toString('utf8', 0, length)
  } finally {
    await handle.close()
  }
}

/**
 * The shapes that earlier sessions learned, for the start of the server. A missing file gives none. An unusable or
 * unreadable file gives none and one log line. Never throws. `search_tools` shows a shape only after `shownShapes`
 * checks it against the schema of the listed tool.
 */
export const loadShapes = async (home: string, log: (line: string) => void): Promise<Shapes> => {
  try {
    const text = await readText(shapesFile(home))
    if (text === undefined) return {}
    const { shapes, dropped, problem } = parseShapes(text)
    if (problem !== undefined) log(`the learned shapes were not loaded: ${problem}`)
    else if (dropped > 0) log(`${dropped} learned shapes were dropped: they are not a shape of a tool result`)
    return shapes
  } catch (err) {
    log(`the learned shapes were not loaded: ${errorText(err)}`)
    return {}
  }
}

/**
 * Saves the shapes that a run learned: reads the file again, merges them on top and replaces the file with a new
 * temp file and a rename, so a reader never sees a part of it. Several server processes share the file and there
 * is no lock: the last writer wins, and an update that another process makes between this read and the rename is
 * lost. That update shows again when its tool is next called. A failure logs one line and never throws, so a run
 * never fails or waits on the file for more than a short retry.
 */
export const saveShapes = async (
  home: string,
  learned: ReadonlyMap<string, StoredShape>,
  log: (line: string) => void,
): Promise<void> => {
  try {
    const next = mergeShapes(await loadShapes(home, log), learned)
    if (next === undefined) return
    await fs.promises.mkdir(shapesFolder(home), { recursive: true, mode: 0o700 })
    await retried(() => writeConfig(shapesFile(home), shapesText(next), true))
  } catch (err) {
    log(`the learned shapes were not saved: ${errorText(err)}`)
  }
}
