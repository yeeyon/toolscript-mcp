// Writes the toolscript-mcp config for init and allow.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

/**
 * Writes a config, which holds the env and header values of the servers, so that only the user reads it: a new
 * 0600 file in the same folder, then a rename onto `file`. The secrets never go into an old file that others can
 * read, and `file` never holds a part of a config. Without `replace`, the link fails with EEXIST when `file` exists.
 * A file system without hard links (vfat, exFAT, some SMB and FUSE mounts) gets an exclusive copy, which also fails
 * with EEXIST.
 */
export const writeConfig = async (file: string, text: string | Uint8Array, replace: boolean): Promise<void> => {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temp, text, { mode: 0o600, flag: 'wx' })
    if (replace) await fs.promises.rename(temp, file)
    else await fs.promises.link(temp, file).catch(() => fs.promises.copyFile(temp, file, fs.constants.COPYFILE_EXCL))
  } finally {
    await fs.promises.rm(temp, { force: true })
  }
}
