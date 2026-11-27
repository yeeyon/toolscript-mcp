// The broker of the shared downstream servers (issue #63): one process per user and build, which holds one child of each
// share key and one router (`src/core/mux.ts`) for it. It decides no policy, keeps no tool result and writes nothing with
// a value to disk. The listen on the endpoint is the lock. A host proves the key before it sends its entry (the
// handshake of `src/core/broker.ts`). This file and `brokerwire.ts` are all of it, with `cross-spawn` and Node.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crossSpawn from 'cross-spawn'
import {
  attachedFrame,
  brokerSide,
  CHILD_INIT_MS,
  CHILDREN_MAX,
  droppedFrame,
  entryText,
  LINE_MAX,
  LINKS_MAX,
  lineSplitter,
  parseEntry,
  parseFrame,
  PROOF_BYTES,
  PROOF_CONNECTIONS,
  PROOF_MS,
  refusedFrame,
  STDERR_BACKLOG,
  STDERR_RATE,
  STDERR_TAIL,
  STDERR_WINDOW_MS,
  STOP_WAIT_MS,
  UNSENT_MAX,
  type Entry,
} from '../core/broker.ts'
import { createRouter, type Effect, type Router } from '../core/mux.ts'
import { brokerFolder } from '../core/paths.ts'
import { buildId, endpointFor, loadKey, makeCrypto, privateFolder, stderrFrames } from './brokerwire.ts'

export type BrokerOptions = {
  readonly home: string
  /** The time that a child with no link lives, and the base of the wait of an empty broker. */
  readonly idleMs: number
  /** The `broker.js` whose hash is the build id. */
  readonly file: string
  /** The time that a child has to answer the initialize of the broker: a test sets it. */
  readonly initMs?: number
  /** The caps of `src/core/broker.ts`, which a test makes small. */
  readonly maxLinks?: number
  readonly maxChildren?: number
  readonly maxUnsent?: number
  /** How long a socket file must refuse a connect before a starting broker removes it: a test sets it. */
  readonly guardMs?: number
  /** A test hook, called once this broker listens, before it checks that its socket file is still at the path. */
  readonly afterListen?: () => void
}

export type Broker = {
  readonly endpoint: string
  /** Settles when the broker has stopped its children and closed its endpoint. */
  readonly done: Promise<void>
  readonly stop: () => Promise<void>
  /** Writes a lifecycle line to broker.log. */
  readonly log: (line: string) => void
}

const LOG_MAX = 1 << 20
const ENTRY_BYTES = 1 << 20
/** What a host may send while its attach waits for the child. */
const QUEUE_MAX = 4 * LINE_MAX
/** The first 8 hex digits of a child key, which is all that the log shows. */
const tag = (id: string): string => id.slice(0, 8)
const PROBE = 'probe'
/**
 * An initialize that the broker sends itself, so each attach waits for a child that answers it. It is the latest version
 * of the SDK that the hosts use, so a shared server negotiates what a direct one does. This bundle holds no SDK:
 * tests/broker.test.ts compares the two.
 */
export const PROBE_VERSION = '2025-11-25'

/** The lines of broker.log: lifecycle only, never an argument, a variable, a path or a key. It never throws. */
const makeLog = (file: string): ((line: string) => void) => {
  let size = 0
  try {
    size = fs.statSync(file).size
    if (size > LOG_MAX) fs.writeFileSync(file, '')
    if (size > LOG_MAX) size = 0
  } catch {}
  return line => {
    const text = `${new Date().toISOString()} ${line}\n`
    try {
      if (size + text.length > LOG_MAX) {
        fs.writeFileSync(file, '')
        size = 0
      }
      fs.appendFileSync(file, text)
      size += text.length
    } catch {}
  }
}

/**
 * `close` ends the link, with the reason in a last frame when there is one. `stderr` gets the stderr text of the child
 * (a Buffer), or the count of bytes that the broker dropped.
 */
type Conn = {
  readonly send: (msg: unknown) => void
  readonly close: (reason?: string) => void
  readonly stderr?: (data: Buffer | number) => void
}

type Child = {
  readonly id: string
  readonly proc: ChildProcess
  readonly router: Router
  readonly conns: Map<string, Conn>
  /** Undefined when the child answered the broker's initialize, else the reason that it did not. */
  readonly ready: Promise<string | undefined>
  readonly settle: (reason: string | undefined) => void
  /** The connections that wait in an attach for this child: they get its stderr text as it comes. */
  readonly waiters: Set<Conn>
  idle: NodeJS.Timeout | undefined
  dead: boolean
  /** True once the child answered the initialize of the broker. */
  up: boolean
  /** The last STDERR_TAIL bytes of a child that is not up. Memory only, and gone when the child is up. */
  tail: Buffer
  stopping: Promise<void> | undefined
  /** Ends the child as dead, with the reason for its links. */
  abort: (why: string, code: unknown) => void
}

/**
 * Ends the tree of a child: `taskkill /T /F` on Windows, the process group elsewhere. Windows needs a live top process.
 * Elsewhere the group is also ended after the top process exited, so a wrapper that leaves on EOF takes no grandchild
 * that ignores EOF with it. Call it at the exit, when the group id cannot have been reused. The promise settles when
 * the kill was sent (on Windows, when `taskkill` ended), so a caller that must know that the tree is gone can wait.
 */
export const endTree = (proc: ChildProcess): Promise<void> => {
  if (proc.pid === undefined) return Promise.resolve()
  if (process.platform === 'win32') {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
    return new Promise(resolve => {
      const killer = nodeSpawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => resolve())
      killer.on('close', () => resolve())
    })
  }
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    proc.kill('SIGKILL')
  }
  return Promise.resolve()
}

/** How long a contender waits for the recovery of a stale socket before it gives up. The host polls for 10 s. */
const RECOVER_MS = 8000
/** A lock file older than this is stale whatever its pid says. Recovery takes milliseconds. */
const LOCK_STALE_MS = 5000
/**
 * A socket file that refuses a connect is a dead broker's only when the same file (same device and inode) has refused for
 * this long. A broker that has bound its file and not yet called listen refuses too, and that gap lasts microseconds, but
 * a busy single CPU can stretch it to some tens of milliseconds. The sum for a host that starts after a killed broker: this
 * guard plus a dial and a listen, about 1.1 s, well under `RECOVER_MS` (8 s), `LOCK_STALE_MS` (5 s, the recovery lock is
 * held for the guard) and the 10 s that a host polls for a broker.
 */
const SOCKET_GUARD_MS = 1000

/** dev and inode of a file as one text, or undefined when there is none. */
const fileId = (file: string): string | undefined => {
  try {
    const info = fs.statSync(file, { bigint: true })
    return `${info.dev}:${info.ino}`
  } catch {
    return undefined
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes the recovery lock beside the socket: a file made with `wx` that holds a pid, a random id and the time (no
 * secret). Returns its id, or undefined when another contender holds it. A stale lock is broken first, and the next try
 * is the caller's. Stale: its pid is dead, or its time is more than the bound from now in either direction (a future
 * time never ages otherwise), or it is unreadable and its mtime is. A lock is never removed on the strength of an
 * earlier read: the breaker renames it to a name of its own, reads what it moved, and puts it back when that is not
 * what it judged (the holder made a fresh lock after the read). `afterRead` is a hook for the test of that gap.
 */
export const takeLock = (file: string, afterRead: () => void = () => {}): string | undefined => {
  const id = crypto.randomBytes(8).toString('hex')
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, id, at: Date.now() }), { flag: 'wx', mode: 0o600 })
    return id
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  let seen: string
  let stale: boolean
  try {
    seen = fs.readFileSync(file, 'utf8')
    try {
      const held = JSON.parse(seen) as { pid?: unknown; at?: unknown }
      const dead = typeof held.pid !== 'number' || !pidAlive(held.pid)
      const old = typeof held.at !== 'number' || Math.abs(Date.now() - held.at) > LOCK_STALE_MS
      stale = dead || old
    } catch {
      // Unreadable or half written: a holder may be writing it right now. A file that stays so is old by its mtime.
      stale = Math.abs(Date.now() - fs.statSync(file).mtimeMs) > LOCK_STALE_MS
    }
  } catch {
    return undefined
  }
  if (!stale) return undefined
  afterRead()
  const aside = `${file}.break.${process.pid}.${id}`
  try {
    fs.renameSync(file, aside)
  } catch {
    return undefined
  }
  try {
    if (fs.readFileSync(aside, 'utf8') !== seen) fs.linkSync(aside, file)
  } catch {}
  fs.rmSync(aside, { force: true })
  return undefined
}

const dropLock = (file: string, id: string): void => {
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown }).id === id) fs.rmSync(file, { force: true })
  } catch {}
}

/** One dial of the endpoint: a broker answers, nobody does behind a stale file, or the file is gone. */
const dial = (endpoint: string): Promise<'alive' | 'stale' | 'gone'> =>
  new Promise(resolve => {
    const probe = net.connect(endpoint)
    probe.once('connect', () => (probe.destroy(), resolve('alive')))
    probe.once('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      resolve(code === 'ECONNREFUSED' ? 'stale' : code === 'ENOENT' ? 'gone' : 'alive')
    })
  })

/**
 * The listen found a socket file at the path. One contender at a time probes it, removes it if nobody answers and
 * listens, under a lock file. The others wait and dial again, so a socket that the first one bound is never removed.
 * A file that refuses a connect is removed only after the same file has refused for `guardMs` (see `SOCKET_GUARD_MS`):
 * the broker that made it may be between its bind and its listen. Returns true when this broker now listens.
 */
const recoverSocket = async (endpoint: string, listen: () => Promise<void>, guardMs: number): Promise<boolean> => {
  const lockFile = `${endpoint}.lock`
  const end = Date.now() + RECOVER_MS
  const nap = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  while (Date.now() < end) {
    const lock = takeLock(lockFile)
    if (lock === undefined) {
      await nap(20 + Math.random() * 30)
      if ((await dial(endpoint)) === 'alive') return false
      continue
    }
    try {
      // The file that refused first, and when. Another file at the path starts the count again.
      let refused: { readonly id: string; readonly at: number } | undefined
      for (;;) {
        const state = await dial(endpoint)
        if (state === 'alive') return false
        if (state === 'stale') {
          const id = fileId(endpoint)
          if (id !== undefined) {
            if (refused?.id !== id) refused = { id, at: Date.now() }
            if (Date.now() - refused.at < guardMs) {
              if (Date.now() >= end) return false
              await nap(Math.min(25, guardMs))
              continue
            }
            // The id was read in this tick: nothing runs between it and the remove.
            fs.rmSync(endpoint, { force: true })
          }
        }
        try {
          await listen()
          return true
        } catch {
          return false
        }
      }
    } finally {
      dropLock(lockFile, lock)
    }
  }
  return false
}

/**
 * A broker that was killed inside the link-aside of its close (see `closeServer`) leaves another broker's socket under
 * the name `<endpoint>.keep.<pid>` and nothing at the endpoint. The next start links that socket back when it answers,
 * and removes any other leftover of a dead pid. Returns true when it put a live broker back: that one serves.
 */
const adoptKept = async (endpoint: string): Promise<boolean> => {
  const dir = path.dirname(endpoint)
  const prefix = `${path.basename(endpoint)}.keep.`
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter(name => name.startsWith(prefix))
  } catch {
    return false
  }
  let adopted = false
  for (const name of names) {
    const pid = Number(name.slice(prefix.length))
    if (Number.isInteger(pid) && pidAlive(pid)) continue
    const keep = `${dir}/${name}`
    if (!adopted && !fs.existsSync(endpoint) && (await dial(keep)) === 'alive') {
      try {
        fs.linkSync(keep, endpoint)
        adopted = true
      } catch {}
    }
    fs.rmSync(keep, { force: true })
  }
  return adopted
}

/** A socket file younger than this may belong to a broker that is between its bind and its listen. */
const SWEEP_MIN_AGE_MS = 5000

/**
 * Removes each `tsm-*.sock` file of the folder that refuses a connect: what a broker of another build left when it was
 * killed. A file that answers is never touched, nor is one made in the last seconds, nor this broker's own.
 */
const sweepSockets = async (endpoint: string): Promise<void> => {
  const dir = path.dirname(endpoint)
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter(name => /^tsm-[0-9a-f]+\.sock$/.test(name))
  } catch {
    return
  }
  for (const name of names) {
    const file = `${dir}/${name}`
    if (file === endpoint) continue
    try {
      if (Date.now() - fs.lstatSync(file).mtimeMs < SWEEP_MIN_AGE_MS) continue
    } catch {
      continue
    }
    if ((await dial(file)) === 'stale') fs.rmSync(file, { force: true })
  }
}

/** Starts a broker, or returns undefined when another broker of this build already listens. */
export const startBroker = async ({
  home,
  idleMs,
  file,
  initMs = CHILD_INIT_MS,
  maxLinks = LINKS_MAX,
  maxChildren = CHILDREN_MAX,
  maxUnsent = UNSENT_MAX,
  guardMs = SOCKET_GUARD_MS,
  afterListen,
}: BrokerOptions): Promise<Broker | undefined> => {
  const dir = brokerFolder(home)
  privateFolder(dir)
  const log = makeLog(`${dir}/broker.log`)
  const key = loadKey(home)
  const wire = makeCrypto(key)
  const endpoint = endpointFor(home, key, buildId(file))
  if (process.platform !== 'win32') privateFolder(path.dirname(endpoint))
  const children = new Map<string, Child>()
  const sockets = new Set<net.Socket>()
  let seq = 0
  // The connections that have not yet proved the key.
  let pending = 0
  // The connections that sent an entry: attaching or linked.
  let attached = 0
  let exiting: Promise<void> | undefined
  let emptyTimer: NodeJS.Timeout | undefined
  let finish = () => {}
  const done = new Promise<void>(resolve => (finish = resolve))

  const write = (stream: { write: (text: string) => unknown; destroyed?: boolean } | null, msg: unknown): void => {
    try {
      if (stream !== null && stream.destroyed !== true) stream.write(`${JSON.stringify(msg)}\n`)
    } catch {}
  }

  const apply = (child: Child, effects: readonly Effect[]): void => {
    for (const effect of effects) {
      if (effect.to === 'child') {
        write(child.proc.stdin, effect.msg)
        // A child that does not read its input holds what the hosts send in this process: it is treated as dead.
        if ((child.proc.stdin?.writableLength ?? 0) > maxUnsent)
          child.abort('the server did not read its input', 'input over the cap')
      } else child.conns.get(effect.link)?.send(effect.msg)
    }
  }

  const stopChild = (child: Child): Promise<void> => {
    if (child.stopping !== undefined) return child.stopping
    log(`child ${tag(child.id)} stop`)
    children.delete(child.id)
    clearTimeout(child.idle)
    child.stopping = new Promise<void>(resolve => {
      if (child.dead) return resolve()
      child.proc.once('exit', () => resolve())
      const timer = setTimeout(() => {
        endTree(child.proc)
        setTimeout(resolve, 1000)
      }, STOP_WAIT_MS)
      child.proc.once('exit', () => clearTimeout(timer))
      try {
        child.proc.stdin?.end()
      } catch {}
    })
    return child.stopping
  }

  /** The broker leaves when no socket and no child is left, after a short wait for a host that is about to attach. */
  const checkEmpty = (): void => {
    clearTimeout(emptyTimer)
    if (sockets.size > 0 || children.size > 0 || exiting !== undefined) return
    emptyTimer = setTimeout(() => void stop(), Math.min(idleMs, 2000))
  }

  const startChild = (entry: Entry, id: string): Child => {
    const router = createRouter()
    let settle = (_reason: string | undefined) => {}
    const ready = new Promise<string | undefined>(resolve => (settle = resolve))
    const proc = crossSpawn(entry.command, [...entry.args], {
      cwd: entry.folder,
      env: { ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // The process group is how the tree of a child ends outside Windows. Windows ends it with taskkill.
      detached: process.platform !== 'win32',
    })
    const child: Child = {
      id,
      proc,
      router,
      conns: new Map(),
      waiters: new Set(),
      ready,
      settle,
      idle: undefined,
      dead: false,
      up: false,
      tail: Buffer.alloc(0),
      stopping: undefined,
      abort: (why, code) => {
        endTree(proc)
        gone(why, code)
      },
    }
    children.set(id, child)
    log(`child ${tag(id)} start`)
    // A pipe error with no listener would end the broker. The exit of the child follows and does the cleanup.
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream?.on('error', () => {})
    // Stderr is always drained. Each chunk goes to the links and the waiting attaches as frames, up to STDERR_RATE bytes
    // in each window: the rest is dropped and counted in one frame at the end of the window. Nothing of it is logged.
    let windowStart = Date.now()
    let windowBytes = 0
    let missed = 0
    let flush: NodeJS.Timeout | undefined
    const fanOut = (data: Buffer | number): void => {
      for (const conn of child.conns.values()) conn.stderr?.(data)
      for (const conn of child.waiters) conn.stderr?.(data)
    }
    proc.stderr?.on('data', (data: Buffer) => {
      if (Date.now() - windowStart >= STDERR_WINDOW_MS) {
        windowStart = Date.now()
        windowBytes = 0
      }
      const kept = data.subarray(0, Math.max(0, STDERR_RATE - windowBytes))
      windowBytes += kept.length
      if (kept.length > 0) {
        if (!child.up) child.tail = Buffer.concat([child.tail, kept]).subarray(-STDERR_TAIL)
        fanOut(kept)
      }
      if (kept.length < data.length) {
        missed += data.length - kept.length
        flush ??= setTimeout(
          () => {
            flush = undefined
            fanOut(missed)
            missed = 0
          },
          Math.max(0, windowStart + STDERR_WINDOW_MS - Date.now()),
        )
        flush.unref()
      }
    })
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on(
      'data',
      lineSplitter(
        line => {
          const msg = parseFrame(line)
          if (msg !== undefined) apply(child, router.fromChild(msg))
        },
        () => LINE_MAX,
        // A line over the cap that the SDK reader would refuse: the child is dead, and its links get the reason.
        () => {
          endTree(proc)
          gone('the server wrote a line longer than 10 MB', 'line over the cap')
        },
      ),
    )
    const gone = (why: string, code: unknown): void => {
      if (child.dead) return
      child.dead = true
      clearTimeout(timer)
      clearTimeout(flush)
      if (children.get(id) === child) children.delete(id)
      log(`child ${tag(id)} exit ${String(code)}`)
      const reason = `${why}. Run the command of the server by hand in a terminal to see why`
      settle(reason)
      apply(child, router.died())
      for (const conn of child.conns.values()) conn.close(reason)
      child.conns.clear()
      // A wrapper that left on EOF must not leave a grandchild that ignores it.
      endTree(proc)
      checkEmpty()
    }
    proc.on('error', err => gone('the server process could not start', (err as NodeJS.ErrnoException).code))
    proc.on('exit', code => {
      const end = (): void => gone(`the server process ended with exit code ${String(code)}`, code)
      // A child that fails to start: its last stderr text is still in the pipe, and the waiting hosts get it first.
      if (child.up || proc.stderr === null || proc.stderr.destroyed) return end()
      const timer = setTimeout(end, 200)
      proc.stderr.once('close', () => {
        clearTimeout(timer)
        end()
      })
    })
    const timer = setTimeout(() => {
      settle(`the server gave no initialize answer in ${Math.round(initMs / 1000)} s. Run its command by hand`)
      void stopChild(child)
    }, initMs)
    child.conns.set(PROBE, {
      close: () => {},
      send: msg => {
        // Only the answer to the initialize counts: a notification that comes first must not clear the guard.
        if (typeof msg !== 'object' || msg === null || (msg as { id?: unknown }).id !== 0) return
        if (!('result' in msg) && !('error' in msg)) return
        const failed = 'error' in msg
        child.conns.delete(PROBE)
        clearTimeout(timer)
        if (failed) {
          settle('the server answered the initialize with an error. Run its command by hand')
          void stopChild(child)
          return
        }
        apply(child, router.fromLink(PROBE, { jsonrpc: '2.0', method: 'notifications/initialized' }))
        apply(child, router.detach(PROBE))
        // Up: what the child wrote before is no one else's business. A link that attaches now gets no earlier text.
        child.up = true
        child.tail = Buffer.alloc(0)
        settle(undefined)
      },
    })
    router.attach(PROBE)
    apply(
      child,
      router.fromLink(PROBE, {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: PROBE_VERSION,
          capabilities: {},
          clientInfo: { name: 'toolscript-mcp-broker', version: '1' },
        },
      }),
    )
    return child
  }

  const onConnection = (socket: net.Socket): void => {
    if (pending >= PROOF_CONNECTIONS) return void socket.destroy()
    sockets.add(socket)
    clearTimeout(emptyTimer)
    socket.setEncoding('utf8')
    pending++
    let proven = false
    let link: string | undefined
    let child: Child | undefined
    const side = brokerSide(wire)
    const queue: string[] = []
    let stage: 'proof' | 'entry' | 'attaching' | 'linked' = 'proof'
    let queued = 0
    let counted = false
    const leave = () => {
      if (!proven) pending--
      proven = true
    }
    const timer = setTimeout(() => socket.destroy(), PROOF_MS)
    const close = (reason?: string): void =>
      void (reason === undefined ? socket.end() : socket.end(refusedFrame(reason)))
    // The stderr text of the child goes to this host as frames. A host that reads slowly (more than STDERR_BACKLOG
    // unsent) gets none and, once it reads again, one frame with the count that it missed.
    let skipped = 0
    const stderr = (data: Buffer | number): void => {
      if (socket.destroyed) return
      if (typeof data === 'number') skipped += data
      else if (socket.writableLength > STDERR_BACKLOG) return void (skipped += data.length)
      if (socket.writableLength > STDERR_BACKLOG) return
      if (skipped > 0) {
        socket.write(droppedFrame(skipped))
        skipped = 0
      }
      if (typeof data !== 'number') for (const frame of stderrFrames(data)) socket.write(frame)
    }
    const attach = async (entry: Entry): Promise<void> => {
      // The full hash keys the child. The log shows only its first 8 digits.
      const id = crypto.createHash('sha256').update(entryText(entry)).digest('hex')
      try {
        const known = children.get(id)
        if (known === undefined && children.size >= maxChildren)
          return void socket.end(
            refusedFrame(
              `this broker already holds ${maxChildren} shared servers. Set "share": false on this server, or end sessions that use others`,
            ),
          )
        child = known ?? startChild(entry, id)
      } catch (err) {
        // spawn throws at once for a bad entry (a NUL byte, EINVAL, E2BIG, ENAMETOOLONG, EPERM): only this link fails.
        const code = (err as NodeJS.ErrnoException).code
        const shown = typeof code === 'string' && /^\w{1,40}$/.test(code) ? code : 'error'
        log(`child ${tag(id)} exit ${shown}`)
        socket.end(refusedFrame(`the server process could not start (${shown}). Run its command by hand in a terminal`))
        return
      }
      const mine = child
      clearTimeout(mine.idle)
      // A child that is still starting: this host gets what it wrote so far and what follows, as the host of a direct
      // child would. A child that is up has no earlier text for it.
      const waiting = !mine.up && !mine.dead
      const waiter: Conn = { send: () => {}, close: () => {}, stderr }
      if (waiting) {
        mine.waiters.add(waiter)
        if (mine.tail.length > 0) stderr(mine.tail)
      }
      const reason = await mine.ready
      mine.waiters.delete(waiter)
      if (socket.destroyed) return void (mine.conns.size === 0 && idleStart(mine))
      if (reason !== undefined || mine.dead) {
        // A host that did not wait for the child gets the tail of the one that failed (at most STDERR_TAIL bytes).
        if (!waiting && mine.tail.length > 0) stderr(mine.tail)
        socket.end(refusedFrame(reason ?? 'the server process ended'))
        return
      }
      const name = `l${++seq}`
      link = name
      mine.conns.set(name, {
        // The host reads at most LINE_MAX in a line. A child line under that cap can come out longer once written again
        // (1e9 becomes 1000000000), and then the link ends with the reason instead of a line the host cuts off.
        send: msg => {
          const line = JSON.stringify(msg)
          if (line.length > LINE_MAX) close('the server sent a message longer than 10 MB')
          else if (socket.destroyed) return
          // A host that does not read: this link ends, and the other links of the child go on.
          else if (socket.writableLength > maxUnsent) socket.destroy()
          else socket.write(`${line}\n`)
        },
        close,
        stderr,
      })
      mine.router.attach(name)
      log(`attach ${tag(id)} links=${mine.conns.size}`)
      socket.write(attachedFrame)
      stage = 'linked'
      for (const line of queue.splice(0)) fromHost(mine, name, line)
    }
    const fromHost = (target: Child, name: string, line: string): void => {
      const msg = parseFrame(line)
      if (msg !== undefined) apply(target, target.router.fromLink(name, msg))
    }
    // The longest line depends on the stage: 4 KB before the proof, 1 MB for the entry, then the cap of the SDK reader.
    const lines = lineSplitter(
      line => {
        if (stage === 'proof') {
          const step = side.step(line)
          if (step.fail !== undefined) return void socket.destroy()
          if (step.send !== undefined) socket.write(step.send)
          if (step.done) {
            leave()
            stage = 'entry'
          }
        } else if (stage === 'entry') {
          const entry = parseEntry(parseFrame(line))
          clearTimeout(timer)
          if (typeof entry === 'string') return void socket.end(refusedFrame(entry))
          if (attached >= maxLinks)
            return void socket.end(
              refusedFrame(
                `this broker already holds ${maxLinks} shared links. Set "share": false on this server, or end other sessions`,
              ),
            )
          attached++
          counted = true
          stage = 'attaching'
          attach(entry).catch(() => socket.destroy())
        } else if (stage === 'attaching') {
          queued += line.length
          if (queued > QUEUE_MAX) return void socket.destroy()
          queue.push(line)
        } else if (child !== undefined && link !== undefined) fromHost(child, link, line)
      },
      () => (stage === 'proof' ? PROOF_BYTES : stage === 'entry' ? ENTRY_BYTES : LINE_MAX),
      () => socket.destroy(),
    )
    socket.on('data', lines)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(timer)
      leave()
      if (counted) attached--
      sockets.delete(socket)
      if (child !== undefined && link !== undefined) {
        apply(child, child.router.detach(link))
        child.conns.delete(link)
        log(`detach ${tag(child.id)} links=${child.conns.size}`)
        if (child.conns.size === 0) idleStart(child)
      }
      checkEmpty()
    })
  }
  const idleStart = (child: Child): void => {
    clearTimeout(child.idle)
    if (child.dead || child.stopping !== undefined) return
    child.idle = setTimeout(() => void stopChild(child).then(checkEmpty), idleMs)
  }

  const server = net.createServer(onConnection)
  // The file that this server bound, read in the same tick as the bind (see `listen`).
  let bound: string | undefined
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
      // The bind and the listen of a path run inside the call, and an EADDRINUSE comes on the next tick. So a success
      // leaves this server's own file at the path now, and a later swap of that file by another broker is seen against it.
      bound = process.platform === 'win32' ? undefined : fileId(endpoint)
    })
  try {
    if (process.platform !== 'win32' && (await adoptKept(endpoint))) return undefined
    await listen()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    // Windows pipes vanish with their process, so a taken name means a broker is there.
    if (process.platform === 'win32' || !(await recoverSocket(endpoint, listen, guardMs))) return undefined
  }
  // The inode of the socket file this broker bound: at the close, a file at the path that is not this one is another
  // broker's, and stays.
  const mine = bound
  const closeServer = (): void => {
    const now = mine === undefined ? undefined : fileId(endpoint)
    if (now === undefined || now === mine) return void server.close()
    // The close of a pipe server unlinks the path whoever bound it, so the other broker's file is linked aside and back.
    // What remains: for the two calls between the unlink and the relink (microseconds) the path does not exist, and a
    // host that dials then gets ENOENT (it dials once more before it starts a broker). A kill inside it leaves the
    // `.keep` file, which the next start links back (`adoptKept`).
    const aside = `${endpoint}.keep.${process.pid}`
    let kept = false
    try {
      fs.linkSync(endpoint, aside)
      kept = true
    } catch {}
    server.close()
    if (!kept) return
    try {
      fs.linkSync(aside, endpoint)
    } catch {}
    fs.rmSync(aside, { force: true })
  }
  afterListen?.()
  // A broker that lost its name between the bind and here (another broker removed its file) serves nobody by name: it
  // leaves at once, and the file at the path is the other broker's.
  if (mine !== undefined && fileId(endpoint) !== mine) {
    closeServer()
    for (const socket of sockets) socket.destroy()
    return undefined
  }
  log(`start pid ${process.pid}`)
  log('listen')
  if (process.platform !== 'win32') void sweepSockets(endpoint)
  // An error of the server after the listen (an accept that failed) would end the broker with no listener. It keeps
  // listening, so the line is all.
  server.on('error', err => log(`listen error ${(err as NodeJS.ErrnoException).code ?? 'error'}`))

  const stop = (): Promise<void> =>
    (exiting ??= (async () => {
      clearTimeout(emptyTimer)
      closeServer()
      await Promise.all([...children.values()].map(stopChild))
      for (const socket of sockets) socket.destroy()
      log('exit')
      finish()
    })())
  checkEmpty()
  return { endpoint, done, stop, log }
}
