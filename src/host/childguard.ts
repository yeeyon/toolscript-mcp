// The child guard (see `src/core/childguard.ts`): what ends the stdio children of a host, or of the broker, when that
// process dies with no cleanup. Outside Windows: one `/bin/sh` watchdog, started at the first child, that kills the groups
// still listed when its input ends. On Windows, only when `TOOLSCRIPT_CHILD_GUARD=1`: `runtime/child-guard.cs`, compiled
// one time with the csc.exe of .NET Framework 4 into `~/.toolscript-mcp/guard`, started at the first child. A guard that
// cannot start never fails a server: it logs one line and the children run as they did before. Nothing but pids and group
// ids goes to either, and a system binary is never copied or renamed.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GUARD_ENV,
  WATCHDOG,
  guardExeName,
  guardLine,
  guardWanted,
  minusLine,
  offLine,
  plusLine,
  windowsFailure,
} from '../core/childguard.ts'
import { childGuardFolder } from '../core/paths.ts'
import { privateFolder } from './brokerwire.ts'

export const GUARD_SOURCE = fileURLToPath(new URL('../../runtime/child-guard.cs', import.meta.url))
/** The Windows program has this long, from its start, to say `ready` (the first start of a new program is scanned). */
export const READY_MS = 15_000
/** The compile has this long. It took 1 to 2 s. */
export const COMPILE_MS = 60_000

export type GuardState =
  | { readonly state: 'unwanted' }
  | { readonly state: 'starting' }
  | { readonly state: 'on'; readonly how: string }
  | { readonly state: 'failed'; readonly why: string }

export type Guard = {
  /** Lists a child (the leader of its own group outside Windows, a child of this process on Windows). */
  readonly add: (pid: number | undefined) => void
  /** Drops a child that ended. Call it after the group of the child was ended, and before its group id can be reused. */
  readonly remove: (pid: number | undefined) => void
  /** Starts the guard with no child, for `doctor`. */
  readonly start: () => void
  /** Settles when the guard is on or failed. Unwanted: at once. */
  readonly settled: () => Promise<GuardState>
  /** Ends the guard: what it still lists loses its tree. Call it when every child is stopped. */
  readonly close: () => void
  readonly state: () => GuardState
}

export type GuardOptions = {
  /** HOME, for the folder of the compiled program. */
  readonly home: string
  /** The line of an event, without the `toolscript-mcp:` prefix. */
  readonly log: (line: string) => void
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Tests: another shell, another csc.exe, another source, a shorter ready time. */
  readonly shell?: string
  readonly csc?: string
  readonly source?: string
  readonly readyMs?: number
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** True for a plain file, false for a link, a folder or anything else, undefined when there is nothing at the path. */
const plainFile = (file: string): boolean | undefined => {
  try {
    return fs.lstatSync(file).isFile()
  } catch {
    return undefined
  }
}

const noGuard: Guard = {
  add: () => {},
  remove: () => {},
  start: () => {},
  settled: () => Promise.resolve({ state: 'unwanted' }),
  close: () => {},
  state: () => ({ state: 'unwanted' }),
}

export const createGuard = (options: GuardOptions): Guard => {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (!guardWanted(platform, env[GUARD_ENV])) return noGuard
  return platform === 'win32' ? windowsGuard(options, env) : posixGuard(options)
}

/** Shared state of both guards: the state, its settle, and the one line when it fails. */
const stateOf = (log: (line: string) => void, explain: (why: string) => string) => {
  let state: GuardState = { state: 'starting' }
  let settle: (state: GuardState) => void = () => {}
  const settled = new Promise<GuardState>(resolve => (settle = resolve))
  return {
    get: () => state,
    settled: () => settled,
    on: (how: string) => {
      if (state.state !== 'starting') return
      state = { state: 'on', how }
      log(`child guard: on (${how})`)
      settle(state)
    },
    fail: (why: string) => {
      if (state.state === 'failed') return
      const first = state.state === 'starting' || state.state === 'on'
      state = { state: 'failed', why }
      if (first) log(offLine(explain(why)))
      settle(state)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Linux and macOS

const posixGuard = (options: GuardOptions): Guard => {
  const own = stateOf(options.log, why => why)
  let proc: ChildProcess | undefined
  let closed = false

  const start = (): void => {
    if (proc !== undefined || closed || own.get().state === 'failed') return
    const shell = options.shell ?? '/bin/sh'
    try {
      fs.accessSync(shell, fs.constants.X_OK)
    } catch {
      return own.fail(`there is no ${shell}`)
    }
    // Its own session: a signal to the group of the host (a closed terminal) must not take the watchdog before its EOF.
    const dog = spawn(shell, ['-c', WATCHDOG], { stdio: ['pipe', 'ignore', 'ignore'], detached: true })
    proc = dog
    dog.on('error', err => own.fail(`the watchdog could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`))
    dog.on('exit', () => {
      if (!closed) own.fail('the watchdog ended')
    })
    dog.stdin?.on('error', () => {})
    dog.unref()
    ;(dog.stdin as unknown as { unref?: () => void } | null)?.unref?.()
    own.on('/bin/sh watchdog')
  }
  const write = (line: string | undefined): void => {
    if (line === undefined || proc?.stdin === null || proc?.stdin === undefined || proc.stdin.destroyed) return
    try {
      proc.stdin.write(line)
    } catch {}
  }
  return {
    add: pid => {
      if (closed || pid === undefined) return
      start()
      write(plusLine(pid))
    },
    remove: pid => {
      if (pid !== undefined) write(minusLine(pid))
    },
    start,
    settled: () => own.settled(),
    close: () => {
      if (closed) return
      closed = true
      try {
        proc?.stdin?.end()
      } catch {}
    },
    state: own.get,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Windows

/** The program for this source: compiled now if the folder has no file for its hash. Throws an Error with the reason. */
const ensureProgram = async (
  options: GuardOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> => {
  const sourceFile = options.source ?? GUARD_SOURCE
  let source: Buffer
  try {
    source = fs.readFileSync(sourceFile)
  } catch {
    throw new Error('the source of the guard program is missing')
  }
  const dir = childGuardFolder(options.home)
  const exe = path.join(dir, guardExeName(createHash('sha256').update(source).digest('hex')))
  // A link or a folder where the program goes is never run.
  const found = plainFile(exe)
  if (found === true) return exe
  if (found === false) throw new Error('the guard program is not a plain file')
  const root = env.SystemRoot ?? env.SYSTEMROOT
  const csc =
    options.csc ??
    (root !== undefined && path.win32.isAbsolute(root)
      ? path.win32.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
      : undefined)
  if (csc === undefined || !isFile(csc)) throw new Error('the csc.exe of .NET Framework 4 was not found')
  privateFolder(dir)
  const temp = path.join(dir, `tmp-${process.pid}-${randomBytes(4).toString('hex')}.exe`)
  const text = await new Promise<string | undefined>(resolve => {
    let out = ''
    const compiler = spawn(csc, ['/nologo', '/optimize+', '/target:winexe', `/out:${temp}`, sourceFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: COMPILE_MS,
    })
    compiler.stdout?.on('data', d => (out += d))
    compiler.stderr?.on('data', d => (out += d))
    compiler.on('error', err =>
      resolve(`the compile could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`),
    )
    compiler.on('close', code =>
      resolve(code === 0 ? undefined : `the compile failed: ${out.replace(/\s+/g, ' ').slice(0, 200)}`),
    )
  })
  if (text !== undefined) {
    fs.rmSync(temp, { force: true })
    throw new Error(text)
  }
  try {
    fs.renameSync(temp, exe)
  } catch {
    // Another process made the same file first, and it may be running: use it.
    fs.rmSync(temp, { force: true })
    if (plainFile(exe) !== true) throw new Error('the compiled program could not be put in place')
  }
  return exe
}

const windowsGuard = (options: GuardOptions, env: Readonly<Record<string, string | undefined>>): Guard => {
  const own = stateOf(options.log, windowsFailure)
  const waiting = new Set<number>()
  let proc: ChildProcess | undefined
  let began = false
  let closed = false
  let timer: NodeJS.Timeout | undefined

  const send = (pid: number): void => {
    const line = guardLine(pid)
    if (line === undefined || proc?.stdin === null || proc?.stdin === undefined || proc.stdin.destroyed) return
    try {
      proc.stdin.write(line)
    } catch {}
  }
  const begin = async (): Promise<void> => {
    let exe: string
    try {
      exe = await ensureProgram(options, env)
    } catch (err) {
      return own.fail((err as Error).message)
    }
    if (closed) return
    const guard = spawn(exe, [String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    proc = guard
    timer = setTimeout(() => {
      own.fail('the guard program did not say ready in time')
      guard.kill()
    }, options.readyMs ?? READY_MS)
    guard.on('error', err => {
      clearTimeout(timer)
      own.fail(`the guard program could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
    })
    guard.on('exit', code => {
      clearTimeout(timer)
      if (!closed) own.fail(`the guard program ended with exit code ${String(code)}`)
    })
    guard.stdin?.on('error', () => {})
    guard.stdout?.setEncoding('utf8')
    let text = ''
    guard.stdout?.on('data', (chunk: string) => {
      text += chunk
      if (!/^ready$/m.test(text)) return
      clearTimeout(timer)
      guard.stdout?.removeAllListeners('data')
      guard.stdout?.resume()
      own.on('Job Object, child-guard.exe')
      for (const pid of waiting) send(pid)
      waiting.clear()
    })
    guard.unref()
    ;(guard.stdin as unknown as { unref?: () => void } | null)?.unref?.()
    ;(guard.stdout as unknown as { unref?: () => void } | null)?.unref?.()
  }
  const start = (): void => {
    if (began || closed) return
    began = true
    void begin()
  }
  return {
    add: pid => {
      if (closed || pid === undefined || own.get().state === 'failed') return
      start()
      if (own.get().state === 'on') send(pid)
      else waiting.add(pid)
    },
    // A job drops a process that ended by itself: nothing to remove.
    remove: pid => {
      if (pid !== undefined) waiting.delete(pid)
    },
    start,
    settled: () => own.settled(),
    close: () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      try {
        proc?.stdin?.end()
      } catch {}
    },
    state: own.get,
  }
}
