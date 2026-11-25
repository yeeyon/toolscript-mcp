// The named tasks of the built-in Workspace (issue #144, pull request C): the pure rules behind `run_task`. A task is a
// fixed program, argument list, folder and environment from the config. The model sends only the name. This file holds
// the shape of a task, the checks of its text, the environment list, the output cap and the model-facing texts. The
// code that starts a process is in src/host/workspace/task.ts.

import { WorkspaceError, pathParts } from './workspace.ts'

export const TASK_LIMITS = {
  /** Tasks in one root entry. */
  tasks: 32,
  nameChars: 32,
  args: 64,
  argChars: 4096,
  envVars: 64,
  envChars: 4096,
  /** The time of a task with no `timeoutSeconds`, before the limit of a call lowers it. */
  defaultSeconds: 60,
  /** Each output stream keeps its first bytes and its last bytes. */
  headBytes: 64 * 1024,
  tailBytes: 192 * 1024,
} as const

/** A task name: 1 to 32 characters from `a-z`, `0-9`, `-` and `_`. */
export const TASK_NAME = /^[a-z0-9_-]{1,32}$/

/** A task as the config holds it, after `parseConfig`. Only the text is checked: the host resolves the command and the folder. */
export type TaskConfig = {
  readonly name: string
  /** An absolute path, or a bare name that the host resolves on `PATH` one time, at the start. */
  readonly command: string
  readonly args: readonly string[]
  /** The folder as parts, relative to the `path` of the root entry. No part: the entry itself. */
  readonly cwd: readonly string[]
  readonly timeoutSeconds: number
  readonly env: Readonly<Record<string, string>>
}

/** Where a command that is an absolute path starts: a drive letter or a share on Windows, `/` elsewhere. */
const absolute = (command: string, windows: boolean): boolean =>
  windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(command) : command.startsWith('/')

/**
 * Why `command` cannot be the command of a task, or undefined. It is an absolute path, or a bare name: a name with a
 * separator is relative to nothing that a person can predict. The text names no part of the command.
 */
export const commandProblem = (command: string, windows: boolean): string | undefined => {
  if (/[\u0000-\u001f]/.test(command)) return 'must hold no control character'
  if (absolute(command, windows)) return undefined
  if (/[\\/]/.test(command) || (windows && /^[A-Za-z]:/.test(command)))
    return 'must be an absolute path, or a bare command name that PATH holds, such as "node"'
  return undefined
}

/** True when `command` is a bare name, which the host looks up on `PATH`. */
export const isBareName = (command: string, windows: boolean): boolean =>
  !absolute(command, windows) && !/[\\/]/.test(command)

/** The folder of a task as parts, or why it is no folder inside the entry. `.` is the entry, with no part. */
export const cwdParts = (text: string, windows: boolean): readonly string[] | string => {
  try {
    return pathParts(text, windows)
  } catch (err) {
    if (err instanceof WorkspaceError)
      return 'must be a folder inside the root entry, relative, with / between parts, such as "." or "packages/app"'
    throw err
  }
}

/**
 * The variables of the server that reach a task, by name. Nothing else does, so a token in the environment of the
 * client stays out of the project code. The `env` of the task comes on top.
 */
export const TASK_ENV_NAMES: Readonly<Record<'win32' | 'other', readonly string[]>> = {
  win32: [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SystemDrive',
    'windir',
    'ComSpec',
    'USERPROFILE',
    'USERNAME',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'TEMP',
    'TMP',
    'PROCESSOR_ARCHITECTURE',
  ],
  other: ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'],
}

/**
 * The environment of the child: the listed variables that `source` holds, then `extra`. On Windows names ignore case,
 * so a task variable replaces a listed one of any case.
 */
export const taskEnv = (
  source: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
  windows: boolean,
): Record<string, string> => {
  const out: Record<string, string> = {}
  const lower = (name: string) => (windows ? name.toLowerCase() : name)
  const taken = new Set(Object.keys(extra).map(lower))
  for (const name of TASK_ENV_NAMES[windows ? 'win32' : 'other']) {
    const value = source[name]
    if (value !== undefined && !taken.has(lower(name))) out[name] = value
  }
  return { ...out, ...extra }
}

/** One argument as the command line of a Windows process holds it: the rule of libuv (`quote_cmd_arg`), which the C runtime reads back. */
const quoteArg = (arg: string): string => {
  if (arg === '') return '""'
  if (!/[ \t"]/.test(arg)) return arg
  if (!/["\\]/.test(arg)) return `"${arg}"`
  // A run of backslashes is doubled when a quote or the end follows it, and a quote gets one more.
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

/** The arguments of a task as the one command-line text that Windows hands to a process, joined by a space. */
export const argumentLine = (args: readonly string[]): string => args.map(quoteArg).join(' ')

/** The names of the tasks as a list for a message. */
export const taskList = (names: readonly string[]): string => names.join(', ')

/** Why `run_task` fails for a name that is not a valid task. The names are the ones in the config, so they are the person's own. */
export const unknownTask = (valid: readonly string[]): string => `unknown task. The tasks are: ${taskList(valid)}`

/** The note in the output of a stream that lost its middle. */
export const cutNote = (bytes: number): string => `\n… [${bytes} bytes cut] …\n`
