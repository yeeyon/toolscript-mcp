// The connections to the downstream MCP servers of the config. All connect in
// parallel. A server that fails, whose connection closes, or whose HTTP
// session ends, is logged to stderr and kept as failed, and the others still
// work. A failed server connects again on next use (a search or a call), at
// most MAX_ATTEMPTS times in ATTEMPT_WINDOW_MS, and never after close. Every wait
// for a connect or a list ends at RETRY_WAIT_MS or at the abort of the caller's signal.
// A lazy server (issue #63, slice 5) with a cached tool list starts asleep, with no process. A nested call wakes it,
// and it sleeps again after the idle time with no open request. A wake waits up to CONNECT_TIMEOUT_MS.

import fs from 'node:fs'
import os from 'node:os'
import { IssuerMismatchError } from './sdk/auth.ts'
import { listToolsPage, newClient, onToolListChanged, type HostClient } from './sdk/client.ts'
import { StreamableHTTPClientTransport } from './sdk/transport.ts'
import type { FetchLike, Transport } from './sdk/transport.ts'
import { notConnected, type DownstreamTool, type ServerState } from '../core/catalog.ts'
import { cachedTools, isLazy, sameTools, type ToolsCache } from '../core/lazy.ts'
import {
  childEnv,
  invalidReason,
  loginCommand,
  loginReason,
  NPX_LAUNCH,
  redact,
  type HttpServer,
  type InvalidServer,
  type ServerConfig,
  type ServerEntry,
  type ServerKey,
  type StdioServer,
} from '../core/config.ts'
import type { Bridges } from '../core/policy.ts'
import { errorText } from '../core/protocol.ts'
import { httpStatus, isBoundElsewhere, sdkErrorText } from './sdk/errors.ts'
import { metadataIssuerText } from '../core/issuer.ts'
import { classify } from '../core/share.ts'
import { BrokerError, BrokerTransport, entryOf } from './brokerlink.ts'
import type { Guard } from './childguard.ts'
import { ChildTransport } from './childtransport.ts'
import {
  IssuerRefused,
  LoginNeeded,
  oauthProvider,
  REFRESH_TIMEOUT_MS,
  RefreshFailed,
  storeFile,
  type Provider,
} from './oauth.ts'
import { AwsCredentialsError, sigv4Fetch, stopCredentialReads } from './sigv4.ts'
import type { WorkspaceLink } from './workspace/bind.ts'

/** A server entry that starts: any entry but an invalid one. */
type Live = Exclude<ServerEntry, InvalidServer>

/** The time that one server gets for its connect, and for its whole tool list. */
export const CONNECT_TIMEOUT_MS = 30_000

/** A tool list longer than this many pages is cut, so a server cannot page forever. */
const MAX_PAGES = 100

/**
 * The longest time after the start that a search, or a run that does not name
 * its servers, waits for servers still connecting. A run that names only some
 * servers waits for those only, with the same cap. Later waits end at once, so
 * a server that hangs costs this wait one time.
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

/**
 * Ends the reason of a server whose text is untrusted, in place of the error text that the server or its child wrote.
 * The running server logs that text to its stderr.
 */
const UNSHOWN = 'Its error text is in the toolscript-mcp log only, because the text of this server is untrusted'

/** Ends the reason of a failed stdio child that wrote to stderr, in place of that text. */
const STDERR_UNSHOWN =
  'Its stderr is not shown here. To read it, run the command of the server in a terminal. When the client starts toolscript-mcp, its log also holds it'

/** An error whose text toolscript-mcp wrote: it holds no text of the server. */
class OwnError extends Error {}

/** The end of a wait: RETRY_WAIT_MS after its start, or the abort of the caller's signal, whichever comes first. */
type Deadline = { readonly at: number; readonly signal: AbortSignal | undefined }

const deadline = (signal?: AbortSignal, ms = RETRY_WAIT_MS): Deadline => ({ at: performance.now() + ms, signal })

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
 * lists for a change in CHANGE_WINDOW_MS, stops the lists and gives `stop` the reason, and the start of the reason
 * without the error text of the server when the reason holds such text.
 */
export const startLists = (
  first: readonly DownstreamTool[],
  list: () => Promise<DownstreamTool[]>,
  stop: (reason: string, hidden?: string) => void,
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
  const halt = (reason: string, hidden?: string) => {
    stopped = true
    stop(reason, hidden)
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
      halt(`could not list the tools again: ${sdkErrorText(err)}`, 'could not list the tools again')
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
    // The target is read at each look: a change that comes during the wait must be covered too.
    until: async (end, n) => {
      const target = () => n ?? lastChange
      while (covered < target() && !stopped && !isPast(end)) await within(ended, end)
      return covered >= target()
    },
  }
}

/**
 * One server: an attempt in progress, the client to call, or why it failed. `sealed` is the reason without the error
 * text of the server or its child, for a server whose text is untrusted.
 */
type Link =
  | { readonly status: 'connecting'; readonly done: Promise<void>; readonly since: number }
  | {
      readonly status: 'connected'
      readonly client: HostClient
      readonly hide: Hide
      readonly lists: Lists
      /** Sets the idle clock of a lazy server back: a call that reaches the link is activity. */
      readonly touch?: () => void
    }
  /** A lazy server with no process. `stopping`: its last child is still ending, and a wake waits for that. */
  | { readonly status: 'asleep'; readonly tools: readonly DownstreamTool[]; readonly stopping?: Promise<void> }
  /** `final`: the bind of the built-in Workspace failed. It settles once at the start and never heals: no retry, no note. */
  | { readonly status: 'failed'; readonly reason: string; readonly sealed: string; readonly final?: true }

/** `tools`: the list after the last change of the server. */
export type Linked =
  | { readonly ok: true; readonly client: HostClient; readonly hide: Hide; readonly tools: readonly DownstreamTool[] }
  | { readonly ok: false; readonly reason: string }

export type Downstream = {
  /**
   * Settles when every server connected or failed, or FIRST_WAIT_MS after the
   * start, whichever comes first. Never rejects.
   */
  readonly settled: Promise<void>
  /**
   * Like `settled`, but for the servers in `keys` only: settles when the first connect attempt of each ended, or
   * FIRST_WAIT_MS after the start, the same cap. A key that is not a valid entry of the config (unknown, or with
   * config errors) makes it the full `settled`. After `settled`, it returns at once. Never rejects.
   */
  settledFor(keys: readonly ServerKey[]): Promise<void>
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
  /**
   * True when the text of `key` is untrusted: its entry has `"untrusted": true`, or it returned a result in an
   * untrusted wrapper in this session. Each result of such a server counts as untrusted, also an error, and the
   * reason of its failed link holds no error text that the server or its child wrote. The log has that text.
   */
  untrusted(key: ServerKey): boolean
  /** Makes the text of `key` untrusted for the rest of the session. */
  distrust(key: ServerKey): void
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
  (httpStatus(err) === 404 && hadSession) ||
  (httpStatus(err) === 400 && err instanceof Error && UNKNOWN_SESSION.test(err.message))

/**
 * True for an error of the SDK's OAuth flow that only a new login fixes. With OAuth, the SDK answers a 401 itself:
 * it refreshes the token and sends again, so a 401 that comes through is a server that still refuses the token. A
 * stored client of another authorization server needs a new registration, and only login registers.
 */
const needsLogin = (err: unknown): boolean => httpStatus(err) === 401 || isBoundElsewhere(err)

/** An error of the provider whose message is the reason to show: a login is needed, a refresh failed, or an issuer is refused. */
const isOAuthStop = (err: unknown): err is Error =>
  err instanceof LoginNeeded || err instanceof RefreshFailed || err instanceof IssuerRefused

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
  /** The AWS credentials of a SigV4 entry, to hide from the texts that reach the model and the log. */
  readonly secrets: () => readonly string[]

  constructor(
    server: HttpServer,
    onSessionEnd: (err: Error) => void,
    auth: Auth | undefined,
    signed = server.sigv4 && !auth
      ? sigv4Fetch({ url: server.url, sigv4: server.sigv4, headers: server.headers }, serverFetch(server))
      : undefined,
  ) {
    super(new URL(server.url), {
      fetch: auth ? auth.provider.fetch(serverFetch(server)) : (signed ?? serverFetch(server)),
      ...(auth && { authProvider: auth.provider }),
    })
    this.#onSessionEnd = onSessionEnd
    this.#loginReason = auth?.reason
    this.secrets = signed?.secrets ?? (() => [])
  }

  override async send(...args: Parameters<StreamableHTTPClientTransport['send']>): Promise<void> {
    const hadSession = this.sessionId !== undefined
    try {
      await super.send(...args)
    } catch (raw) {
      // The metadata of an authorization server that names another issuer: the SDK sends it no login and no token.
      const err =
        raw instanceof IssuerMismatchError && raw.kind === 'metadata'
          ? new IssuerRefused(metadataIssuerText(raw.expected ?? '', raw.received))
          : this.#loginReason !== undefined && needsLogin(raw)
            ? new LoginNeeded(this.#loginReason)
            : raw
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
 * stderr, as one line. The child's stderr also goes to `stderr`.
 */
const transportOf = (
  key: ServerKey,
  server: ServerConfig,
  onSessionEnd: (err: Error) => void,
  auth: Auth | undefined,
  stderr: (chunk: Buffer) => void,
  share: ShareOptions | undefined,
  guard: Guard | undefined,
): { transport: Transport; lastError: () => string; child?: ChildTransport } => {
  if (server.kind === 'http') return { transport: new HttpTransport(server, onSessionEnd, auth), lastError: () => '' }
  // With sharing on, a shared or per-folder server has one child in the broker and never a child of this process.
  const class_ = share === undefined ? undefined : classify(key, server, share.bridges)
  if (share !== undefined && class_ !== undefined && class_.class !== 'session') {
    // The stderr text of the shared child reaches the same `stderr` as that of a direct child, and nothing else.
    let tail = ''
    return {
      transport: new BrokerTransport({
        home: share.home,
        brokerFile: share.brokerFile,
        entry: entryOf(server, class_, { home: share.home, folder: share.folder }),
        onStderr: chunk => {
          stderr(chunk)
          tail = (tail + chunk.toString('utf8')).slice(-2000)
        },
      }),
      lastError: () => tail.replace(/\s+/g, ' ').trim().slice(-300),
    }
  }
  // Every stdio child has the transport that stops its whole tree, so a wrapper (`cmd /c`, `sh -c`) never leaves a server
  // that ignores EOF. The SDK transport ends only the wrapper. A lazy child also counts its open requests.
  const transport = new ChildTransport({
    command: server.command,
    args: server.args,
    env: childEnv(server),
    ...(server.cwd !== undefined && { cwd: server.cwd }),
    ...(guard !== undefined && { guard }),
  })
  let tail = ''
  transport.stderr.on('data', (chunk: Buffer) => {
    stderr(chunk)
    tail = (tail + chunk.toString('utf8')).slice(-2000)
  })
  const lastError = () => tail.replace(/\s+/g, ' ').trim().slice(-300)
  return { transport, lastError, child: transport }
}

/**
 * Why the cwd of a stdio server cannot be its folder, or undefined when it can. Without this check, the spawn of a
 * child in a missing folder fails with "spawn <command> ENOENT", which blames the command.
 */
const cwdProblem = async (server: Live): Promise<string | undefined> => {
  if (server.kind !== 'stdio' || server.cwd === undefined) return undefined
  try {
    return (await fs.promises.stat(server.cwd)).isDirectory() ? undefined : `its cwd is not a folder: ${server.cwd}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `its cwd folder does not exist: ${server.cwd}`
    return `cannot read its cwd folder: ${errorText(err)}`
  }
}

/** The in-memory link to the built-in Workspace, or the reason that it is not there. Each attempt makes a new link. */
const workspaceTransport = async (
  pending: WorkspaceLink | Promise<WorkspaceLink> | undefined,
): Promise<{ transport: Transport; lastError: () => string; child?: ChildTransport }> => {
  // The link can wait for the roots of the client (issue #150): no call runs before the root is settled.
  const link = await pending
  if (link === undefined) throw new OwnError('the built-in Workspace is not available in this process')
  if (!link.ok) throw new OwnError(link.reason)
  return { transport: await link.serve(), lastError: () => '' }
}

/** `cut` runs when the list has more than MAX_PAGES pages. The whole list has CONNECT_TIMEOUT_MS. */
export const listAll = async (client: HostClient, cut = () => {}): Promise<DownstreamTool[]> => {
  const tools: DownstreamTool[] = []
  const end = performance.now() + CONNECT_TIMEOUT_MS
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const timeout = Math.max(0, end - performance.now())
    const result = await listToolsPage(client, cursor, { timeout })
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
  /** The longest wait in ms of `settled` and `settledFor` after the start: a test sets it. */
  readonly firstWaitMs?: number
  /** The longest time in ms of the whole connect of one server: CONNECT_TIMEOUT_MS unless a test sets it. */
  readonly connectTimeoutMs?: number
  /** The longest wait in ms of a caller for a connect that is not a wake: RETRY_WAIT_MS unless a test sets it. */
  readonly retryWaitMs?: number
  /**
   * Gets what each stdio child writes to stderr. The running server passes it on to its own stderr, the log of the
   * client. `toolscript-mcp tools` drops it, so it prints only its own lines. No reason holds that text: `redact` hides
   * only the values of the config, and a child can print a secret from anywhere.
   */
  readonly childStderr?: (chunk: Buffer) => void
  /** The sentence that ends the reason of an untrusted server in place of its error text. */
  readonly unshown?: string
  /** Sharing is on (issue #63): a shared or per-folder stdio server links to the broker. Absent: every child is this process's. */
  readonly share?: ShareOptions
  /** Lazy start is on (decision 028, `TOOLSCRIPT_LAZY` not 0). Absent: every child starts at the session start, as before. */
  readonly lazy?: LazyOptions
  /** The built-in Workspace (issue #144): the link of the entry of kind `workspace`. Absent: that entry fails to connect. */
  readonly workspace?: WorkspaceLink | Promise<WorkspaceLink>
  /** The child guard: each direct stdio child is listed in it, so a host killed with no cleanup does not leave it. Absent: none. */
  readonly guard?: Guard
}

/** The tool lists of lazy servers on disk. The host reads and writes the file; a test gives a fake. */
export type ToolsStore = {
  /** The key of a launch in the cache: a hash, so no argument, env value or path is on disk. */
  readonly key: (server: StdioServer) => string
  /** The cache as it is on disk. Never rejects: a file that cannot be read gives an empty cache. */
  readonly load: () => Promise<ToolsCache>
  /** Merges one entry into the file. Never rejects. */
  readonly save: (id: string, tools: readonly DownstreamTool[]) => Promise<void>
}

export type LazyOptions = {
  readonly bridges: Bridges
  /** The idle time in ms: a server with no open request for this long stops. */
  readonly idleMs: number
  readonly cache: ToolsStore
}

/** What a link needs to use the broker. `brokerFile` is undefined for a run from source: each shared link then fails. */
export type ShareOptions = {
  readonly bridges: Bridges
  readonly home: string
  /** The folder of this session: where a per-folder server runs. */
  readonly folder: string
  readonly brokerFile: string | undefined
}

export const connectAll = (
  servers: ReadonlyMap<ServerKey, ServerEntry>,
  version: string,
  log: (line: string) => void,
  {
    home = os.homedir(),
    login = key => loginCommand(NPX_LAUNCH, process.platform, key),
    now = Date.now,
    refreshTimeoutMs = REFRESH_TIMEOUT_MS,
    listFloorMs = LIST_FLOOR_MS,
    firstWaitMs = FIRST_WAIT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    retryWaitMs = RETRY_WAIT_MS,
    childStderr = chunk => void process.stderr.write(chunk),
    unshown = UNSHOWN,
    share,
    lazy,
    workspace,
    guard,
  }: ConnectOptions = {},
): Downstream => {
  let closing: Promise<void> | undefined
  const links = new Map<ServerKey, Link>()
  // The start times of the attempts of each server in the last window.
  const attempts = new Map<ServerKey, number[]>()
  const opened = new Set<HostClient>()
  // The time of the last list of each server for a name that its list lacked.
  const missed = new Map<ServerKey, number>()

  // The cache on disk, read once at the start, and the lists that this process remembered since.
  const lazyServer = (key: ServerKey, server: ServerEntry): server is StdioServer =>
    lazy !== undefined && isLazy(key, server, lazy.bridges, true)
  // The file is read only when a lazy server exists.
  const cache = [...servers].some(([key, server]) => server.kind !== 'invalid' && lazyServer(key, server))
    ? lazy!.cache.load().then(loaded => new Map(loaded))
    : undefined
  // The keys whose current attempt is a wake: a caller waits up to CONNECT_TIMEOUT_MS for it.
  const waking = new Set<ServerKey>()
  // The children of lazy servers: a shutdown hurries their stop.
  const children = new Set<ChildTransport>()

  const connect = async (key: ServerKey, server: Live, woke = false): Promise<void> => {
    const began = performance.now()
    const client = newClient({ name: 'toolscript-mcp', version })
    opened.add(client)
    let secrets = (): readonly string[] => []
    // The built-in Workspace holds no secret of a config, and its reasons are our own text.
    const hide: Hide = text => (server.kind === 'workspace' ? text : redact(text, server, secrets()))
    const lazily = lazy !== undefined && lazyServer(key, server)
    // `hidden`: the start of the reason without the error text of the server or its child, when it holds such text.
    const fail = (reason: string, hidden?: string, final?: true) => {
      const safe = hide(reason)
      log(`${key}: failed: ${safe}`)
      links.set(key, {
        status: 'failed',
        reason: safe,
        sealed: hidden === undefined ? safe : `${hidden}. ${unshown}`,
        ...(final && { final }),
      })
    }
    let unbound = false
    // Only while this client is still the link of `key`: a late event of an old client changes nothing.
    const lost = (reason: string, hidden?: string): boolean => {
      const link = links.get(key)
      if (closing || link?.status !== 'connected' || link.client !== client) return false
      // A lazy server that is lost is asleep again with its last live list: a search does not start it, and the next
      // call wakes it (the cap of attempts applies). A server that fails to wake stays failed, with its reason.
      if (lazily) {
        const stopping = client.close().catch(() => {})
        links.set(key, { status: 'asleep', tools: link.lists.tools(), stopping })
        log(`${key}: lost: ${hide(reason)}. It is asleep and starts on the next call that names it`)
        return true
      }
      fail(reason, hidden)
      return true
    }
    // The SDK HTTP transport fires onclose only from close(), so a server that
    // restarted shows only as an error of a request. The link fails before
    // that request rejects, and the next use connects again.
    const sessionEnded = (err: Error) => {
      const ended = isOAuthStop(err)
        ? lost(err.message)
        : lost(`the HTTP session ended: ${sdkErrorText(err)}`, 'the HTTP session ended')
      if (!ended) return
      // Later, so the failed request rejects with its own error first: close()
      // rejects each open request with "Connection closed".
      setImmediate(() => void client.close().catch(() => {}))
    }
    const cacheId = lazily ? lazy.cache.key(server) : undefined
    // Each list that differs from the cached one goes to the cache. The cache is for display only.
    const remember = async (tools: readonly DownstreamTool[]): Promise<void> => {
      const known = await cache
      if (known === undefined || cacheId === undefined) return
      const old = known.get(cacheId)
      if (old !== undefined && sameTools(old.tools, tools)) return
      const kept = cachedTools(tools)
      known.set(cacheId, { at: Date.now(), tools: kept })
      await lazy!.cache.save(cacheId, kept)
    }
    const list = async () => {
      const tools = await listAll(client, () =>
        log(`${key}: the tool list has more than ${MAX_PAGES} pages, so toolscript-mcp uses the first ${MAX_PAGES}`),
      )
      remember(tools).catch(() => {})
      return tools
    }
    // A server whose tools change, also in their marks, says so: list again, so the checks of a call see the new list.
    // A change before the lists start, in the connect or in its list, lists once more after it.
    let lists: Lists | undefined
    let early = false
    onToolListChanged(client, () => (lists === undefined ? void (early = true) : lists.changed()))
    let lastError = () => ''
    let started: ChildTransport | undefined
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
      if (problem !== undefined) throw new OwnError(problem)
      // close() closes only the clients that it sees: a shutdown during the check must not start a process after it.
      if (closing) throw new OwnError('toolscript-mcp is shutting down')
      const made =
        server.kind === 'workspace'
          ? await workspaceTransport(workspace).catch(err => {
              unbound = true
              throw err
            })
          : transportOf(key, server, sessionEnded, auth, childStderr, share, guard)
      lastError = made.lastError
      if (made.transport instanceof HttpTransport && !auth) secrets = made.transport.secrets
      if (made.child !== undefined) {
        children.add(made.child)
        started = made.child
        // A shutdown that began before this child started hurries it at once.
        if (closing) made.child.hurry()
      }
      // The SDK limits only the initialize request, so a server that never answers the next step stays connecting.
      // The limit starts when `start()` ends: a shared server has its own limits for the broker and the child in it.
      let timer: NodeJS.Timeout | undefined
      let arm!: () => void
      const expired = new Promise<never>((_, reject) => {
        arm = () => {
          timer = setTimeout(
            () => reject(new OwnError(`the connect did not finish within ${connectTimeoutMs / 1000} s`)),
            connectTimeoutMs,
          )
        }
      })
      const start = made.transport.start.bind(made.transport)
      made.transport.start = async () => {
        await start()
        arm()
      }
      const connecting = client.connect(made.transport, { timeout: connectTimeoutMs })
      try {
        await Promise.race([connecting, expired])
      } finally {
        clearTimeout(timer)
        connecting.catch(() => {})
      }
      const first = await list()
      // The old list can lack a new mark, so lists that stop fail the link, and the next use connects and lists anew.
      lists = startLists(
        first,
        list,
        (reason, sealed) => lost(reason, sealed) && void client.close().catch(() => {}),
        listFloorMs,
      )
      if (early) lists.changed()
      // The idle clock of a lazy server runs while it is connected with no open request, and each message sets it back.
      let last = performance.now()
      let idle: NodeJS.Timeout | undefined
      const check = () => {
        const link = links.get(key)
        if (closing || link?.status !== 'connected' || link.client !== client) return
        const wait = made.child!.open > 0 ? lazy!.idleMs : last + lazy!.idleMs - performance.now()
        if (wait > 0) return void (idle = setTimeout(check, wait).unref())
        // The client closes first, and the link is asleep in the same tick: no late event of this client changes it.
        const stopping = client.close().catch(() => {})
        links.set(key, { status: 'asleep', tools: lists!.tools(), stopping })
        log(`${key}: stopped after ${Math.round(lazy!.idleMs / 1000)} s idle`)
      }
      const touch = () => void (last = performance.now())
      if (lazily && made.child !== undefined) {
        made.child.onactivity = touch
        idle = setTimeout(check, lazy!.idleMs).unref()
      }
      links.set(key, { status: 'connected', client, hide, lists, ...(lazily && { touch }) })
      if (woke) log(`${key}: started on first use, ${Math.round(performance.now() - began)} ms, ${first.length} tools`)
      else log(`${key}: connected, ${first.length} tools`)
      client.onclose = () => {
        clearTimeout(idle)
        if (made.child !== undefined) children.delete(made.child)
        opened.delete(client)
        const stderr = lastError()
        if (stderr === '') lost('the connection closed')
        else lost(`the connection closed. ${STDERR_UNSHOWN}`, 'the connection closed')
      }
    } catch (err) {
      // A child that exits gives only "Connection closed": its stderr says why.
      const stderr = lastError()
      // After an await: a failure that comes at once must not come before `attempt` marks the link connecting.
      await client.close().catch(() => {})
      opened.delete(client)
      // A closed transport of a failed connect is no child to hurry at the shutdown.
      if (started !== undefined) children.delete(started)
      // A command that could not start: the error of the spawn comes before the close of the child, so it is known here.
      // Its stderr (the text of cmd.exe on Windows) says nothing more, so the reason is the whole text.
      if (started?.spawnReason !== undefined) return fail(started.spawnReason, undefined, unbound || undefined)
      // An error of the connect or the list can hold the text of the server: an HTTP body or a JSON-RPC message.
      // An AwsCredentialsError holds the text of the AWS CLI, not of the server, so an untrusted entry shows it too.
      if (
        isOAuthStop(err) ||
        err instanceof OwnError ||
        err instanceof BrokerError ||
        err instanceof AwsCredentialsError
      )
        fail(
          stderr === '' ? sdkErrorText(err) : `${sdkErrorText(err)}. ${STDERR_UNSHOWN}`,
          undefined,
          unbound || undefined,
        )
      else fail(stderr === '' ? sdkErrorText(err) : `${sdkErrorText(err)}. ${STDERR_UNSHOWN}`, 'the connect failed')
    }
  }

  const recent = (key: ServerKey): number[] =>
    (attempts.get(key) ?? []).filter(started => now() - started < ATTEMPT_WINDOW_MS)

  /** The ms until the cap allows the next attempt of `key`: 0 when it allows one now. */
  const capWait = (key: ServerKey): number => {
    const times = recent(key)
    return times.length < MAX_ATTEMPTS ? 0 : times[0]! + ATTEMPT_WINDOW_MS - now()
  }

  /** `after`: the end of the child that this server had, which a wake waits for before it starts a new one. */
  const attempt = (key: ServerKey, server: Live, after?: Promise<void>): Promise<void> => {
    attempts.set(key, [...recent(key), now()])
    const woke = after !== undefined
    if (woke) waking.add(key)
    const done = (async () => {
      await after
      await connect(key, server, woke)
    })().finally(() => waking.delete(key))
    links.set(key, { status: 'connecting', done, since: performance.now() })
    return done
  }

  /** Starts the child of a sleeping lazy server, when the cap allows an attempt, and returns the attempt. */
  const wake = (key: ServerKey): Promise<void> | undefined => {
    const server = servers.get(key)
    const link = links.get(key)
    if (closing || server === undefined || server.kind === 'invalid' || link?.status !== 'asleep' || capWait(key) > 0)
      return undefined
    return attempt(key, server, link.stopping ?? Promise.resolve())
  }

  /** Starts an attempt when `key` failed and the cap allows one, and returns it. */
  const reconnect = (key: ServerKey): Promise<void> | undefined => {
    const server = servers.get(key)
    // An entry with config errors never starts, so it never comes back either.
    if (closing || server === undefined || server.kind === 'invalid') return undefined
    const link = links.get(key)
    if (link?.status !== 'failed' || link.final || capWait(key) > 0) return undefined
    // A lazy server that failed starts again as a wake: a failed link has no child, because `connect` closes its client
    // before it fails the link, so nothing is left to wait for.
    if (lazyServer(key, server)) return attempt(key, server, Promise.resolve())
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
      const wait = attempted
        ? undefined
        : link?.status === 'connecting'
          ? link.done
          : link?.status === 'asleep'
            ? wake(key)
            : reconnect(key)
      if (wait === undefined) return
      attempted = true
      await within(wait, end)
    }
  }

  /** A wake waits for the start of a child: up to CONNECT_TIMEOUT_MS, not RETRY_WAIT_MS. */
  const longWait = (key: ServerKey): boolean => {
    const link = links.get(key)
    const server = servers.get(key)
    return (
      link?.status === 'asleep' ||
      waking.has(key) ||
      (link?.status === 'failed' &&
        !link.final &&
        server !== undefined &&
        server.kind !== 'invalid' &&
        lazyServer(key, server))
    )
  }

  const stateOf = (key: ServerKey, link: Link): ServerState => {
    if (link.status === 'connecting')
      return { key, status: 'connecting', elapsedMs: Math.max(0, performance.now() - link.since) }
    if (link.status === 'connected') return { key, status: 'connected', tools: link.lists.tools() }
    if (link.status === 'asleep') return { key, status: 'asleep', tools: link.tools }
    const wait = closing || link.final ? 0 : capWait(key)
    const note = wait > 0 ? `. toolscript-mcp tries again on next use after ${Math.ceil(wait / 1000)} s` : ''
    // Read at each look: a server can return its first untrusted wrapper after its link failed.
    return { key, status: 'failed', reason: `${untrusted(key) ? link.sealed : link.reason}${note}` }
  }

  const distrusted = new Set<ServerKey>()
  const untrusted = (key: ServerKey): boolean => {
    const server = servers.get(key)
    return distrusted.has(key) || (server !== undefined && server.kind !== 'invalid' && server.untrusted === true)
  }

  // Its errors name keys and variables, never values.
  // The first attempt of each valid server, kept so that `settledFor` can wait for some of them.
  const first = new Map<ServerKey, Promise<void>>()
  const starts = [...servers].map(async ([key, server]) => {
    if (server.kind !== 'invalid') {
      // A lazy server with a cached list starts asleep, with no process. With none, it connects, writes the cache, and
      // sleeps after the idle time.
      const done =
        cache !== undefined && lazyServer(key, server)
          ? cache.then(known => {
              const hit = known.get(lazy!.cache.key(server))
              if (closing) return
              if (hit === undefined) return attempt(key, server)
              links.set(key, { status: 'asleep', tools: hit.tools })
            })
          : attempt(key, server)
      first.set(key, done)
      if (!links.has(key)) links.set(key, { status: 'connecting', done, since: performance.now() })
      return done
    }
    const reason = invalidReason(server.errors)
    log(`${key}: failed: ${reason}`)
    links.set(key, { status: 'failed', reason, sealed: reason })
  })
  const ready = Promise.all(starts)
  const cap = new Promise<void>(r => setTimeout(r, firstWaitMs).unref())
  const settled = Promise.race([ready, cap]).then(() => {})
  return {
    settled,
    settledFor: keys => {
      // A key that is not a valid entry of the config keeps the full wait.
      if (keys.some(key => !first.has(key))) return settled
      return Promise.race([Promise.all(keys.map(key => first.get(key)!)), cap]).then(() => {})
    },
    states: () => [...links].map(([key, link]) => stateOf(key, link)),
    retry: async (keys, signal) => {
      // A search (no keys) starts no lazy server: one that failed to wake shows its reason, and a call wakes it.
      if (keys === undefined) {
        const waits = [...servers].flatMap(([key, server]) =>
          server.kind !== 'invalid' && lazyServer(key, server) ? [] : (reconnect(key) ?? []),
        )
        return within(Promise.all(waits), deadline(signal))
      }
      // Each key has its own deadline: a wake waits longer than a reconnect, and must not give the others its time.
      await Promise.all(
        keys.map(key => {
          const end = deadline(signal, longWait(key) ? connectTimeoutMs : retryWaitMs)
          return within(settle(key, end), end)
        }),
      )
    },
    client: async (key, signal) => {
      if (closing) return { ok: false, reason: 'toolscript-mcp is shutting down' }
      if (!links.has(key)) return { ok: false, reason: `no MCP server "${key}" is connected` }
      const end = deadline(signal, longWait(key) ? connectTimeoutMs : retryWaitMs)
      await settle(key, end)
      const link = links.get(key)!
      if (link.status !== 'connected') return { ok: false, reason: notConnected(stateOf(key, link))! }
      if (!(await link.lists.until(end)))
        return {
          ok: false,
          reason: `the MCP server "${key}" changed its tools, and its new tool list did not come in time. Run the program again`,
        }
      link.touch?.()
      return { ok: true, client: link.client, hide: link.hide, tools: link.lists.tools() }
    },
    relist: async (key, signal) => {
      const link = links.get(key)
      if (link?.status !== 'connected' || now() - (missed.get(key) ?? -Infinity) < MISS_WAIT_MS) return
      missed.set(key, now())
      await link.lists.until(deadline(signal), link.lists.miss())
    },
    untrusted,
    distrust: key => void distrusted.add(key),
    close: () =>
      (closing ??= (() => {
        for (const child of children) child.hurry()
        // A hung AWS CLI is in its own process group, so it would outlive the host.
        return Promise.all([stopCredentialReads(), ...[...opened].map(c => c.close().catch(() => {}))]).then(() => {})
      })()),
  }
}
