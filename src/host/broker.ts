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
  entryText,
  LINE_MAX,
  lineSplitter,
  parseEntry,
  parseFrame,
  PROOF_BYTES,
  PROOF_CONNECTIONS,
  PROOF_MS,
  refusedFrame,
  STOP_WAIT_MS,
  type Entry,
} from '../core/broker.ts'
import { createRouter, type Effect, type Router } from '../core/mux.ts'
import { brokerFolder } from '../core/paths.ts'
import { buildId, endpointFor, loadKey, makeCrypto, privateFolder } from './brokerwire.ts'

export type BrokerOptions = {
  readonly home: string
  /** The time that a child with no link lives, and the base of the wait of an empty broker. */
  readonly idleMs: number
  /** The `broker.js` whose hash is the build id. */
  readonly file: string
  /** The time that a child has to answer the initialize of the broker: a test sets it. */
  readonly initMs?: number
}

export type Broker = {
  readonly endpoint: string
  /** Settles when the broker has stopped its children and closed its endpoint. */
  readonly done: Promise<void>
  readonly stop: () => Promise<void>
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

/** `close` ends the link, with the reason in a last frame when there is one. */
type Conn = { readonly send: (msg: unknown) => void; readonly close: (reason?: string) => void }

type Child = {
  readonly id: string
  readonly proc: ChildProcess
  readonly router: Router
  readonly conns: Map<string, Conn>
  /** Undefined when the child answered the broker's initialize, else the reason that it did not. */
  readonly ready: Promise<string | undefined>
  readonly settle: (reason: string | undefined) => void
  idle: NodeJS.Timeout | undefined
  dead: boolean
  stopping: Promise<void> | undefined
}

/**
 * Ends the tree of a child: `taskkill /T /F` on Windows, the process group elsewhere. Windows needs a live top process.
 * Elsewhere the group is also ended after the top process exited, so a wrapper that leaves on EOF takes no grandchild
 * that ignores EOF with it. Call it at the exit, when the group id cannot have been reused.
 */
const endTree = (proc: ChildProcess): void => {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    nodeSpawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
      'error',
      () => {},
    )
    return
  }
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    proc.kill('SIGKILL')
  }
}

/** Starts a broker, or returns undefined when another broker of this build already listens. */
export const startBroker = async ({
  home,
  idleMs,
  file,
  initMs = CHILD_INIT_MS,
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
      if (effect.to === 'child') write(child.proc.stdin, effect.msg)
      else child.conns.get(effect.link)?.send(effect.msg)
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
      ready,
      settle,
      idle: undefined,
      dead: false,
      stopping: undefined,
    }
    children.set(id, child)
    log(`child ${tag(id)} start`)
    proc.stdin?.on('error', () => {})
    proc.stderr?.on('data', () => {})
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
    proc.on('exit', code => gone(`the server process ended with exit code ${String(code)}`, code))
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
    const leave = () => {
      if (!proven) pending--
      proven = true
    }
    const timer = setTimeout(() => socket.destroy(), PROOF_MS)
    const close = (reason?: string): void =>
      void (reason === undefined ? socket.end() : socket.end(refusedFrame(reason)))
    const attach = async (entry: Entry): Promise<void> => {
      // The full hash keys the child. The log shows only its first 8 digits.
      const id = crypto.createHash('sha256').update(entryText(entry)).digest('hex')
      child = children.get(id) ?? startChild(entry, id)
      const mine = child
      clearTimeout(mine.idle)
      const reason = await mine.ready
      if (socket.destroyed) return void (mine.conns.size === 0 && idleStart(mine))
      if (reason !== undefined || mine.dead) {
        socket.end(refusedFrame(reason ?? 'the server process ended'))
        return
      }
      const name = `l${++seq}`
      link = name
      mine.conns.set(name, { send: msg => write(socket, msg), close })
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
          stage = 'attaching'
          void attach(entry)
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
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    // A socket file that nobody answers is stale: remove it and listen again. Anything else means a broker is there.
    const alive = await new Promise<boolean>(resolve => {
      const probe = net.connect(endpoint)
      probe.once('connect', () => (probe.destroy(), resolve(true)))
      probe.once('error', e => resolve((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED'))
    })
    if (alive || process.platform === 'win32') return undefined
    fs.rmSync(endpoint, { force: true })
    try {
      await listen()
    } catch {
      return undefined
    }
  }
  log(`start pid ${process.pid}`)
  log('listen')

  const stop = (): Promise<void> =>
    (exiting ??= (async () => {
      clearTimeout(emptyTimer)
      server.close()
      await Promise.all([...children.values()].map(stopChild))
      for (const socket of sockets) socket.destroy()
      log('exit')
      finish()
    })())
  checkEmpty()
  return { endpoint, done, stop }
}
