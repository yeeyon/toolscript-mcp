// The named tasks of the built-in Workspace (issue #144, pull request C). A task is a fixed program, argument list,
// folder and environment from the config. The model sends only its name. This file resolves each task once, at the
// start (`resolveTasks`), and runs them one at a time (`createTaskRunner`).
//
// A task is NOT contained: it runs project code with the rights of the user. What this file guarantees is narrower:
// no shell (`shell` is never set, and `cross-spawn` is not used, because it starts `cmd.exe` for a `.cmd` file), the
// arguments reach the child as given, the child gets a short list of variables, the output is capped, the time is
// limited, and the process tree ends however the task ends (exit, time limit, cancel, shutdown, hard kill of the server)
// through a helper of the OS (src/host/taskjob.ts; the rules and what stays are in the ADR of issue #149). When no helper
// can run, the task runs by the direct spawn with one note on stderr. A result comes only from the reports of a helper,
// read after its channel ended, and a task never runs two times.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePath } from '../../core/broker.ts'
import {
  TASK_LIMITS,
  argumentLine,
  cutNote,
  isBareName,
  taskEnv,
  unknownTask,
  type TaskConfig,
} from '../../core/task.ts'
import { decide, prctlNumber, startCode, taskRefusal, type Outcome, type Report } from '../../core/taskjob.ts'
import { WorkspaceError } from '../../core/workspace.ts'
import { endTree } from '../broker.ts'
import {
  PERL,
  TASK_JOB,
  TASK_REAP,
  createJobHost,
  perlPath,
  powershellPath,
  startReap,
  type JobHost,
  type Launch,
  type LaunchHooks,
} from '../taskjob.ts'

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
  const absolute = (dir: string): boolean => (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir) : dir.startsWith('/'))
  const entries = pathOf(source, windows).replaceAll('"', '').split(delimiter).filter(absolute).join(delimiter)
  const dirs = resolvePath(entries, delimiter, realDir, windows).split(delimiter).filter(absolute)
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

/** The head without a last character that is cut in two: it backs off to the lead byte of that character. */
const wholeHead = (bytes: Buffer): Buffer => {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
    const b = bytes[i]!
    if ((b & 0xc0) === 0x80) continue
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return i + need > bytes.length ? bytes.subarray(0, i) : bytes
  }
  return bytes
}

/** The tail without a first character that is cut in two: it drops the continuation bytes at its start. */
const wholeTail = (bytes: Buffer): Buffer => {
  let i = 0
  while (i < 3 && i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++
  return bytes.subarray(i)
}

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
      let first: Buffer = Buffer.concat(head)
      let last: Buffer = Buffer.concat(tail)
      if (last.length > TASK_LIMITS.tailBytes) last = last.subarray(last.length - TASK_LIMITS.tailBytes)
      if (total - first.length - last.length === 0)
        return { text: Buffer.concat([first, last]).toString('utf8'), truncated: false }
      // The cut falls on a character border, so no character is split into two broken ones.
      first = wholeHead(first)
      last = wholeTail(last)
      const cut = total - first.length - last.length
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
  readonly helperPid: () => number | undefined
}

type Live = { kill: () => void; readonly done: Promise<void> }

export type RunnerOptions = {
  /** `sandbox.callTimeoutSeconds` in ms: a task that has a helper is stopped one second before it. Default 60 s. */
  readonly callMs?: number
  /**
   * `false` never uses a helper. `script` replaces the helper script of this OS (a test of a helper that fails), and
   * `idleMs` shortens the idle stop of the Windows helper.
   */
  readonly helper?: false | { readonly script?: string; readonly idleMs?: number; readonly perl?: string }
  readonly note?: (line: string) => void
}

const signalName = (n: number): string | null =>
  Object.entries(os.constants.signals).find(([, v]) => v === n)?.[0] ?? null

export const createTaskRunner = (set: TaskSet, options: RunnerOptions = {}): TaskRunner => {
  const byName = new Map(set.valid.map(t => [t.name, t]))
  const live = new Set<Live>()
  let halted = false
  let tail: Promise<void> = Promise.resolve()
  const win = process.platform === 'win32'
  const callMs = options.callMs ?? 60_000
  let broken = options.helper === false
  let noted = false
  let host: JobHost | undefined
  const breakHelper = (step: string): void => {
    broken = true
    if (noted) return
    noted = true
    const rest = win
      ? 'a task now ends with the taskkill tree, and a process whose parent already exited can stay'
      : 'a task now ends with its process group, a process that left the group can stay, and nothing ends at a hard kill of the server'
    const line = `Workspace: the task helper failed at the step ${step}, so tasks now run by the direct spawn: ${rest}.`
    if (options.note !== undefined) options.note(line)
    else process.stderr.write(`${line}\n`)
  }
  /** Which helper this OS gives, or undefined when the direct spawn takes the call (with the note, one time). */
  const helperKind = (): 'job' | 'reap' | undefined => {
    if (broken) return undefined
    if (win) {
      const powershell = powershellPath()
      if (powershell === undefined) return void breakHelper('powershell')
      const own = options.helper || undefined
      host ??= createJobHost({
        powershell,
        script: own?.script ?? TASK_JOB,
        ...(own?.idleMs !== undefined && { idleMs: own.idleMs }),
      })
      return 'job'
    }
    if (perlPath() === undefined) return void breakHelper('perl')
    if (prctlNumber(process.platform, process.arch) === undefined) return void breakHelper('arch')
    return 'reap'
  }

  const execute = (task: ResolvedTask, signal: AbortSignal): Promise<TaskResult> => {
    let settleDone = () => {}
    const entry: Live = { kill: () => {}, done: new Promise<void>(resolve => (settleDone = resolve)) }
    const result = new Promise<TaskResult>((resolve, reject) => {
      const began = performance.now()
      const line = win ? argumentLine(task.args) : ''
      const refusal = taskRefusal({ file: task.file, line, args: task.args, env: task.env }, win)
      if (refusal !== undefined) return reject(startError({ code: refusal }))
      const out = capture()
      const err = capture()
      let launch: Launch | undefined
      let launching = false
      let why: 'timeout' | 'cancel' | undefined
      let seen: Report[] = []
      let channel = false
      let streams = false
      let ended = false
      let timer: NodeJS.Timeout | undefined
      let cap: NodeJS.Timeout | undefined
      let waiting: NodeJS.Timeout | undefined
      let backstop: NodeJS.Timeout | undefined

      const finish = (): void => {
        ended = true
        for (const t of [timer, cap, waiting, backstop]) clearTimeout(t)
        signal.removeEventListener('abort', onAbort)
        live.delete(entry)
        launch?.release()
        settleDone()
      }
      const answer = (o: Outcome): void => {
        if (ended) return
        finish()
        if (why === 'cancel')
          return reject(new WorkspaceError('cancelled', 'the call was cancelled, and the task was ended'))
        if (why === undefined && (o.kind === 'lost' || o.kind === 'stopped'))
          return reject(new WorkspaceError('io', 'the task ended with no result: its helper stopped'))
        const code = o.kind === 'exit' ? o.code : null
        const sig = o.kind === 'signal' ? signalName(o.signal) : null
        const so = out.done()
        const se = err.done()
        resolve({
          task: task.name,
          exitCode: why === 'timeout' ? null : code,
          signal: sig ?? (why === 'timeout' ? 'SIGKILL' : null),
          timedOut: why === 'timeout',
          ms: Math.round(performance.now() - began),
          stdout: so.text,
          stderr: se.text,
          stdoutTruncated: so.truncated,
          stderrTruncated: se.truncated,
        })
      }
      const startFailed = (error: unknown): void => {
        if (ended) return
        launch?.kill()
        finish()
        reject(startError(error))
      }
      /** The helper never started the task: the direct spawn takes this call, and each later one. */
      const fallBack = (step: string): void => {
        if (ended) return
        const failed = launch
        launch = undefined
        failed?.kill()
        failed?.release()
        // A cancel or a time limit that ended the helper is no failure of it.
        if (why !== undefined) return answer({ kind: 'stopped' })
        breakHelper(step)
        seen = []
        channel = false
        streams = false
        launchDirect()
      }
      const evaluate = (): void => {
        if (ended || !channel) return
        const o = decide(seen)
        if (o.kind === 'fallback') return fallBack(o.step)
        if (o.kind === 'start-error') return startFailed({ code: startCode(win, o.code) })
        if (streams) return answer(o)
        waiting ??= setTimeout(() => answer(o), KILL_WAIT_MS)
      }
      /** A helper that did not answer a stop: it ends, with the group of the task where known, and the call answers. */
      const force = (): void => {
        if (ended) return
        launch?.kill()
        channel = true
        streams = true
        evaluate()
      }
      const stop = (reason: 'timeout' | 'cancel'): void => {
        if (ended) return
        why ??= reason
        if (launch === undefined) {
          if (!launching) answer({ kind: 'stopped' })
          return
        }
        void Promise.resolve(launch.stop()).then(() => {
          if (!ended) backstop ??= setTimeout(force, KILL_WAIT_MS)
        })
      }
      const onAbort = (): void => stop('cancel')
      const arm = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => stop('timeout'), task.timeoutMs)
      }
      entry.kill = () => stop('cancel')

      /** The hooks of one launch. A launch that the fallback retired gets no effect from its late callbacks. */
      let generation = 0
      const newHooks = (): LaunchHooks => {
        const id = ++generation
        const current = (run: () => void) => (): void => void (id === generation && run())
        return {
          data: (which, chunk) => void (id === generation && !ended && (which === 'out' ? out : err).add(chunk)),
          report: report => {
            if (id !== generation) return
            seen.push(report)
            if (report.kind === 'started') arm()
          },
          channelClosed: current(() => {
            channel = true
            evaluate()
          }),
          streamsEnded: current(() => {
            streams = true
            evaluate()
          }),
          spawnFailed: current(() => fallBack('spawn')),
        }
      }

      /** The direct spawn. No `shell`, and no `cross-spawn`. Standard input is closed. The group ends the tree outside Windows. */
      const launchDirect = (): void => {
        const hooks = newHooks()
        let proc: ChildProcess
        try {
          proc = spawn(task.file, [...task.args], {
            cwd: task.cwd,
            env: { ...task.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: !win,
          })
        } catch (error) {
          return startFailed(error)
        }
        let spawned = false
        let info: { code: number | null; signal: NodeJS.Signals | null } | undefined
        let drain: NodeJS.Timeout | undefined
        let drained: NodeJS.Timeout | undefined
        /** The streams are closed or gave up: the direct spawn has no helper, so its reports are made here. */
        const over = (): void => {
          clearTimeout(drain)
          clearTimeout(drained)
          if (info?.signal != null) seen.push({ kind: 'signal', signal: os.constants.signals[info.signal] ?? 9 })
          else seen.push({ kind: 'exit', code: info?.code ?? 0 })
          streams = true
          hooks.channelClosed()
        }
        seen.push({ kind: 'begin' }, { kind: 'started', pid: proc.pid })
        launch = {
          stop: () => endTree(proc),
          kill: () => void endTree(proc),
          release: () => {},
        }
        arm()
        proc.stdout?.on('data', (chunk: Buffer) => hooks.data('out', chunk))
        proc.stderr?.on('data', (chunk: Buffer) => hooks.data('err', chunk))
        proc.stdout?.on('error', () => {})
        proc.stderr?.on('error', () => {})
        proc.once('spawn', () => (spawned = true))
        proc.once('error', error => {
          if (!spawned) startFailed(error)
        })
        proc.once('exit', (code, sig) => {
          info = { code, signal: sig }
          // A grandchild can keep the streams open. It gets DRAIN_MS, then the tree ends.
          drain = setTimeout(() => {
            void endTree(proc)
            drained = setTimeout(over, KILL_WAIT_MS / 2)
          }, DRAIN_MS)
        })
        proc.once('close', (code, sig) => {
          info ??= { code, signal: sig }
          // A task that left a background process in its group does not leave it behind.
          void endTree(proc)
          over()
        })
      }

      /** Windows: one warm helper makes a job for the task. The call waits for `ready` before the frame is written. */
      const launchJob = (job: JobHost): void => {
        launching = true
        const input = { file: task.file, args: task.args, line, cwd: task.cwd, env: task.env }
        void job
          .launch(input, newHooks(), () => ended || why !== undefined)
          .then(
            got => {
              launching = false
              if (ended) return
              if ('fallback' in got) return fallBack(got.fallback)
              launch = got
              // A stop that came while the frame was written ends the task now.
              if (why !== undefined) stop(why)
            },
            () => {
              launching = false
              fallBack('spawn')
            },
          )
      }

      /** Linux and macOS: the perl helper for this task. macOS marks the environment, as no kernel object holds the tree. */
      const launchReap = (): void => {
        const mark: Record<string, string> =
          process.platform === 'darwin' ? { TOOLSCRIPT_TASK: randomBytes(16).toString('hex') } : {}
        const input = { file: task.file, args: task.args, line, cwd: task.cwd, env: { ...task.env, ...mark } }
        try {
          launch = startReap(
            (options.helper && options.helper.perl) || PERL,
            options.helper ? (options.helper.script ?? TASK_REAP) : TASK_REAP,
            prctlNumber(process.platform, process.arch) ?? 0,
            input,
            newHooks(),
          )
        } catch {
          return fallBack('spawn')
        }
      }

      signal.addEventListener('abort', onAbort, { once: true })
      live.add(entry)
      if (signal.aborted) return stop('cancel')
      const kind = helperKind()
      if (kind === 'job' && host !== undefined) {
        // The time of the task runs from its reported start. This cap keeps `timedOut` ahead of the cancel of the call.
        cap = setTimeout(() => stop('timeout'), Math.max(0, callMs - 1000))
        launchJob(host)
      } else if (kind === 'reap') {
        cap = setTimeout(() => stop('timeout'), Math.max(0, callMs - 1000))
        launchReap()
      } else launchDirect()
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
    helperPid: () => host?.pid(),
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
        // A cancel or a shutdown during the proof must not start the task.
        if (halted) throw new WorkspaceError('cancelled', 'Workspace is closing')
        if (signal.aborted) throw new WorkspaceError('cancelled', 'the call was cancelled')
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
      // The helper ends each tree and reports before it is closed: a shutdown also leaves no process of a task behind.
      await Promise.race([
        Promise.allSettled(running.map(one => one.done)),
        new Promise(resolve => setTimeout(resolve, KILL_WAIT_MS * 2).unref()),
      ])
      host?.close()
    },
  }
}
