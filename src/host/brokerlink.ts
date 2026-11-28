// The host side of the shared-server broker (issue #63): the entry of a server as resolved, the attach (find or start the
// broker, prove the key both ways, send the entry) and `BrokerTransport`, an SDK transport over one connection. One
// link is one connection. A broker that cannot be reached or started fails the link with a reason (decision 024): no
// child is started in its place.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deserializeMessage } from './sdk/transport.ts'
import { defaultEnvironment } from '../core/childenv.ts'
import type { JSONRPCMessage, Transport } from './sdk/transport.ts'
import {
  BROKER_START_MS,
  CHILD_INIT_MS,
  entryFrame,
  hostSide,
  LINE_MAX,
  lineSplitter,
  MARK,
  parseAnswer,
  parseBrokerFrame,
  PROOF_BYTES,
  PROOF_MS,
  resolveEnvPath,
  SOCKET_MAX_BYTES,
  unusable,
  type Entry,
} from '../core/broker.ts'
import { childEnv, type Protocol, type StdioServer } from '../core/config.ts'
import type { Keyed, Place } from '../core/share.ts'
import { brokerFolder } from '../core/paths.ts'
import { BAD_KEY, buildId, endpointFor, folderProblem, loadKey, makeCrypto, parseStderr } from './brokerwire.ts'

/** An error whose text toolscript-mcp wrote: it holds no text of a server and no value of the config. */
export class BrokerError extends Error {}

const realPath = (entry: string): string | undefined => {
  try {
    return fs.realpathSync(entry)
  } catch {
    return undefined
  }
}

/**
 * The entry that the host sends: the command and arguments, the whole child environment as the SDK builds it, with
 * each PATH entry resolved (decision 027), and the folder of decision 025.
 */
export const entryOf = (server: StdioServer, class_: Keyed, at: Place, protocol: Protocol = 'legacy'): Entry => ({
  command: server.command,
  args: server.args,
  env: resolveEnvPath(
    { ...defaultEnvironment(process.platform, process.env), ...childEnv(server) },
    path.delimiter,
    realPath,
    process.platform === 'win32',
  ),
  folder: server.cwd ?? (class_.class === 'shared' ? at.home : at.folder),
  // Only `auto` is written, so the frame and the share key of a `legacy` link are the bytes of 1.0.5.
  ...(protocol === 'auto' && { protocol }),
})

/** The `broker.js` that sits beside the running file, or undefined: a run from source has none. */
export const brokerFileBeside = (moduleUrl: string): string | undefined => {
  const file = path.join(path.dirname(fileURLToPath(moduleUrl)), 'broker.js')
  return fs.existsSync(file) ? file : undefined
}

const builds = new Map<string, string>()
/** The build id of a `broker.js`, read one time per process. */
export const idOf = (file: string): string => {
  const known = builds.get(file)
  if (known !== undefined) return known
  const id = buildId(file)
  builds.set(file, id)
  return id
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const dialOnce = (endpoint: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })

/** Nothing starts at login: the broker starts on demand, detached and windowless, and outlives this process. */
const startDetached = (file: string): void => {
  // Not the folder of this session: on Windows a process holds its folder, and a broker outlives the session.
  const broker = spawn(process.execPath, [file], {
    cwd: os.homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  broker.on('error', () => {})
  broker.unref()
}

/** The clock and the one start of an `openLink`: a redial after a peer that closed shares them with the first dial. */
type Dialing = { readonly end: number; started: boolean }

/** Connects to the broker, starts it when none listens, and polls up to BROKER_START_MS from the first dial. */
const dial = async (endpoint: string, file: string, id: string, state: Dialing): Promise<net.Socket> => {
  const { end } = state
  let redialed = false
  for (;;) {
    try {
      return await dialOnce(endpoint)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
      if (!['ENOENT', 'ECONNREFUSED', 'EBUSY', 'EAGAIN'].includes(code))
        throw new BrokerError(unusable(`could not connect to it (${code})`))
      // A broker that closes while another one's socket sits at the path unlinks it for a moment: dial once more.
      if (!state.started && code === 'ENOENT' && !redialed) {
        redialed = true
        await pause(30)
        continue
      }
      if (!state.started) {
        // The broker that would start is the file as it is now, and the endpoint is the file as this process read it.
        // After a rebuild in place they differ and no link could ever meet: say so.
        if (buildId(file) !== id)
          throw new BrokerError(unusable('toolscript-mcp was rebuilt after this session started. Restart the session'))
        startDetached(file)
      }
      state.started = true
      if (performance.now() >= end) throw new BrokerError(unusable(`none listened within ${BROKER_START_MS / 1000} s`))
      await pause(50)
    }
  }
}

/** The lines of a socket, read one at a time with a time limit, until `follow` takes over the rest. */
const reader = (socket: net.Socket) => {
  socket.setEncoding('utf8')
  const queue: string[] = []
  let waiter: ((line: string | undefined) => void) | undefined
  let follower: ((line: string) => void) | undefined
  let closed = false
  // A peer that is not yet proven may send 4 KB in a line, and no more: a squatter must not make this process hold more.
  let limit = PROOF_BYTES
  let tooLong = false
  socket.on(
    'data',
    lineSplitter(
      line => {
        if (follower !== undefined) return follower(line)
        const wake = waiter
        waiter = undefined
        if (wake !== undefined) wake(line)
        else queue.push(line)
      },
      () => limit,
      () => {
        tooLong = true
        socket.destroy()
      },
    ),
  )
  socket.on('close', () => {
    closed = true
    const wake = waiter
    waiter = undefined
    wake?.(undefined)
  })
  socket.on('error', () => {})
  return {
    /** True when the socket has closed (after any lines that came before it). */
    closed: (): boolean => closed,
    /** True when the peer sent a line over the limit, and the socket was ended for it. */
    tooLong: (): boolean => tooLong,
    /** After the proof the cap is the one of the SDK reader. */
    proven: (): void => {
      limit = LINE_MAX
    },
    /** The next line, or undefined when the socket closed or `ms` passed. */
    next: (ms: number): Promise<string | undefined> =>
      new Promise(resolve => {
        const line = queue.shift()
        if (line !== undefined || closed) return resolve(line)
        const timer = setTimeout(() => {
          waiter = undefined
          resolve(undefined)
        }, ms)
        waiter = got => {
          clearTimeout(timer)
          resolve(got)
        }
      }),
    follow: (fn: (line: string) => void): void => {
      follower = fn
      for (const line of queue.splice(0)) fn(line)
    },
  }
}

export type LinkOptions = {
  readonly home: string
  /** The `broker.js` of this build, or undefined for a run from source. */
  readonly brokerFile: string | undefined
  /** Sent after the proof. Without it the link ends after the proof: `doctor` only checks the handshake. */
  readonly entry?: Entry
  /** Gets the stderr text of the shared child, as a direct child's stderr would be got (see `childStderr`). */
  readonly onStderr?: (chunk: Buffer) => void
}

/** The stderr text of a broker frame, for the host's own stderr: the data, or a line that counts what was dropped. */
const stderrChunk = (line: string): Buffer | undefined => {
  const got = parseStderr(line)
  if (got === undefined) return undefined
  return 'data' in got
    ? got.data
    : Buffer.from(`[toolscript-mcp: ${got.dropped} bytes of the server's stderr were dropped]
`)
}

/** A connection that proved the key both ways and, with an entry, was attached to a child. */
export const openLink = async ({
  home,
  brokerFile,
  entry,
  onStderr,
}: LinkOptions): Promise<{ readonly socket: net.Socket; readonly lines: ReturnType<typeof reader> }> => {
  if (brokerFile === undefined)
    throw new BrokerError(unusable('this run has no broker.js beside it (a run from source)'))
  let endpoint: string
  let id: string
  let wire: ReturnType<typeof makeCrypto>
  try {
    const key = loadKey(home)
    wire = makeCrypto(key)
    id = idOf(brokerFile)
    endpoint = endpointFor(home, key, id)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error'
    throw new BrokerError(
      unusable(
        code === BAD_KEY
          ? 'its key file is damaged. Delete the file "key" in the folder .toolscript-mcp/broker of your home folder, then try again'
          : `could not read its key or its build (${code})`,
      ),
    )
  }
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > SOCKET_MAX_BYTES)
    throw new BrokerError(unusable('its socket path is too long'))
  // A broker refuses a socket folder that it cannot trust and exits: say why now, not after the wait for a listen.
  const problem = folderProblem(path.dirname(endpoint))
  if (problem !== undefined) {
    const where =
      path.dirname(endpoint) === brokerFolder(home)
        ? 'its folder .toolscript-mcp/broker in your home folder'
        : 'its short socket folder in /tmp, named tsm- and your user id,'
    throw new BrokerError(unusable(`${where} ${problem}`))
  }
  // A broker that was killed can still take a connection for a moment while its process ends, and then closes it. A peer
  // that closed before it sent one line is such a broker, not a wrong peer: dial again, on the clock of the first dial,
  // which starts a broker once. A silent peer, a wrong proof, a long line or a close after a line stay failures.
  const state: Dialing = { end: performance.now() + BROKER_START_MS, started: false }
  let socket: net.Socket
  let lines: ReturnType<typeof reader>
  for (;;) {
    socket = await dial(endpoint, brokerFile, id, state)
    lines = reader(socket)
    const side = hostSide(wire)
    socket.write(side.start())
    const until = performance.now() + PROOF_MS
    let heard = false
    let step: ReturnType<typeof side.step> | undefined
    while (step?.done !== true) {
      const line = await lines.next(Math.max(0, until - performance.now()))
      if (line === undefined) {
        if (lines.closed() && !lines.tooLong() && !heard && performance.now() < state.end) {
          step = undefined
          break
        }
        socket.destroy()
        throw new BrokerError(
          unusable(
            lines.tooLong()
              ? 'the peer sent more than 4 KB in a line before it proved the key'
              : lines.closed()
                ? 'the peer closed the connection before it answered the handshake'
                : `the peer did not answer the handshake in ${PROOF_MS / 1000} s`,
          ),
        )
      }
      heard = true
      step = side.step(line)
      if (step.fail !== undefined) {
        socket.destroy()
        throw new BrokerError(unusable(step.fail))
      }
      if (step.send !== undefined) socket.write(step.send)
    }
    if (step?.done === true) break
    socket.destroy()
    await pause(50)
  }
  try {
    lines.proven()
    if (entry !== undefined) {
      socket.write(entryFrame(entry))
      // The stderr text of a child that is starting comes before the answer.
      const answerBy = performance.now() + CHILD_INIT_MS + 5_000
      let line = await lines.next(CHILD_INIT_MS + 5_000)
      for (let chunk = line === undefined ? undefined : stderrChunk(line); chunk !== undefined; ) {
        onStderr?.(chunk)
        line = await lines.next(Math.max(0, answerBy - performance.now()))
        chunk = line === undefined ? undefined : stderrChunk(line)
      }
      const answer = line === undefined ? undefined : parseAnswer(line)
      if (answer === undefined) throw new BrokerError(unusable('it did not answer the entry'))
      if (!answer.ok) throw new BrokerError(`the shared server could not start: ${answer.reason}`)
    }
  } catch (err) {
    socket.destroy()
    throw err
  }
  return { socket, lines }
}

/** An SDK transport over one connection to the broker. The attach runs in `start`, so the `Client` waits for it. */
export class BrokerTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly #options: LinkOptions
  #socket: net.Socket | undefined
  #closed = false

  constructor(options: LinkOptions) {
    this.#options = options
  }

  async start(): Promise<void> {
    const { socket, lines } = await openLink(this.#options)
    this.#socket = socket
    if (this.#closed) return void socket.destroy()
    socket.on('close', () => this.#end())
    lines.follow(line => {
      // A marked line is the broker's. No line that a server writes carries the mark (see MARK).
      if (line.startsWith(MARK)) {
        const chunk = stderrChunk(line)
        if (chunk !== undefined) return void this.#options.onStderr?.(chunk)
        // The broker's own last frame before it ends the link: why the shared server is gone.
        const answer = parseAnswer(line)
        if (!answer.ok && parseBrokerFrame(line)?.t === 'refused')
          return void this.onerror?.(new BrokerError(`the shared server ended: ${answer.reason}`))
        return
      }
      try {
        this.onmessage?.(deserializeMessage(line))
      } catch (err) {
        this.onerror?.(err as Error)
      }
    })
    if (socket.destroyed) this.#end()
  }

  send(message: JSONRPCMessage): Promise<void> {
    const socket = this.#socket
    if (socket === undefined || socket.destroyed) return Promise.reject(new Error('the connection closed'))
    const line = JSON.stringify(message)
    // The broker ends a link that sends a longer line. Only this call fails, and the link goes on.
    if (line.length > LINE_MAX)
      return Promise.reject(
        new BrokerError(`this request is longer than the 10 MB that a message to a shared server may hold`),
      )
    return new Promise((resolve, reject) => socket.write(`${line}\n`, err => (err ? reject(err) : resolve())))
  }

  close(): Promise<void> {
    this.#closed = true
    this.#socket?.destroy()
    this.#end()
    return Promise.resolve()
  }

  #end(): void {
    if (this.#ended) return
    this.#ended = true
    this.onclose?.()
  }
  #ended = false
}
