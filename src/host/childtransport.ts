// The stdio transport of every stdio server (issue #63, slice 5; for direct children too since the fix of the wrapper
// that ignores EOF). Like the SDK's, with three differences: it counts the
// requests that wait for an answer (the idle clock runs only with none open), it tells the host at each message (a call
// sets the clock back), and it stops the child as the broker does: end stdin, wait STOP_WAIT_MS, then end the whole
// tree (`taskkill /T /F` on Windows, the process group elsewhere), so a wrapper or a grandchild never stays.

import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import crossSpawn from 'cross-spawn'
import { STOP_WAIT_MS } from '../core/broker.ts'
import { endTree } from './broker.ts'
import type { Guard } from './childguard.ts'

/**
 * The same time at the shutdown of the host: the client of the host waits about 2 s after it ends our stdin, then kills
 * the host (the SDK does, at once on Windows), so the host must have ended the tree of each child by then. The rest of
 * the shutdown (the start of `taskkill`, the exit of the tree, the exit of the host) took 0.5 to 0.8 s on Windows, and
 * with 300 ms here the stop of a direct child took 1.2 to 1.6 s: too near. Children stop in parallel.
 */
export const HURRY_WAIT_MS = process.platform === 'win32' ? 100 : 300

/** Outside Windows, the wait between the SIGTERM to the group of a child and the end of its tree. */
export const TERM_WAIT_MS = 200

export type ChildParams = {
  readonly command: string
  readonly args: readonly string[]
  /** The env of the config. The SDK's short list of safe variables is added under it, as the SDK transport does. */
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  /** The child guard: it ends the tree of this child if the host dies with no cleanup. Absent: none. */
  readonly guard?: Guard
}

/** The env that the child gets. The cache key of a launch does not hash it: it holds the inherited PATH. */
export const childEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> => ({
  ...getDefaultEnvironment(),
  ...env,
})

export class ChildTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  /** Called at each message that goes or comes: the host sets the idle clock back. */
  onactivity?: () => void
  readonly #params: ChildParams
  readonly #buffer = new ReadBuffer()
  readonly #stderr = new PassThrough()
  readonly #open = new Set<string | number>()
  #proc: ChildProcess | undefined
  #stopping: Promise<void> | undefined
  #grace = STOP_WAIT_MS
  #timer: NodeJS.Timeout | undefined
  #kill: (() => void) | undefined
  #term: NodeJS.Timeout | undefined

  constructor(params: ChildParams) {
    this.#params = params
  }

  /** The stderr of the child, from before the start, so no early line is lost. */
  get stderr(): PassThrough {
    return this.#stderr
  }

  /** The requests that wait for an answer. */
  get open(): number {
    return this.#open.size
  }

  start(): Promise<void> {
    if (this.#proc !== undefined) throw new Error('the transport already started')
    return new Promise((resolve, reject) => {
      const proc = crossSpawn(this.#params.command, [...this.#params.args], {
        env: childEnvironment(this.#params.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        // The process group is how the tree of a child ends outside Windows. Windows ends it with taskkill.
        detached: process.platform !== 'win32',
        ...(this.#params.cwd !== undefined && { cwd: this.#params.cwd }),
      })
      this.#proc = proc
      proc.on('error', error => {
        reject(error)
        this.onerror?.(error)
      })
      proc.on('spawn', () => {
        this.#params.guard?.add(proc.pid)
        resolve()
      })
      proc.on('close', () => {
        this.#proc = undefined
        this.#open.clear()
        // A wrapper that left on EOF must not leave a grandchild that ignores it.
        endTree(proc)
        // After the group is ended, and before its id can be reused.
        this.#params.guard?.remove(proc.pid)
        this.onclose?.()
      })
      proc.stdin?.on('error', error => this.onerror?.(error))
      proc.stdout?.on('error', error => this.onerror?.(error))
      proc.stderr?.on('error', () => {})
      proc.stderr?.pipe(this.#stderr)
      proc.stdout?.on('data', chunk => {
        try {
          this.#buffer.append(chunk)
          for (;;) {
            const message = this.#buffer.readMessage()
            if (message === null) break
            this.#seen(message)
            this.onmessage?.(message)
          }
        } catch (error) {
          this.onerror?.(error as Error)
          void this.close()
        }
      })
    })
  }

  #seen(message: JSONRPCMessage): void {
    if (!('method' in message) && message.id !== undefined) this.#open.delete(message.id)
    this.onactivity?.()
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise(resolve => {
      const stdin = this.#proc?.stdin
      if (stdin === undefined || stdin === null) throw new Error('Not connected')
      if ('method' in message) {
        if ('id' in message) this.#open.add(message.id)
        // A cancelled request gets no answer, so it is no longer open.
        else if (message.method === 'notifications/cancelled') {
          const id = (message.params as { requestId?: unknown } | undefined)?.requestId
          if (typeof id === 'string' || typeof id === 'number') this.#open.delete(id)
        }
      }
      this.onactivity?.()
      if (stdin.write(serializeMessage(message))) resolve()
      else stdin.once('drain', resolve)
    })
  }

  /** The host shuts down: a child that has not left HURRY_WAIT_MS after its stdin ended loses its tree now. */
  hurry(): void {
    this.#grace = HURRY_WAIT_MS
    if (this.#timer === undefined || this.#kill === undefined) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(this.#kill, HURRY_WAIT_MS)
  }

  /** Stops the child and its tree, and settles when it is gone. A second call returns the first. */
  close(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const proc = this.#proc
    if (proc === undefined) return Promise.resolve()
    this.#stopping = new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        endTree(proc)
        // The 'close' event may never come on this path: the group must not stay listed.
        this.#params.guard?.remove(proc.pid)
        return resolve()
      }
      const end = () => {
        endTree(proc)
        this.#params.guard?.remove(proc.pid)
        // The close event follows the kill. Do not wait for it longer than a second.
        setTimeout(resolve, 1000).unref()
      }
      // Outside Windows a child that ignores EOF first gets SIGTERM for its group, so it can clean up (a server that
      // removes a temp file or a lock). Windows has no such signal: its tree ends at once.
      this.#kill = () => {
        if (process.platform === 'win32' || proc.pid === undefined) return end()
        try {
          process.kill(-proc.pid, 'SIGTERM')
        } catch {}
        this.#term = setTimeout(end, TERM_WAIT_MS)
      }
      this.#timer = setTimeout(this.#kill, this.#grace)
      proc.once('close', () => {
        clearTimeout(this.#timer)
        clearTimeout(this.#term)
        resolve()
      })
      try {
        proc.stdin?.end()
      } catch {}
    }).then(() => {
      this.#buffer.clear()
      this.#stopping = undefined
    })
    return this.#stopping
  }
}
