// The helpers that end a Workspace task with every descendant (issue #149). Windows: one warm PowerShell 5.1 process
// (`runtime/task-job.ps1`) for each runner, with a Job Object for each task. Linux and macOS: `runtime/task-reap.pl` for
// each task. Nothing here decides a result (the runner reads the reports), and a value of a task never is in PowerShell
// source, in a command line or in the environment of a helper: it is a frame on the standard input or the socket.
// The pure parts (reports, decision, frames, environment block) are in `src/core/taskjob.ts`.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK_ENV_NAMES } from '../core/task.ts'
import {
  decide,
  parseReport,
  posixFrame,
  prctlNumber,
  WINDOWS_STOP_FRAME,
  windowsEnv,
  windowsFrame,
  type Report,
} from '../core/taskjob.ts'

export const TASK_JOB = fileURLToPath(new URL('../../runtime/task-job.ps1', import.meta.url))
export const TASK_REAP = fileURLToPath(new URL('../../runtime/task-reap.pl', import.meta.url))

/** The Windows helper has this long to connect, then it counts as failed (step `connect`). */
export const HELPER_CONNECT_MS = 10_000
/** It has this long, from its spawn, to report `ready` after its compile, then it counts as failed (step `compile`). */
export const HELPER_START_MS = 10_000
export const IDLE_MS = 10 * 60_000
export const PERL = '/usr/bin/perl'

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The Windows PowerShell 5.1 of this system, from the `SystemRoot` of the server, or undefined when it is not a file. */
export const powershellPath = (env: Readonly<Record<string, string | undefined>> = process.env): string | undefined => {
  const root = env.SystemRoot ?? env.SYSTEMROOT
  if (root === undefined || !path.win32.isAbsolute(root)) return undefined
  const file = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return isFile(file) ? file : undefined
}

export const perlPath = (): string | undefined => {
  try {
    fs.accessSync(PERL, fs.constants.X_OK)
  } catch {
    return undefined
  }
  return isFile(PERL) ? PERL : undefined
}

export type LaunchInput = {
  readonly file: string
  readonly args: readonly string[]
  readonly line: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export type LaunchHooks = {
  readonly data: (which: 'out' | 'err', chunk: Buffer) => void
  readonly report: (report: Report) => void
  readonly channelClosed: () => void
  readonly streamsEnded: () => void
  readonly spawnFailed: () => void
}

export type Launch = {
  /** Asks for the end of the task with its tree. The reports follow. */
  readonly stop: () => void | Promise<void>
  /** Ends the helper at once and, where it knows it, the group of the task. */
  readonly kill: () => void
  readonly release: () => void
}

const lines = (line: (text: string) => void): ((chunk: string) => void) => {
  let rest = ''
  return chunk => {
    rest += chunk
    for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n')) {
      const text = rest.slice(0, at)
      rest = rest.slice(at + 1)
      line(text)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Windows

const PIPES = String.raw`\\.\pipe` + '\\'
const SWITCHES = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

type Helper = {
  readonly proc: ChildProcess
  readonly server: net.Server
  readonly ready: Promise<boolean>
  readonly settleReady: (ok: boolean) => void
  state: 'starting' | 'idle' | 'busy' | 'dead'
  socket: net.Socket | undefined
  current: { readonly hooks: LaunchHooks } | undefined
  startTimer: NodeJS.Timeout | undefined
  connectTimer: NodeJS.Timeout | undefined
  idleTimer: NodeJS.Timeout | undefined
  why: string | undefined
  hung: boolean
  stopped: boolean
}

export type JobHost = {
  /** Writes the frame of a task to a ready helper, or says at which step the helper failed before the frame. */
  readonly launch: (
    input: LaunchInput,
    hooks: LaunchHooks,
    skip: () => boolean,
  ) => Promise<Launch | { readonly fallback: string }>
  readonly pid: () => number | undefined
  /** Starts the helper if it is not there and waits for `ready`: the failed step, or undefined. Runs no task. */
  readonly probe: () => Promise<string | undefined>
  readonly close: () => void
}

type Handle = { ref: () => unknown; unref: () => unknown }

export const createJobHost = (options: {
  readonly powershell: string
  readonly script: string
  readonly idleMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
}): JobHost => {
  const idleMs = options.idleMs ?? IDLE_MS
  const server = options.env ?? process.env
  let helper: Helper | undefined
  let closing = false

  const setRef = (h: Helper, on: boolean): void => {
    for (const handle of [h.proc, h.proc.stdin, h.socket, h.server] as (Handle | null | undefined)[]) {
      if (handle === null || handle === undefined) continue
      if (on) handle.ref()
      else handle.unref()
    }
  }

  const died = (h: Helper): void => {
    if (h.state === 'dead') return
    h.state = 'dead'
    clearTimeout(h.startTimer)
    clearTimeout(h.connectTimer)
    clearTimeout(h.idleTimer)
    h.why ??= h.proc.exitCode !== null ? `exit${h.proc.exitCode}` : 'ended'
    h.settleReady(false)
    h.server.close()
    h.socket?.destroy()
    if (h.proc.exitCode === null && h.proc.signalCode === null) h.proc.kill()
    const current = h.current
    h.current = undefined
    if (helper === h) helper = undefined
    current?.hooks.channelClosed()
    if (h.stopped && !closing && helper === undefined) {
      helper = spawnHelper()
      setRef(helper, false)
    }
  }

  const onLine = (h: Helper, text: string): void => {
    const report = parseReport(text)
    if (report === undefined) return
    if (report.kind === 'failed' && h.state === 'starting') h.why = report.step
    if (report.kind === 'ready') {
      if (h.state !== 'starting') return
      h.state = 'idle'
      clearTimeout(h.startTimer)
      rest(h)
      h.settleReady(true)
      return
    }
    const current = h.current
    current?.hooks.report(report)
    // The last report of a task ends its channel. The helper stays for the next one, or ends after `failed`.
    if (report.kind === 'exit' || report.kind === 'error' || report.kind === 'failed') {
      h.current = undefined
      if (h.state === 'busy') {
        h.state = 'idle'
        rest(h)
      }
      current?.hooks.channelClosed()
    }
  }

  /** An idle helper ends after `idleMs`, and no handle of it keeps the server alive. Each way to idle comes here. */
  const rest = (h: Helper): void => {
    clearTimeout(h.idleTimer)
    h.idleTimer = setTimeout(() => died(h), idleMs)
    h.idleTimer.unref()
    setRef(h, false)
  }

  const spawnHelper = (): Helper => {
    const pipe = `ts-job-${randomBytes(16).toString('hex')}`
    let settleReady: (ok: boolean) => void = () => {}
    const ready = new Promise<boolean>(resolve => (settleReady = resolve))
    const listener = net.createServer()
    listener.listen(PIPES + pipe)
    // The helper gets the short list of system variables that a task gets, never a value of a task.
    const systemRoot = server.SystemRoot ?? server.SYSTEMROOT ?? ''
    const env: Record<string, string> = { SystemRoot: systemRoot }
    for (const name of TASK_ENV_NAMES.win32) {
      const value = server[name]
      if (value !== undefined) env[name] = value
    }
    // The module path is the system folder only, so no foreign module loads (and none is searched at a first cmdlet).
    env.PSModulePath = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    const proc = spawn(options.powershell, [...SWITCHES, options.script, pipe], {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    const h: Helper = {
      proc,
      server: listener,
      ready,
      settleReady,
      state: 'starting',
      socket: undefined,
      current: undefined,
      startTimer: undefined,
      connectTimer: undefined,
      idleTimer: undefined,
      why: undefined,
      hung: false,
      stopped: false,
    }
    h.connectTimer = setTimeout(() => {
      if (h.state !== 'starting' || h.socket !== undefined) return
      h.hung = true
      h.why = 'connect'
      died(h)
    }, HELPER_CONNECT_MS)
    h.connectTimer.unref()
    h.startTimer = setTimeout(() => {
      if (h.state !== 'starting') return
      h.hung = true
      h.why = h.socket === undefined ? 'connect' : 'compile'
      died(h)
    }, HELPER_START_MS)
    h.startTimer.unref()
    listener.on('error', () => ((h.why ??= 'pipe'), died(h)))
    listener.on('connection', socket => {
      listener.close()
      clearTimeout(h.connectTimer)
      h.socket = socket
      socket.setEncoding('utf8')
      socket.on('error', () => {})
      socket.on(
        'data',
        lines(text => onLine(h, text)),
      )
      socket.on('close', () => died(h))
    })
    proc.stdin.on('error', () => {})
    proc.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      h.why ??= `spawn${typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? code : ''}`
      died(h)
    })
    proc.once('exit', () => {
      if (h.socket === undefined) died(h)
    })
    return h
  }

  const acquire = async (): Promise<Helper | string> => {
    let last = 'ended'
    for (let attempt = 0; attempt < 2; attempt++) {
      const h = helper ?? (helper = spawnHelper())
      setRef(h, true)
      const ok = await h.ready
      if (ok && h.state === 'idle') return h
      if (h.hung) return h.why ?? 'start'
      last = h.why ?? 'ended'
    }
    return last
  }

  const sink = (which: 'out' | 'err', hooks: LaunchHooks, done: () => void) => {
    const name = `ts-${which}-${randomBytes(16).toString('hex')}`
    let socket: net.Socket | undefined
    const pipe = net.createServer(connection => {
      socket = connection
      pipe.close()
      connection.on('data', (chunk: Buffer) => hooks.data(which, chunk))
      connection.on('error', () => {})
      connection.on('close', done)
    })
    const listening = new Promise<boolean>(resolve => {
      pipe.once('listening', () => resolve(true))
      pipe.once('error', () => resolve(false))
    })
    pipe.listen(PIPES + name)
    return {
      name,
      listening,
      close: () => {
        pipe.close()
        socket?.destroy()
      },
    }
  }

  return {
    pid: () => (helper === undefined || helper.state === 'dead' ? undefined : helper.proc.pid),
    probe: async () => {
      const got = await acquire()
      return typeof got === 'string' ? got : undefined
    },
    launch: async (input, hooks, skip) => {
      if (closing) return { fallback: 'closing' }
      const got = await acquire()
      if (typeof got === 'string') return { fallback: got }
      const h = got
      let open = 2
      const finish = (): void => void (--open === 0 && hooks.streamsEnded())
      const out = sink('out', hooks, finish)
      const err = sink('err', hooks, finish)
      const release = (): void => {
        out.close()
        err.close()
      }
      // A call that drops here leaves an idle helper: it gets its idle timer back and no longer keeps the server alive.
      const drop = (fallback: string): { readonly fallback: string } => {
        release()
        if (h.state === 'idle') rest(h)
        return { fallback }
      }
      if (!(await out.listening) || !(await err.listening) || h.state !== 'idle') return drop('streams')
      if (skip()) return drop('cancelled')
      clearTimeout(h.idleTimer)
      setRef(h, true)
      h.state = 'busy'
      h.current = { hooks }
      const frame = windowsFrame(
        { file: input.file, line: input.line, cwd: input.cwd, out: out.name, err: err.name },
        windowsEnv(input.env, server),
      )
      h.proc.stdin?.write(frame)
      const end = (): void => {
        h.stopped = true
        died(h)
      }
      return {
        // The helper ends the tree, waits until it is gone and reports `exit`; the runner kills it after KILL_WAIT_MS if it does not.
        stop: () => {
          if (h.current?.hooks === hooks && h.state === 'busy') h.proc.stdin?.write(WINDOWS_STOP_FRAME)
        },
        // After an `error`, `exit` or `failed` report the helper is idle or dead: it ends only while this task is its task.
        kill: () => {
          if (h.current?.hooks === hooks) end()
          release()
        },
        release,
      }
    },
    close: () => {
      closing = true
      if (helper !== undefined) died(helper)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Linux and macOS

/** Starts the perl helper for one task. It throws when the process cannot be spawned. */
export const startReap = (
  perl: string,
  script: string,
  prctl: number,
  input: LaunchInput,
  hooks: LaunchHooks,
): Launch => {
  const proc = spawn(perl, [script, String(prctl), input.file, ...input.args], {
    cwd: input.cwd,
    env: {},
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const socket = proc.stdio[3] as net.Socket
  let task: number | undefined
  let open = 2
  const streamDone = (): void => void (--open === 0 && hooks.streamsEnded())
  proc.stdout?.on('data', (chunk: Buffer) => hooks.data('out', chunk))
  proc.stderr?.on('data', (chunk: Buffer) => hooks.data('err', chunk))
  proc.stdout?.on('error', () => {})
  proc.stderr?.on('error', () => {})
  proc.stdout?.once('close', streamDone)
  proc.stderr?.once('close', streamDone)
  proc.once('error', () => hooks.spawnFailed())
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on(
    'data',
    lines(text => {
      const report = parseReport(text)
      if (report === undefined) return
      if (report.kind === 'started' && report.pid !== undefined) task = report.pid
      hooks.report(report)
    }),
  )
  socket.once('close', () => hooks.channelClosed())
  socket.write(posixFrame(input.env))
  const end = (pid: number | undefined): void => {
    if (pid === undefined) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  return {
    stop: () => void socket.end(),
    kill: () => {
      end(task)
      end(proc.pid)
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    },
    release: () => {},
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The probe of `toolscript-mcp doctor`

const PROBE_MS = 10_000

/**
 * One real start of the helper of this OS that runs no task of the config. It gives the failed step, or undefined when the
 * helper started. Linux and macOS start the perl helper with `/usr/bin/true` and stop it at its first report.
 */
export const probeHelper = async (): Promise<string | undefined> => {
  if (process.platform === 'win32') {
    const powershell = powershellPath()
    if (powershell === undefined) return 'powershell'
    const host = createJobHost({ powershell, script: TASK_JOB })
    try {
      return await host.probe()
    } finally {
      host.close()
    }
  }
  const perl = perlPath()
  if (perl === undefined) return 'perl'
  const nr = prctlNumber(process.platform, process.arch)
  if (nr === undefined) return 'arch'
  return new Promise<string | undefined>(resolve => {
    const seen: Report[] = []
    let launch: Launch | undefined
    let done = false
    const finish = (step?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      launch?.kill()
      resolve(step)
    }
    const timer = setTimeout(() => finish('start'), PROBE_MS)
    const hooks: LaunchHooks = {
      data: () => {},
      report: report => {
        seen.push(report)
        if (report.kind === 'begin') void launch?.stop()
      },
      channelClosed: () => {
        const outcome = decide(seen)
        finish(outcome.kind === 'fallback' ? outcome.step : undefined)
      },
      streamsEnded: () => {},
      spawnFailed: () => finish('spawn'),
    }
    try {
      launch = startReap(
        perl,
        TASK_REAP,
        nr,
        { file: '/usr/bin/true', args: [], line: '', cwd: '/', env: { TOOLSCRIPT_TASK: 'probe' } },
        hooks,
      )
    } catch {
      finish('spawn')
    }
  })
}
