// Appends one line to the run log in HOME. A failure never fails the run: it
// logs one line to stderr and goes on.

import fs from 'node:fs'
import path from 'node:path'
import { oldRunLogFile, runLogFile } from '../core/paths.ts'
import { errorText } from '../core/protocol.ts'
import { rotates } from '../core/runlog.ts'

export const appendRunLog = async (home: string, line: string, log: (line: string) => void): Promise<void> => {
  try {
    const file = runLogFile(home)
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const size = (await fs.promises.stat(file).catch(() => undefined))?.size ?? 0
    if (rotates(size, Buffer.byteLength(line))) await fs.promises.rename(file, oldRunLogFile(home))
    // Only the person reads it: tool names show what the programs did.
    await fs.promises.appendFile(file, line, { mode: 0o600 })
  } catch (err) {
    log(`cannot write the run log: ${errorText(err)}`)
  }
}
