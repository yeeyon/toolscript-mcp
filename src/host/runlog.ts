// Appends one line to the run log in HOME. A failure never fails the run: it
// logs one line to stderr and goes on.

import fs from 'node:fs'
import path from 'node:path'
import { oldRunLogFile, runLogFile } from '../core/paths.ts'
import { errorText } from '../core/protocol.ts'
import { rotates } from '../core/runlog.ts'

const sizeOf = async (file: string): Promise<number> => (await fs.promises.stat(file).catch(() => undefined))?.size ?? 0

// One write at a time per file in this process, so the size check, the rename
// and the append of two runs never interleave.
const queues = new Map<string, Promise<void>>()

export const appendRunLog = async (home: string, line: string, log: (line: string) => void): Promise<void> => {
  const file = runLogFile(home)
  const write = async (): Promise<void> => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const add = Buffer.byteLength(line)
      // Another process may rotate between the size check and the rename: a missing file means it did.
      if (rotates(await sizeOf(file), add)) {
        await fs.promises.rename(file, oldRunLogFile(home)).catch(err => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        })
      }
      // Only the person reads it: tool names show what the programs did.
      await fs.promises.appendFile(file, line, { mode: 0o600 })
    } catch (err) {
      log(`cannot write the run log: ${errorText(err)}`)
    }
  }
  const turn = (queues.get(file) ?? Promise.resolve()).then(write)
  queues.set(file, turn)
  await turn
  if (queues.get(file) === turn) queues.delete(file)
}
