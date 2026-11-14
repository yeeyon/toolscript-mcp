// The connections to the downstream MCP servers of the config. All connect in
// parallel. A server that fails, or whose connection closes, is logged to
// stderr and kept as failed, and the others still work. A failed server
// connects again on next use (a search or a call), at most MAX_ATTEMPTS times
// in ATTEMPT_WINDOW_MS, and never after close.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { DownstreamTool, ServerState } from '../core/catalog.ts'
import { childEnv, invalidReason, redact, type ServerConfig, type ServerEntry, type ServerKey } from '../core/config.ts'
import { errorText } from '../core/protocol.ts'

/** The time that one server gets for its connect and for each page of its tool list. */
export const CONNECT_TIMEOUT_MS = 30_000

/** A tool list longer than this many pages is cut, so a server cannot page forever. */
const MAX_PAGES = 100

/**
 * The longest time after the start that a search waits for servers still
 * connecting. Later searches answer at once, so a server that hangs costs
 * this wait one time, not on each search.
 */
export const FIRST_WAIT_MS = 10_000

/** The connect attempts of one server in any window of ATTEMPT_WINDOW_MS, the first connect included. */
const MAX_ATTEMPTS = 3
const ATTEMPT_WINDOW_MS = 60_000

/** The longest time a search or a run waits for reconnects in `retry`. */
const RETRY_WAIT_MS = 5_000

/** One server: an attempt in progress, the client to call, or why it failed. */
type Link =
  | { readonly status: 'connecting'; readonly done: Promise<void> }
  | { readonly status: 'connected'; readonly client: Client; readonly tools: readonly DownstreamTool[] }
  | { readonly status: 'failed'; readonly reason: string }

export type Linked = { readonly ok: true; readonly client: Client } | { readonly ok: false; readonly reason: string }

export type Downstream = {
  /**
   * Settles when every server connected or failed, or FIRST_WAIT_MS after the
   * start, whichever comes first. Never rejects.
   */
  readonly settled: Promise<void>
  /** The state of each server now, in config order. */
  states(): readonly ServerState[]
  /**
   * Connects again each failed server of `keys` (all when undefined) that the
   * cap allows, and waits up to RETRY_WAIT_MS. With `keys` (a run), it also waits
   * for an attempt that another caller started, so the run can use the server.
   * Without `keys` (a search), it waits only for the attempts that it started,
   * so a server that hangs in its connect does not slow each search. Never rejects.
   */
  retry(keys?: readonly ServerKey[]): Promise<void>
  /**
   * The client of a server, for a nested call. A failed server connects again
   * first when the cap allows, and every caller waits for the same attempt.
   */
  client(key: ServerKey): Promise<Linked>
  /** Closes every client, connected or still connecting, and so ends every stdio child. */
  close(): Promise<void>
}

/**
 * The transport of one server, and the end of what its stdio child wrote to
 * stderr, as one line. The child's stderr still goes on to ours, as with `inherit`.
 */
const transportOf = (server: ServerConfig): { transport: Transport; lastError: () => string } => {
  if (server.kind === 'http')
    return {
      transport: new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { ...server.headers } },
      }),
      lastError: () => '',
    }
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: childEnv(server),
    stderr: 'pipe',
  })
  let tail = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    tail = (tail + chunk.toString('utf8')).slice(-2000)
  })
  const lastError = () => tail.replace(/\s+/g, ' ').trim().slice(-300)
  return { transport, lastError }
}

const listAll = async (client: Client): Promise<DownstreamTool[]> => {
  const tools: DownstreamTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: CONNECT_TIMEOUT_MS })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (!cursor) break
  }
  return tools
}

/** `now` gives the time in ms for the attempt cap: a test sets it. */
export const connectAll = (
  servers: ReadonlyMap<ServerKey, ServerEntry>,
  version: string,
  log: (line: string) => void,
  now: () => number = Date.now,
): Downstream => {
  let closing: Promise<void> | undefined
  const links = new Map<ServerKey, Link>()
  // The start times of the attempts of each server in the last window.
  const attempts = new Map<ServerKey, number[]>()
  const opened = new Set<Client>()

  const fail = (key: ServerKey, server: ServerConfig, reason: string) => {
    const safe = redact(reason, server)
    log(`${key}: failed: ${safe}`)
    links.set(key, { status: 'failed', reason: safe })
  }

  const connect = async (key: ServerKey, server: ServerConfig): Promise<void> => {
    const client = new Client({ name: 'toolscript-mcp', version })
    opened.add(client)
    const { transport, lastError } = transportOf(server)
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      const tools = await listAll(client)
      links.set(key, { status: 'connected', client, tools })
      log(`${key}: connected, ${tools.length} tools`)
      client.onclose = () => {
        opened.delete(client)
        if (closing) return
        const stderr = lastError()
        fail(key, server, `the connection closed${stderr === '' ? '' : `. Its stderr ends with: ${stderr}`}`)
      }
    } catch (err) {
      // A child that exits gives only "Connection closed": its stderr says
      // why (on Windows, also for a command that is not found).
      const stderr = lastError()
      fail(key, server, stderr === '' ? errorText(err) : `${errorText(err)}. Its stderr ends with: ${stderr}`)
      await client.close().catch(() => {})
      opened.delete(client)
    }
  }

  const recent = (key: ServerKey): number[] =>
    (attempts.get(key) ?? []).filter(started => now() - started < ATTEMPT_WINDOW_MS)

  /** The ms until the cap allows the next attempt of `key`: 0 when it allows one now. */
  const capWait = (key: ServerKey): number => {
    const times = recent(key)
    return times.length < MAX_ATTEMPTS ? 0 : times[0]! + ATTEMPT_WINDOW_MS - now()
  }

  const attempt = (key: ServerKey, server: ServerConfig): Promise<void> => {
    attempts.set(key, [...recent(key), now()])
    const done = connect(key, server)
    links.set(key, { status: 'connecting', done })
    return done
  }

  /** Starts an attempt when `key` failed and the cap allows one, and returns it. */
  const reconnect = (key: ServerKey): Promise<void> | undefined => {
    const server = servers.get(key)
    // An entry with config errors never starts, so it never comes back either.
    if (closing || server === undefined || server.kind === 'invalid') return undefined
    if (links.get(key)?.status !== 'failed' || capWait(key) > 0) return undefined
    log(`${key}: connecting again`)
    return attempt(key, server)
  }

  /** The attempt that a caller of `key` waits for: a new one, or the one in progress, whoever started it. */
  const pending = (key: ServerKey): Promise<void> | undefined => {
    const link = links.get(key)
    return reconnect(key) ?? (link?.status === 'connecting' ? link.done : undefined)
  }

  const stateOf = (key: ServerKey, link: Link): ServerState => {
    if (link.status === 'connecting') return { key, status: 'connecting' }
    if (link.status === 'connected') return { key, status: 'connected', tools: link.tools }
    const wait = closing ? 0 : capWait(key)
    const note = wait > 0 ? `. toolscript-mcp tries again on next use after ${Math.ceil(wait / 1000)} s` : ''
    return { key, status: 'failed', reason: `${link.reason}${note}` }
  }

  // Its errors name keys and variables, never values.
  const ready = Promise.all(
    [...servers].map(async ([key, server]) => {
      if (server.kind !== 'invalid') return attempt(key, server)
      const reason = invalidReason(server.errors)
      log(`${key}: failed: ${reason}`)
      links.set(key, { status: 'failed', reason })
    }),
  )
  return {
    settled: Promise.race([ready, new Promise(r => setTimeout(r, FIRST_WAIT_MS).unref())]).then(() => {}),
    states: () => [...links].map(([key, link]) => stateOf(key, link)),
    retry: async keys => {
      const waits =
        keys === undefined
          ? [...servers.keys()].flatMap(key => reconnect(key) ?? [])
          : keys.flatMap(key => pending(key) ?? [])
      if (waits.length === 0) return
      let timer: NodeJS.Timeout | undefined
      await Promise.race([Promise.all(waits), new Promise(r => (timer = setTimeout(r, RETRY_WAIT_MS)))])
      clearTimeout(timer)
    },
    client: async key => {
      if (closing) return { ok: false, reason: 'toolscript-mcp is shutting down' }
      const link = links.get(key)
      if (link === undefined) return { ok: false, reason: `no MCP server "${key}" is connected` }
      await pending(key)
      const after = links.get(key) ?? link
      if (after.status === 'connected') return { ok: true, client: after.client }
      const state = stateOf(key, after)
      const why = state.status === 'failed' ? state.reason : 'it is still connecting'
      return { ok: false, reason: `the MCP server "${key}" is not connected: ${why}` }
    },
    close: () => (closing ??= Promise.all([...opened].map(c => c.close().catch(() => {}))).then(() => {})),
  }
}
