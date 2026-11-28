// The reason that a stdio server gives when its command cannot start (the error of `spawn`, never the exit of a child
// that did start). It names the command and nothing else of the entry: no argument, no variable, no folder.

import { printable } from './policy.ts'

/** The longest command text that a reason shows. */
export const COMMAND_SHOWN = 200

/** What the spawn error code `code` of `command` says. Only the command of the server is in it. */
export const spawnReason = (command: string, code: string): string => {
  const shown = printable(command.slice(0, COMMAND_SHOWN))
  if (code === 'ENOENT')
    return /[\\/]/u.test(command)
      ? `its command file was not found: ${shown}`
      : `its command was not found on PATH: ${shown}`
  return `its command could not start (${code.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 20) || 'unknown'}): ${shown}`
}

/** The code of a spawn error, or undefined for an error that is not one. */
export const spawnCode = (error: unknown): string | undefined => {
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown }
  return typeof code === 'string' && typeof syscall === 'string' && syscall.startsWith('spawn') ? code : undefined
}

/**
 * Whether a spawn error means that the command did not start. On Windows cross-spawn's ENOENT is a guess: cmd.exe exited
 * with 1 and cross-spawn could not resolve the command, which is also what a Windows app execution alias that crashed
 * at its start looks like. That guess has `errno: 'ENOENT'` as a string (Node's own has a number). It is trusted only when
 * `found()`, a look for a file that cmd.exe could run, finds none. Every other error is the OS's own.
 */
export const trustedSpawnError = (error: unknown, platform: string, found: () => boolean): boolean => {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown }
  if (platform !== 'win32' || code !== 'ENOENT' || typeof errno !== 'string') return true
  return !found()
}
