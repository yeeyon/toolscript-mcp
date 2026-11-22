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
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  BROKER_START_MS,
  CHILD_INIT_MS,
  entryFrame,
  hostSide,
  LINE_MAX,
  lineSplitter,
  parseAnswer,
  PROOF_BYTES,
  PROOF_MS,
  resolveEnvPath,
  SOCKET_MAX_BYTES,
  unusable,
  type Entry,
} from '../core/broker.ts'
import { childEnv, type StdioServer } from '../core/config.ts'
import type { Keyed, Place } from '../core/share.ts'
import { BAD_KEY, buildId, endpointFor, loadKey, makeCrypto } from './brokerwire.ts'

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
export const entryOf = (server: StdioServer, class_: Keyed, at: Place): Entry => ({
  command: server.command,
  args: server.args,
  env: resolveEnvPath(
    { ...getDefaultEnvironment(), ...childEnv(server) },
    path.delimiter,
    realPath,
    process.platform === 'win32',
  ),
  folder: server.cwd ?? (class_.class === 'shared' ? at.home : at.folder),
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

/** Connects to the broker, starts it when none listens, and polls up to BROKER_START_MS. */
const dial = async (endpoint: string, file: string, id: string): Promise<net.Socket> => {
  const end = performance.now() + BROKER_START_MS
  let started = false
  for (;;) {
    try {
      return await dialOnce(endpoint)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
      if (!['ENOENT', 'ECONNREFUSED', 'EBUSY', 'EAGAIN'].includes(code))
        throw new BrokerError(unusable(`could not connect to it (${code})`))
      if (!started) {
        // The broker that would start is the file as it is now, and the endpoint is the file as this process read it.
        // After a rebuild in place they differ and no link could ever meet: say so.
        if (buildId(file) !== id)
          throw new BrokerError(unusable('toolscript-mcp was rebuilt after this session started. Restart the session'))
        startDetached(file)
      }
      started = true
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
}

/** A connection that proved the key both ways and, with an entry, was attached to a child. */
export const openLink = async ({
  home,
  brokerFile,
  entry,
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
  const socket = await dial(endpoint, brokerFile, id)
  const lines = reader(socket)
  try {
    const side = hostSide(wire)
    socket.write(side.start())
    const until = performance.now() + PROOF_MS
    for (let done = false; !done; ) {
      const line = await lines.next(Math.max(0, until - performance.now()))
      if (line === undefined)
        throw new BrokerError(
          unusable(
            lines.tooLong()
              ? 'the peer sent more than 4 KB in a line before it proved the key'
              : `the peer did not answer the handshake in ${PROOF_MS / 1000} s`,
          ),
        )
      const step = side.step(line)
      if (step.fail !== undefined) throw new BrokerError(unusable(step.fail))
      if (step.send !== undefined) socket.write(step.send)
      done = step.done === true
    }
    lines.proven()
    if (entry !== undefined) {
      socket.write(entryFrame(entry))
      const line = await lines.next(CHILD_INIT_MS + 5_000)
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
      // The broker's own last frame before it ends the link: why the shared server is gone.
      if (line.startsWith('{"t":"refused"')) {
        const answer = parseAnswer(line)
        if (!answer.ok) return void this.onerror?.(new BrokerError(`the shared server ended: ${answer.reason}`))
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
    return new Promise((resolve, reject) =>
      socket.write(`${JSON.stringify(message)}\n`, err => (err ? reject(err) : resolve())),
    )
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
