// The connections to the downstream MCP servers of the config. All connect in
// parallel. A server that fails, whose connection closes, or whose HTTP
// session ends, is logged to stderr and kept as failed, and the others still
// work. A failed server connects again on next use (a search or a call), at
// most MAX_ATTEMPTS times in ATTEMPT_WINDOW_MS, and never after close. Every wait
// for a connect or a list ends at RETRY_WAIT_MS or at the abort of the caller's signal.

import fs from 'node:fs'
import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { notConnected, type DownstreamTool, type ServerState } from '../core/catalog.ts'
import {
  childEnv,
  invalidReason,
  loginCommand,
  loginReason,
  redact,
  type HttpServer,
  type ServerConfig,
  type ServerEntry,
  type ServerKey,
} from '../core/config.ts'
import { errorText } from '../core/protocol.ts'
import { LoginNeeded, oauthProvider, REFRESH_TIMEOUT_MS, RefreshFailed, storeFile, type Provider } from './oauth.ts'

/** The time that one server gets for its connect, and for its whole tool list. */
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

/** A name that the list of a connected server lacks lists its tools again at most once in this time. */
const MISS_WAIT_MS = 10_000

/** The longest time that a search, a run or a call waits for a connect or a list. */
const RETRY_WAIT_MS = 5_000

/**
 * The least time from the start of one list of a server to the start of its next. So a server that says that its
 * tools change costs one list a second at most, and a call waits about one second for the list after a change.
 */
const LIST_FLOOR_MS = 1_000

/**
 * A server whose tools change more than MAX_CHANGES times in CHANGE_WINDOW_MS fails, and the cap of MAX_ATTEMPTS
 * takes over. Tools change at a deploy, a login or a config change, not ten times a minute.
 */
const MAX_CHANGES = 10
const CHANGE_WINDOW_MS = 60_000

/** Hides the secrets of one server, its OAuth tokens too, in the text of one of its errors. */
type Hide = (text: string) => string

/** The end of a wait: RETRY_WAIT_MS after its start, or the abort of the caller's signal, whichever comes first. */
type Deadline = { readonly at: number; readonly signal: AbortSignal | undefined }

const deadline = (signal?: AbortSignal): Deadline => ({ at: performance.now() + RETRY_WAIT_MS, signal })

const isPast = ({ at, signal }: Deadline): boolean => signal?.aborted === true || performance.now() >= at

/** Waits for `wait` until `end`. Never rejects. It removes its timer and its abort listener at the end. */
const within = async (wait: Promise<unknown>, end: Deadline): Promise<void> => {
  if (isPast(end)) return
  let stop = () => {}
  let timer: NodeJS.Timeout | undefined
  const out = new Promise<void>(resolve => {
    stop = resolve
    timer = setTimeout(resolve, end.at - performance.now())
  })
  end.signal?.addEventListener('abort', stop, { once: true })
  try {
    await Promise.race([wait.catch(() => {}), out])
  } finally {
    clearTimeout(timer)
    end.signal?.removeEventListener('abort', stop)
  }
}

/** The tool lists of one connected client. */
type Lists = {
  /** The newest list that ended. */
  readonly tools: () => readonly DownstreamTool[]
  /** The server says that its tools changed: list again, and each call waits for that list. */
  readonly changed: () => void
  /** A call names a tool that the list lacks: list again, and return the number of that list for `until`. */
  readonly miss: () => number
  /**
   * Waits until a list that covers ask `n` ends, the lists stop, or `end` comes. Without `n`, it waits for the
   * list after the last change. True when that list ended.
   */
  readonly until: (end: Deadline, n?: number) => Promise<boolean>
}

/**
 * The lists after the list at connect, which gave `first`. Each ask (a change or a miss) takes the next number, and
 * a list covers each ask before its start. One list runs at a time, `floorMs` after the start of the one before. So a
 * storm or an endless stream of changes costs one list per `floorMs`. A list that fails, or more than MAX_CHANGES
 * lists for a change in CHANGE_WINDOW_MS, stops the lists and gives `stop` the reason.
 */
const startLists = (
  first: readonly DownstreamTool[],
  list: () => Promise<DownstreamTool[]>,
  stop: (reason: string) => void,
  floorMs: number,
): Lists => {
  let tools = first
  let asked = 0
  let covered = 0
  let lastChange = 0
  let lastStart = performance.now()
  const changeStarts: number[] = []
  let running = false
  let stopped = false
  // Settles at the end of each list and when the lists stop, so each `until` looks again.
  let wake = () => {}
  let ended = new Promise<void>(resolve => (wake = resolve))
  const endList = () => {
    wake()
    ended = new Promise<void>(resolve => (wake = resolve))
  }
  const halt = (reason: string) => {
    stopped = true
    stop(reason)
  }
  const run = async () => {
    running = true
    try {
      while (covered < asked && !stopped) {
        await new Promise(resolve => setTimeout(resolve, lastStart + floorMs - performance.now()))
        const ask = asked
        lastStart = performance.now()
        if (lastChange > covered) {
          while (changeStarts.length > 0 && lastStart - changeStarts[0]! >= CHANGE_WINDOW_MS) changeStarts.shift()
          if (changeStarts.length === MAX_CHANGES)
            return halt(`its tools changed more than ${MAX_CHANGES} times in ${CHANGE_WINDOW_MS / 1000} s`)
          changeStarts.push(lastStart)
        }
        tools = await list()
        covered = ask
        endList()
      }
    } catch (err) {
      halt(`could not list the tools again: ${errorText(err)}`)
    } finally {
      running = false
      endList()
    }
  }
  const ask = (): number => {
    asked++
    if (!running && !stopped) void run()
    return asked
  }
  return {
    tools: () => tools,
    changed: () => void (lastChange = ask()),
    miss: ask,
    until: async (end, n = lastChange) => {
      while (covered < n && !stopped && !isPast(end)) await within(ended, end)
      return covered >= n
    },
  }
}

/** One server: an attempt in progress, the client to call, or why it failed. */
type Link =
  | { readonly status: 'connecting'; readonly done: Promise<void> }
  | { readonly status: 'connected'; readonly client: Client; readonly hide: Hide; readonly lists: Lists }
  | { readonly status: 'failed'; readonly reason: string }

/** `tools`: the list after the last change of the server. */
export type Linked =
  | { readonly ok: true; readonly client: Client; readonly hide: Hide; readonly tools: readonly DownstreamTool[] }
  | { readonly ok: false; readonly reason: string }

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
   * cap allows, and waits up to RETRY_WAIT_MS or until `signal` aborts. With `keys` (a run), it also waits
   * for an attempt that another caller started, and for the list after the last change, so the run can use the
   * server. Without `keys` (a search), it waits only for the attempts that it started,
   * so a server that hangs in its connect does not slow each search. Never rejects.
   */
  retry(keys?: readonly ServerKey[], signal?: AbortSignal): Promise<void>
  /**
   * The client of a server, for a nested call. A failed server connects again
   * first when the cap allows, and every caller waits for the same attempt. Then the call waits for the list after
   * the last change of the server. A list that does not come up to RETRY_WAIT_MS, or before `signal` aborts, fails
   * the call: an older list can lack a new mark.
   */
  client(key: ServerKey, signal?: AbortSignal): Promise<Linked>
  /**
   * Lists the tools of a connected server again, for a name that its list lacks: at most once in MISS_WAIT_MS per
   * server. Waits for that list up to RETRY_WAIT_MS, or until `signal` aborts. Never rejects.
   */
  relist(key: ServerKey, signal?: AbortSignal): Promise<void>
  /** Closes every client, connected or still connecting, and so ends every stdio child. */
  close(): Promise<void>
}

/** The 400 texts of SDK servers, and of the SDK examples, for a session that the server does not know. */
const UNKNOWN_SESSION =
  /Server not initialized|Mcp-Session-Id header is required|No valid session ID|Session not found/i

/**
 * True for an error of an HTTP request that shows the session is gone: a
 * person must log in again, the
 * server cannot be reached, it answers 404 to a request with a session id, as
 * the spec says, or 400 with an SDK text for an unknown session. Any other 400
 * is an error of that request only, as from a gateway that rejects a payload.
 */
const endsSession = (err: unknown, hadSession: boolean): err is Error =>
  isOAuthStop(err) ||
  (err instanceof TypeError && err.message === 'fetch failed') ||
  (err instanceof StreamableHTTPError &&
    ((err.code === 404 && hadSession) || (err.code === 400 && UNKNOWN_SESSION.test(err.message))))

/**
 * True for an error of the SDK's OAuth flow that only a new login fixes. With OAuth, the SDK answers a 401 itself:
 * it refreshes the token and sends again, so a 401 that comes through is a server that still refuses the token. A
 * stored client of another authorization server needs a new registration, and only login registers.
 */
const needsLogin = (err: unknown): boolean =>
  (err instanceof StreamableHTTPError && err.code === 401) ||
  (err instanceof Error && err.message.startsWith('OAuth client information is bound to authorization server'))

/** An error of the provider whose message is the reason to show: a login is needed, or a refresh failed. */
const isOAuthStop = (err: unknown): err is Error => err instanceof LoginNeeded || err instanceof RefreshFailed

/** The OAuth provider of an HTTP server, and the reason that its link shows when a person must log in. */
type Auth = { readonly provider: Provider; readonly reason: string }

/**
 * The SDK HTTP client transport, which calls `onSessionEnd` before a request
 * that finds the session gone rejects. An error of the optional GET stream
 * rejects no request, so it never ends the session.
 */
class HttpTransport extends StreamableHTTPClientTransport {
  readonly #onSessionEnd: (err: Error) => void
  readonly #loginReason: string | undefined

  constructor(server: HttpServer, onSessionEnd: (err: Error) => void, auth: Auth | undefined) {
    super(new URL(server.url), {
      fetch: auth ? auth.provider.fetch(serverFetch(server)) : serverFetch(server),
      ...(auth && { authProvider: auth.provider }),
    })
    this.#onSessionEnd = onSessionEnd
    this.#loginReason = auth?.reason
  }

  override async send(...args: Parameters<StreamableHTTPClientTransport['send']>): Promise<void> {
    const hadSession = this.sessionId !== undefined
    try {
      await super.send(...args)
    } catch (raw) {
      const err = this.#loginReason !== undefined && needsLogin(raw) ? new LoginNeeded(this.#loginReason) : raw
      if (endsSession(err, hadSession)) this.#onSessionEnd(err)
      throw err
    }
  }
}

/**
 * fetch with the config headers on each request to the origin of the server only. The SDK sends its OAuth requests
 * through it too, and a header for the MCP server must never reach an authorization server.
 */
export const serverFetch = (server: HttpServer): FetchLike => {
  const origin = new URL(server.url).origin
  return (url, init) => {
    const headers = new Headers(init?.headers)
    if (new URL(url).origin === origin)
      for (const [name, value] of Object.entries(server.headers)) headers.set(name, value)
    // The SDK gives one signal to every request of a transport, and fetch keeps a listener on it until the request is
    // garbage collected. A signal that follows it takes that listener, so many requests add no listener to it.
    const signal = init?.signal ? AbortSignal.any([init.signal]) : init?.signal
    return fetch(url, { ...init, headers, signal })
  }
}

/**
 * The transport of one server, and the end of what its stdio child wrote to
 * stderr, as one line. The child's stderr still goes on to ours, as with `inherit`.
 */
const transportOf = (
  server: ServerConfig,
  onSessionEnd: (err: Error) => void,
  auth: Auth | undefined,
): { transport: Transport; lastError: () => string } => {
  if (server.kind === 'http') return { transport: new HttpTransport(server, onSessionEnd, auth), lastError: () => '' }
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: childEnv(server),
    ...(server.cwd !== undefined && { cwd: server.cwd }),
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

/**
 * Why the cwd of a stdio server cannot be its folder, or undefined when it can. Without this check, the spawn of a
 * child in a missing folder fails with "spawn <command> ENOENT", which blames the command.
 */
const cwdProblem = async (server: ServerConfig): Promise<string | undefined> => {
  if (server.kind !== 'stdio' || server.cwd === undefined) return undefined
  try {
    return (await fs.promises.stat(server.cwd)).isDirectory() ? undefined : `its cwd is not a folder: ${server.cwd}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `its cwd folder does not exist: ${server.cwd}`
    return `cannot read its cwd folder: ${errorText(err)}`
  }
}

/** `cut` runs when the list has more than MAX_PAGES pages. The whole list has CONNECT_TIMEOUT_MS. */
export const listAll = async (client: Client, cut = () => {}): Promise<DownstreamTool[]> => {
  const tools: DownstreamTool[] = []
  const end = performance.now() + CONNECT_TIMEOUT_MS
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const timeout = Math.max(0, end - performance.now())
    const result = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (!cursor) break
  }
  if (cursor) cut()
  return tools
}

export type ConnectOptions = {
  /** The HOME of the OAuth store. */
  readonly home?: string
  /** The command that the reason of a server that needs an OAuth login names. */
  readonly login?: (key: ServerKey) => string
  /** The time in ms for the attempt cap: a test sets it. */
  readonly now?: () => number
  /** The longest wait in ms for the answer to an OAuth refresh: a test sets it. */
  readonly refreshTimeoutMs?: number
  /** The least time in ms from the start of one list of a server to the start of its next: a test sets it. */
  readonly listFloorMs?: number
}

export const connectAll = (
  servers: ReadonlyMap<ServerKey, ServerEntry>,
  version: string,
  log: (line: string) => void,
  {
    home = os.homedir(),
    login = key => loginCommand(key),
    now = Date.now,
    refreshTimeoutMs = REFRESH_TIMEOUT_MS,
    listFloorMs = LIST_FLOOR_MS,
  }: ConnectOptions = {},
): Downstream => {
  let closing: Promise<void> | undefined
  const links = new Map<ServerKey, Link>()
  // The start times of the attempts of each server in the last window.
  const attempts = new Map<ServerKey, number[]>()
  const opened = new Set<Client>()
  // The time of the last list of each server for a name that its list lacked.
  const missed = new Map<ServerKey, number>()

  const connect = async (key: ServerKey, server: ServerConfig): Promise<void> => {
    const client = new Client({ name: 'toolscript-mcp', version })
    opened.add(client)
    let secrets = (): readonly string[] => []
    const hide: Hide = text => redact(text, server, secrets())
    const fail = (reason: string) => {
      const safe = hide(reason)
      log(`${key}: failed: ${safe}`)
      links.set(key, { status: 'failed', reason: safe })
    }
    // Only while this client is still the link of `key`: a late event of an old client changes nothing.
    const lost = (reason: string): boolean => {
      const link = links.get(key)
      if (closing || link?.status !== 'connected' || link.client !== client) return false
      fail(reason)
      return true
    }
    // The SDK HTTP transport fires onclose only from close(), so a server that
    // restarted shows only as an error of a request. The link fails before
    // that request rejects, and the next use connects again.
    const sessionEnded = (err: Error) => {
      if (!lost(isOAuthStop(err) ? err.message : `the HTTP session ended: ${errorText(err)}`)) return
      // Later, so the failed request rejects with its own error first: close()
      // rejects each open request with "Connection closed".
      setImmediate(() => void client.close().catch(() => {}))
    }
    const list = () =>
      listAll(client, () =>
        log(`${key}: the tool list has more than ${MAX_PAGES} pages, so toolscript-mcp uses the first ${MAX_PAGES}`),
      )
    // A server whose tools change, also in their marks, says so: list again, so the checks of a call see the new list.
    // A change before the lists start, in the connect or in its list, lists once more after it.
    let lists: Lists | undefined
    let early = false
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      lists === undefined ? void (early = true) : lists.changed(),
    )
    let lastError = () => ''
    try {
      // Inside the try: a transport that cannot be made fails this server only.
      const reason = loginReason(login(key))
      const auth: Auth | undefined =
        server.kind === 'http' && server.oauth
          ? {
              provider: oauthProvider(storeFile(home, key, server.url), server.oauth, {
                kind: 'serve',
                reason,
                refreshTimeoutMs,
              }),
              reason,
            }
          : undefined
      if (auth) secrets = auth.provider.secrets
      const problem = await cwdProblem(server)
      if (problem !== undefined) throw new Error(problem)
      // close() closes only the clients that it sees: a shutdown during the check must not start a process after it.
      if (closing) throw new Error('toolscript-mcp is shutting down')
      const made = transportOf(server, sessionEnded, auth)
      lastError = made.lastError
      await client.connect(made.transport, { timeout: CONNECT_TIMEOUT_MS })
      const first = await list()
      // The old list can lack a new mark, so lists that stop fail the link, and the next use connects and lists anew.
      lists = startLists(first, list, reason => lost(reason) && void client.close().catch(() => {}), listFloorMs)
      if (early) lists.changed()
      links.set(key, { status: 'connected', client, hide, lists })
      log(`${key}: connected, ${first.length} tools`)
      client.onclose = () => {
        opened.delete(client)
        const stderr = lastError()
        lost(`the connection closed${stderr === '' ? '' : `. Its stderr ends with: ${stderr}`}`)
      }
    } catch (err) {
      // A child that exits gives only "Connection closed": its stderr says
      // why (on Windows, also for a command that is not found).
      const stderr = lastError()
      // After an await: a failure that comes at once must not come before `attempt` marks the link connecting.
      await client.close().catch(() => {})
      opened.delete(client)
      fail(stderr === '' ? errorText(err) : `${errorText(err)}. Its stderr ends with: ${stderr}`)
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

  /**
   * Waits until `key` is ready for a call, or until `end`: for one connect attempt at most (a new one when the cap
   * allows it, or the one in progress, whoever started it), and for the list after the last change. A list that
   * fails fails the link, and then the attempt lists anew.
   */
  const settle = async (key: ServerKey, end: Deadline): Promise<void> => {
    let attempted = false
    while (!isPast(end)) {
      const link = links.get(key)
      if (link?.status === 'connected') {
        await link.lists.until(end)
        if (links.get(key) === link) return
        continue
      }
      const wait = attempted ? undefined : link?.status === 'connecting' ? link.done : reconnect(key)
      if (wait === undefined) return
      attempted = true
      await within(wait, end)
    }
  }

  const stateOf = (key: ServerKey, link: Link): ServerState => {
    if (link.status === 'connecting') return { key, status: 'connecting' }
    if (link.status === 'connected') return { key, status: 'connected', tools: link.lists.tools() }
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
    retry: async (keys, signal) => {
      const end = deadline(signal)
      const waits =
        keys === undefined
          ? [...servers.keys()].flatMap(key => reconnect(key) ?? [])
          : keys.map(key => settle(key, end))
      await within(Promise.all(waits), end)
    },
    client: async (key, signal) => {
      if (closing) return { ok: false, reason: 'toolscript-mcp is shutting down' }
      if (!links.has(key)) return { ok: false, reason: `no MCP server "${key}" is connected` }
      const end = deadline(signal)
      await settle(key, end)
      const link = links.get(key)!
      if (link.status !== 'connected') return { ok: false, reason: notConnected(stateOf(key, link))! }
      if (!(await link.lists.until(end)))
        return {
          ok: false,
          reason: `the MCP server "${key}" changed its tools, and its new tool list did not come in time. Run the program again`,
        }
      return { ok: true, client: link.client, hide: link.hide, tools: link.lists.tools() }
    },
    relist: async (key, signal) => {
      const link = links.get(key)
      if (link?.status !== 'connected' || now() - (missed.get(key) ?? -Infinity) < MISS_WAIT_MS) return
      missed.set(key, now())
      await link.lists.until(deadline(signal), link.lists.miss())
    },
    close: () => (closing ??= Promise.all([...opened].map(c => c.close().catch(() => {}))).then(() => {})),
  }
}
