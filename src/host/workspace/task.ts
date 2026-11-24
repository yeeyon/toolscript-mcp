// The named tasks of the built-in Workspace (issue #144, pull request C). A task is a fixed program, argument list,
// folder and environment from the config. The model sends only its name. This file resolves each task once, at the
// start (`resolveTasks`), and runs them one at a time (`createTaskRunner`).
//
// A task is NOT contained: it runs project code with the rights of the user. What this file guarantees is narrower:
// no shell (`shell` is never set, and `cross-spawn` is not used, because it starts `cmd.exe` for a `.cmd` file), the
// arguments reach the child as given, the child gets a short list of variables, the output is capped, the time is
// limited, and the whole process tree ends at the time limit, at a cancel and at a shutdown.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePath } from '../../core/broker.ts'
import { TASK_LIMITS, cutNote, isBareName, taskEnv, unknownTask, type TaskConfig } from '../../core/task.ts'
import { WorkspaceError } from '../../core/workspace.ts'
import { endTree } from '../broker.ts'

/** After the top process exited, the streams get this long to end before the tree is ended. */
const DRAIN_MS = 1000
/** After the tree was ended, the call waits this long for the streams, then answers with what it has. */
const KILL_WAIT_MS = 3000

export type ResolvedTask = {
  readonly name: string
  /** The program: an absolute path. */
  readonly file: string
  readonly args: readonly string[]
  /** The real path of the folder of the task. */
  readonly cwd: string
  readonly timeoutMs: number
  /** The whole environment of the child. */
  readonly env: Readonly<Record<string, string>>
  /** Proves again, before each run, that the folder is still the folder that was proven at the start. */
  readonly proveCwd: () => Promise<void>
}

/** A task that cannot run, with the reason in our own text. The reason holds no value of the config. */
export type InvalidTask = { readonly name: string; readonly reason: string }

export type TaskSet = { readonly valid: readonly ResolvedTask[]; readonly invalid: readonly InvalidTask[] }

/** What `run_task` returns, as the table in src/core/workspace.ts says. */
export type TaskResult = {
  readonly task: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly ms: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Resolve

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

const runnable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

const realDir = (entry: string): string | undefined => {
  try {
    return fs.realpathSync.native(entry)
  } catch {
    return undefined
  }
}

/** The value of `PATH` in `source`, with any letter case of the name on Windows. */
const pathOf = (source: Readonly<Record<string, string | undefined>>, windows: boolean): string => {
  const key = windows ? Object.keys(source).find(k => k.toUpperCase() === 'PATH') : 'PATH'
  return (key === undefined ? undefined : source[key]) ?? ''
}

/**
 * The program that a bare command name finds on `PATH`, or undefined. The folders are made real, and a relative entry
 * is dropped: it would mean the folder where the client started the server. On Windows the extensions of `PATHEXT`
 * are tried in order, so a `.cmd` file is found, and then refused by `launchProblem`: no other file takes its place.
 */
export const findOnPath = (
  name: string,
  source: Readonly<Record<string, string | undefined>>,
  platform: string,
): string | undefined => {
  const windows = platform === 'win32'
  const delimiter = windows ? ';' : ':'
  const dirs = resolvePath(pathOf(source, windows).replaceAll('"', ''), delimiter, realDir, windows)
    .split(delimiter)
    .filter(dir => (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir) : dir.startsWith('/')))
  const exts = (source.PATHEXT ?? source.Pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(e => e.startsWith('.'))
    .map(e => e.toLowerCase())
  const own = path.win32.extname(name).toLowerCase()
  const names = !windows ? [name] : exts.includes(own) ? [name] : exts.map(e => `${name}${e}`)
  for (const dir of dirs)
    for (const candidate of names) {
      const file = path.join(dir, candidate)
      if (isFile(file) && (windows || runnable(file))) return file
    }
  return undefined
}

/** Why the program at `file` cannot be the command of a task, or undefined. */
export const launchProblem = (file: string, platform: string): string | undefined => {
  if (platform === 'win32' && !/\.(?:exe|com)$/i.test(file))
    return 'on Windows its command must be an .exe or .com file, so no shell parses it. To run a script, set "command" to "node" and give the script as the first argument'
  return undefined
}

/**
 * Looks up each task of one root entry, one time. `source` is the environment of the server: its `PATH` finds a bare
 * command, and a short list of its variables goes to the child. `proof` opens a folder of the entry as a proven handle:
 * the folder of a task must be one, with no link on the way, and not an excluded folder.
 */
export const resolveTasks = async (input: {
  readonly tasks: readonly TaskConfig[]
  /** The real path of the root entry: the folders of the tasks are relative to it. */
  readonly entry: string
  readonly source: Readonly<Record<string, string | undefined>>
  readonly platform: string
  /** The parts of a folder as the volume spells them, from the entry. It throws a WorkspaceError for a folder that is not proven. */
  readonly proof: (parts: readonly string[]) => Promise<readonly string[]>
}): Promise<TaskSet> => {
  const { entry, source, platform, proof } = input
  const windows = platform === 'win32'
  const valid: ResolvedTask[] = []
  const invalid: InvalidTask[] = []
  for (const task of input.tasks) {
    const refuse = (reason: string) => void invalid.push({ name: task.name, reason })
    const file = isBareName(task.command, windows) ? findOnPath(task.command, source, platform) : task.command
    if (file === undefined) {
      refuse('its command was not found on PATH')
      continue
    }
    if (!isFile(file)) {
      refuse('its command is not a file that exists')
      continue
    }
    const problem = launchProblem(file, platform)
    if (problem !== undefined) {
      refuse(problem)
      continue
    }
    if (!windows && !runnable(file)) {
      refuse('its command is not executable')
      continue
    }
    let real: readonly string[]
    try {
      real = await proof(task.cwd)
    } catch (err) {
      const code = err instanceof WorkspaceError ? err.code : undefined
      refuse(
        code === 'link'
          ? 'its cwd goes through a link, and a task never follows one'
          : code === 'excluded'
            ? 'its cwd is an excluded folder'
            : code === 'not-found' || code === 'not-folder'
              ? 'its cwd is not a folder that exists inside the root entry'
              : 'its cwd could not be checked',
      )
      continue
    }
    const cwd = path.join(entry, ...real)
    valid.push({
      name: task.name,
      file,
      args: task.args,
      cwd,
      timeoutMs: task.timeoutSeconds * 1000,
      env: taskEnv(source, task.env, windows),
      proveCwd: async () => {
        const again = await proof(task.cwd)
        if (path.join(entry, ...again) !== cwd)
          throw new WorkspaceError('root-changed', 'the folder of the task changed')
      },
    })
  }
  return { valid, invalid }
}

// ---------------------------------------------------------------------------------------------------------------
// Run

/** Keeps the first `HEAD` and the last `TAIL` bytes of a stream, and counts the rest. */
const capture = () => {
  const head: Buffer[] = []
  const tail: Buffer[] = []
  let headLen = 0
  let tailLen = 0
  let total = 0
  return {
    add(chunk: Buffer): void {
      total += chunk.length
      if (headLen < TASK_LIMITS.headBytes) {
        const take = chunk.subarray(0, TASK_LIMITS.headBytes - headLen)
        head.push(take)
        headLen += take.length
        chunk = chunk.subarray(take.length)
      }
      if (chunk.length === 0) return
      tail.push(chunk)
      tailLen += chunk.length
      while (tail.length > 1 && tailLen - tail[0]!.length >= TASK_LIMITS.tailBytes) tailLen -= tail.shift()!.length
    },
    done(): { text: string; truncated: boolean } {
      const first = Buffer.concat(head)
      let last = Buffer.concat(tail)
      if (last.length > TASK_LIMITS.tailBytes) last = last.subarray(last.length - TASK_LIMITS.tailBytes)
      const cut = total - first.length - last.length
      if (cut === 0) return { text: Buffer.concat([first, last]).toString('utf8'), truncated: false }
      return { text: first.toString('utf8') + cutNote(cut) + last.toString('utf8'), truncated: true }
    },
  }
}

const startError = (err: unknown): WorkspaceError => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return new WorkspaceError('io', `the task could not start (${typeof code === 'string' ? code : 'error'})`)
}

export type TaskRunner = {
  /** The names of the tasks that can run. */
  readonly names: readonly string[]
  /** The tasks that cannot run, with the reason. */
  readonly invalid: readonly InvalidTask[]
  /** Runs the task `name` after the one that runs now. It ends the tree on a cancel through `signal`. */
  readonly run: (name: string, signal: AbortSignal) => Promise<TaskResult>
  /** Ends the task that runs, with its tree, and refuses each later call. It settles when the tree is gone. */
  readonly stop: () => Promise<void>
}

type Live = { kill: () => void; readonly done: Promise<void> }

export const createTaskRunner = (set: TaskSet): TaskRunner => {
  const byName = new Map(set.valid.map(t => [t.name, t]))
  const live = new Set<Live>()
  let halted = false
  let tail: Promise<void> = Promise.resolve()

  const execute = (task: ResolvedTask, signal: AbortSignal): Promise<TaskResult> => {
    let settleDone = () => {}
    const entry: Live = { kill: () => {}, done: new Promise<void>(resolve => (settleDone = resolve)) }
    const result = new Promise<TaskResult>((resolve, reject) => {
      const began = performance.now()
      let proc: ChildProcess
      try {
        // No `shell`, and no `cross-spawn`. Standard input is closed. The group is how the tree ends outside Windows.
        proc = spawn(task.file, [...task.args], {
          cwd: task.cwd,
          env: { ...task.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        })
      } catch (err) {
        return reject(startError(err))
      }
      const out = capture()
      const err = capture()
      let why: 'timeout' | 'cancel' | undefined
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
      let spawned = false
      let ended = false
      let drain: NodeJS.Timeout | undefined
      let backstop: NodeJS.Timeout | undefined

      const settle = (): void => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        clearTimeout(drain)
        clearTimeout(backstop)
        signal.removeEventListener('abort', onAbort)
        live.delete(entry)
        settleDone()
        if (why === 'cancel')
          return reject(new WorkspaceError('cancelled', 'the call was cancelled, and the task was ended'))
        const o = out.done()
        const e = err.done()
        resolve({
          task: task.name,
          exitCode: why === 'timeout' ? null : (exit?.code ?? null),
          signal: exit?.signal ?? (why === 'timeout' ? 'SIGKILL' : null),
          timedOut: why === 'timeout',
          ms: Math.round(performance.now() - began),
          stdout: o.text,
          stderr: e.text,
          stdoutTruncated: o.truncated,
          stderrTruncated: e.truncated,
        })
      }
      const stop = (reason: 'timeout' | 'cancel'): void => {
        if (ended) return
        why ??= reason
        void endTree(proc).then(() => {
          if (!ended) backstop ??= setTimeout(settle, KILL_WAIT_MS)
        })
      }
      const onAbort = (): void => stop('cancel')
      const timer = setTimeout(() => stop('timeout'), task.timeoutMs)
      entry.kill = () => stop('cancel')

      proc.stdout?.on('data', (chunk: Buffer) => out.add(chunk))
      proc.stderr?.on('data', (chunk: Buffer) => err.add(chunk))
      proc.stdout?.on('error', () => {})
      proc.stderr?.on('error', () => {})
      proc.once('spawn', () => (spawned = true))
      proc.once('error', error => {
        if (spawned || ended) return
        ended = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        live.delete(entry)
        settleDone()
        reject(startError(error))
      })
      proc.once('exit', (code, sig) => {
        exit = { code, signal: sig }
        // A grandchild can keep the streams open. It gets DRAIN_MS, then the tree ends.
        drain = setTimeout(() => {
          void endTree(proc)
          backstop ??= setTimeout(settle, KILL_WAIT_MS / 2)
        }, DRAIN_MS)
      })
      proc.once('close', (code, sig) => {
        exit ??= { code, signal: sig }
        // A task that left a background process in its group does not leave it behind.
        void endTree(proc)
        settle()
      })
      signal.addEventListener('abort', onAbort, { once: true })
      live.add(entry)
    })
    return result
  }

  /** Waits for `previous`, or for the end of the call. A call that ends while it waits takes no turn. */
  const turn = (previous: Promise<void>, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const gone = (): void => reject(new WorkspaceError('cancelled', 'the call was cancelled'))
      if (signal.aborted) return gone()
      signal.addEventListener('abort', gone, { once: true })
      void previous.then(() => {
        signal.removeEventListener('abort', gone)
        resolve()
      })
    })

  return {
    names: set.valid.map(t => t.name),
    invalid: set.invalid,
    run: (name, signal) => {
      const task = byName.get(name)
      if (task === undefined) {
        const bad = set.invalid.find(t => t.name === name)
        throw new WorkspaceError(
          'bad-input',
          bad === undefined ? unknownTask([...byName.keys()]) : `the task ${name} is invalid: ${bad.reason}`,
        )
      }
      const previous = tail
      const job = (async (): Promise<TaskResult> => {
        await turn(previous, signal)
        if (halted) throw new WorkspaceError('cancelled', 'Workspace is closing')
        await task.proveCwd()
        return execute(task, signal)
      })()
      // The next call waits for this one to end, and for the one before it.
      tail = Promise.allSettled([previous, job]).then(() => {})
      return job
    },
    stop: async () => {
      halted = true
      const running = [...live]
      for (const one of running) one.kill()
      await Promise.race([
        Promise.allSettled(running.map(one => one.done)),
        new Promise(resolve => setTimeout(resolve, KILL_WAIT_MS * 2).unref()),
      ])
    },
  }
}
