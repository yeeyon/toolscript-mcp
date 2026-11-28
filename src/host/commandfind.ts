// The look for a command on the failure path of a start on Windows (see `trustedSpawnError` in src/core/spawn.ts).
// cross-spawn cannot resolve a Windows app execution alias (the 0-byte reparse files of `WindowsApps`) that cmd.exe
// runs, so its ENOENT can mean that a command that started has exited with code 1. This runs only after a start failed.

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EXT = '.COM;.EXE;.BAT;.CMD'

/** The value of `name` in `env`, whatever its case (a Windows variable is `Path` or `PATH`). */
const valueOf = (env: Readonly<Record<string, string>>, name: string): string | undefined => {
  const key = Object.keys(env).find(k => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/**
 * True when a file that cmd.exe could run for `command` exists: the name with each PATHEXT extension and as it is, in the
 * folder of the process and each PATH folder of `env`, or at the path itself. `lstat`, not `stat`: an alias is a reparse
 * file that `stat` cannot follow. A relative PATH folder is taken from `cwd`, as cmd.exe does for the child.
 *
 * It is synchronous on purpose: it runs only after a start failed, and the reason must be settled before the error and the
 * close of the child reach the host, in the same order every time. The cost is the file system calls of the lookup (about
 * 16 ms for 49 names in 13 folders here); a PATH folder on an unreachable network share would wait for its timeout once.
 * A cmd.exe builtin (`start`, `call`) has no file, so such a command that exits with 1 reads "not found": no MCP entry
 * plausibly does this.
 */
export const findCommand = (command: string, env: Readonly<Record<string, string>>, cwd?: string): boolean => {
  const exts = (valueOf(env, 'PATHEXT') ?? DEFAULT_EXT).split(';').filter(e => e !== '')
  const names = [command, ...exts.map(e => command + e)]
  const hasPath = /[\\/]/u.test(command) || /^[A-Za-z]:/u.test(command)
  const dirs = hasPath
    ? [cwd ?? process.cwd()]
    : [
        cwd ?? process.cwd(),
        ...(valueOf(env, 'PATH') ?? '')
          .split(path.delimiter)
          .map(d => d.replace(/^"|"$/gu, ''))
          .filter(d => d !== ''),
      ]
  for (const dir of dirs)
    for (const name of names)
      try {
        fs.lstatSync(path.resolve(cwd ?? process.cwd(), dir, name))
        return true
      } catch {}
  return false
}

/** A look for a command: true when a file for it exists. A test gives a fake. */
export type FindCommand = (command: string, env: Readonly<Record<string, string>>, cwd?: string) => boolean
