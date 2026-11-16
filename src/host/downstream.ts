// The connections to the downstream MCP servers of the config. All connect in
// parallel. A server that fails, whose connection closes, or whose HTTP
// session ends, is logged to stderr and kept as failed, and the others still
// work. A failed server connects again on next use (a search or a call), at
// most MAX_ATTEMPTS times in ATTEMPT_WINDOW_MS, and never after close.

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

/** Hides the secrets of one server, its OAuth tokens too, in the text of one of its errors. */
type Hide = (text: string) => string

/** One server: an attempt in progress, the client to call, or why it failed. */
type Link =
  | { readonly status: 'connecting'; readonly done: Promise<void> }
  | {
      readonly status: 'connected'
      readonly client: Client
      readonly tools: readonly DownstreamTool[]
      readonly hide: Hide
    }
  | { readonly status: 'failed'; readonly reason: string }

export type Linked =
  | { readonly ok: true; readonly client: Client; readonly hide: Hide }
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
    return fetch(url, { ...init, headers })
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

export const listAll = async (client: Client): Promise<DownstreamTool[]> => {
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

export type ConnectOptions = {
  /** The HOME of the OAuth store. */
  readonly home?: string
  /** The command that the reason of a server that needs an OAuth login names. */
  readonly login?: (key: ServerKey) => string
  /** The time in ms for the attempt cap: a test sets it. */
  readonly now?: () => number
  /** The longest wait in ms for the answer to an OAuth refresh: a test sets it. */
  readonly refreshTimeoutMs?: number
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
  }: ConnectOptions = {},
): Downstream => {
  let closing: Promise<void> | undefined
  const links = new Map<ServerKey, Link>()
  // The start times of the attempts of each server in the last window.
  const attempts = new Map<ServerKey, number[]>()
  const opened = new Set<Client>()

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
    // The list state of this client: idle (no `listing`), listing, or listing and `dirty`, when a change came during
    // the list. One list runs at a time, and a dirty one lists once more at its end, so the last list is the newest
    // and a storm of changes costs two lists.
    let tools: readonly DownstreamTool[] = []
    let listing: Promise<void> | undefined
    let dirty = false
    const list = (): Promise<void> => {
      dirty = true
      listing ??= (async () => {
        try {
          while (dirty) {
            dirty = false
            tools = await listAll(client)
            const link = links.get(key)
            if (link?.status === 'connected' && link.client === client) links.set(key, { ...link, tools })
          }
        } finally {
          listing = undefined
        }
      })()
      return listing
    }
    // A server whose tools change, also in their marks, says so: list again, so the checks of a call see the new list.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (listing !== undefined) return void (dirty = true)
      list().catch(err => log(`${key}: could not list the tools again: ${hide(errorText(err))}`))
    })
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
      const made = transportOf(server, sessionEnded, auth)
      lastError = made.lastError
      await client.connect(made.transport, { timeout: CONNECT_TIMEOUT_MS })
      await list()
      links.set(key, { status: 'connected', client, tools, hide })
      log(`${key}: connected, ${tools.length} tools`)
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
      if (after.status === 'connected') return { ok: true, client: after.client, hide: after.hide }
      return { ok: false, reason: notConnected(stateOf(key, after))! }
    },
    close: () => (closing ??= Promise.all([...opened].map(c => c.close().catch(() => {}))).then(() => {})),
  }
}
