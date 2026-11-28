// `toolscript-mcp login <server>`: the OAuth login of one HTTP server of the
// config. It listens for the callback on 127.0.0.1, opens the browser at the
// authorization URL, checks the state, gives the code to the SDK, then
// connects and counts the tools. It prints to stderr, as init does. It never
// prints a token, code, verifier or client secret.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  configPath,
  hideClientSecret,
  invalidReason,
  redact,
  serverKey,
  type Env,
  type HttpServer,
  type OAuth,
  type ServerKey,
} from '../core/config.ts'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { printableText } from '../core/policy.ts'
import { errorText } from '../core/protocol.ts'
import { CONNECT_TIMEOUT_MS, listAll, serverFetch } from './downstream.ts'
import { isLoopbackHttp, oauthProvider, readStore, storeFile, type Stored } from './oauth.ts'
import { loadConfig } from './start.ts'

export const LOGIN_USAGE = 'usage: toolscript-mcp login <server> [--config <path>] [--help]'

/** The reason of a failed login. The SDK gives an OAuth error without an error_description an empty message. */
const failure = (err: unknown): string =>
  errorText(err) ||
  (err instanceof OAuthError && err.errorCode
    ? `the authorization server answered ${err.errorCode}`
    : 'no reason given')

// The texts of the SDK errors that login explains. Its errors have no codes.
const NO_REGISTRATION = 'Incompatible auth server: does not support dynamic client registration'
const OTHER_RESOURCE = /^Protected resource (\S+) does not match expected/

const STILL_ASKS = 'the server still asks for a login after the token exchange'

/** A failed step of the login whose message is the whole reason: it did not end in time, or got broken metadata. */
class Reason extends Error {}

/** Why the login of a server that answered without a token did not start, as the end of a sentence. */
const notStarted = (err: unknown, url: string): string => {
  if (err instanceof Reason) return err.message
  const text = failure(err)
  if (text === NO_REGISTRATION)
    return 'its authorization server has no dynamic client registration. Calls that need a token need "clientId" in "oauth": see "OAuth login" in docs/auth.md'
  const other = OTHER_RESOURCE.exec(text)?.[1]
  if (other !== undefined) return `its protected-resource metadata is for ${other}, not ${url}`
  return `the login did not start: ${text.replace(/\.$/, '')}`
}

/**
 * `fetchFn` with every request and its body ending `ms` after this call, as a `Reason` that says that `step` did not
 * end, and each other failure as a plain Error: the SDK reads a TypeError of fetch as a CORS refusal, so a server
 * that is down would look like one without metadata.
 */
const within = (fetchFn: FetchLike, ms: number, step: string): FetchLike => {
  const deadline = AbortSignal.timeout(ms)
  return async (url, init) => {
    try {
      const response = await fetchFn(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      })
      // The SDK reads the body later, so a body that stops would end with a bare abort.
      await response.clone().arrayBuffer()
      return response
    } catch (err) {
      if (deadline.aborted) throw new Reason(`${step} within ${ms / 1000} s (waiting for ${new URL(url).origin})`)
      throw new Error(errorText(err instanceof Error && err.cause !== undefined ? err.cause : err))
    }
  }
}

/** The longest wait for the person to finish the login in the browser. */
const LOGIN_TIMEOUT_MS = 5 * 60_000

export type LoginIo = {
  readonly env: Env
  readonly platform: string
  readonly home: string
  readonly version: string
  readonly print: (text: string) => void
  /** Opens the URL in the browser. A test gives one that follows the redirect. */
  readonly open?: (url: string) => void
  /** The time limit of a connect, and of the steps before the browser opens. CONNECT_TIMEOUT_MS unless a test sets it. */
  readonly timeoutMs?: number
}

/** Opens `url` in the default browser. A failure is silent: login also prints the URL. */
const openBrowser =
  (platform: string) =>
  (url: string): void => {
    const [command, args] =
      platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }

type Callback = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly why: string }

/** Listens on 127.0.0.1:`port` for the one callback of the login. Rejects with EADDRINUSE when the port is taken. */
const listen = async (port: number, state: string) => {
  let settle: (callback: Callback) => void = () => {}
  const answer = new Promise<Callback>(resolve => (settle = resolve))
  let done = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') return void res.writeHead(404).end()
    const reply = (status: number, text: string) =>
      void res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`toolscript-mcp: ${text}\n`)
    if (done) return reply(409, 'this login is over. You can close this tab.')
    const q = url.searchParams
    // The state comes back only from the browser that this login opened. Any local page can send a wrong one, so it
    // gets no answer from the login, which waits on.
    if (q.get('state') !== state) return reply(400, 'login refused: wrong state.')
    done = true
    const error = q.get('error')
    const code = q.get('code')
    if (error !== null || code === null) {
      const detail = q.get('error_description')
      settle({
        ok: false,
        // Text from the browser: printed, it cannot move the cursor, fake a line or turn text around.
        why: printableText(`the authorization server answered ${error ?? 'no code'}${detail ? `: ${detail}` : ''}`),
      })
      return reply(400, 'login failed. See the terminal.')
    }
    settle({ ok: true, code })
    reply(200, 'login done. You can close this tab.')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    answer,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

const plural = (n: number) => `${n} tool${n === 1 ? '' : 's'}`

/** The port of a stored redirect URL. */
const portOf = (url: string | undefined): number | undefined => {
  const port = url === undefined ? '' : new URL(url).port
  return port === '' ? undefined : Number(port)
}

const METADATA_KEYS = ['resource', 'authorization_servers']
/** A cut JSON object with a key of protected-resource metadata. A cut text cannot tell its depth. */
const CUT_METADATA = /^\s*\{[\s\S]*"(?:resource|authorization_servers)"\s*:/

/** True when `text` is a JSON object with a top-level key of protected-resource metadata, or a cut one. */
const metadataLike = (text: string): boolean => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return CUT_METADATA.test(text)
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    METADATA_KEYS.some(key => Object.hasOwn(value, key))
  )
}

/** The text of a failed parse of metadata on one line. The SDK throws a zod error, whose message is JSON. */
const invalidText = (err: unknown): string => {
  const issues = (err as { issues?: unknown } | undefined)?.issues
  return Array.isArray(issues)
    ? (issues as { path: unknown[]; message: string }[]).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    : failure(err)
}

/**
 * True when the server publishes protected-resource metadata, so it takes OAuth even if it answered without a token.
 * False when its well-known URLs answer with none: a 3xx, a 4xx or a body that is not metadata, as an HTML page. No
 * answer, a 5xx, 408 or 429 tells nothing about the server, so it rejects. A JSON object with a key of the metadata
 * that does not parse is broken metadata, so it rejects too.
 */
const takesOAuth = async (url: string, fetchFn: FetchLike): Promise<boolean> => {
  let unsure = false
  let sawMetadata = false
  const watched: FetchLike = (to, init) =>
    fetchFn(to, init).then(
      async response => {
        if (response.status >= 500 || response.status === 408 || response.status === 429) unsure = true
        if (response.ok && metadataLike(await response.clone().text())) sawMetadata = true
        return response
      },
      err => {
        unsure = true
        throw err
      },
    )
  try {
    await discoverOAuthProtectedResourceMetadata(url, undefined, watched)
    return true
  } catch (err) {
    if (sawMetadata) throw new Reason(`its protected-resource metadata is not valid: ${invalidText(err)}`)
    if (unsure) throw err
    return false
  }
}

type Found = { readonly key: ServerKey; readonly server: HttpServer; readonly oauth: OAuth }

/** The HTTP server `name` of the config and its OAuth entry, or why it cannot log in. */
const serverOf = (name: string, file: string, io: LoginIo): Found | string => {
  const loaded = loadConfig(file, io.env, io.platform)
  if (!loaded.ok) return loaded.lines.join('\n')
  const key = serverKey(name)
  const entry = key === undefined ? undefined : loaded.config.servers.get(key)
  if (key === undefined || entry === undefined) return `the config ${file} has no server "${name}"`
  if (entry.kind === 'invalid') return `${name}: ${invalidReason(entry.errors)}`
  if (entry.kind === 'stdio') return `${name} is a stdio server. Only an HTTP server logs in with OAuth.`
  if (entry.kind === 'workspace') return `${name} is the built-in Workspace. It needs no login.`
  if (entry.sigv4 !== undefined)
    return `${name} signs its requests with AWS credentials (SigV4), so it needs no login. For an SSO profile, run: aws sso login --profile ${entry.sigv4.profile}`
  if (entry.oauth === undefined)
    return `${name} does not log in with OAuth: it has headers, or "oauth": false. To log in, remove an Authorization header and set "oauth": true.`
  return { key, server: entry, oauth: entry.oauth }
}

/** Runs login with these arguments and returns the exit code. */
export const runLogin = async (args: readonly string[], io: LoginIo): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    })
  } catch (err) {
    io.print(`${errorText(err)}\n${LOGIN_USAGE}`)
    return 2
  }
  if (parsed.values.help) {
    io.print(LOGIN_USAGE)
    return 0
  }
  const [name, ...rest] = parsed.positionals
  if (name === undefined || rest.length > 0) {
    io.print(LOGIN_USAGE)
    return 2
  }
  const file = path.resolve(configPath(parsed.values.config, io.env, io.platform, io.home))
  const found = serverOf(name, file, io)
  if (typeof found === 'string') {
    io.print(found)
    return 1
  }
  const { key, server, oauth } = found
  const store = storeFile(io.home, key, server.url)
  const state = randomBytes(32).toString('base64url')
  const kept = portOf((await readStore(store).catch(() => ({}) as Stored)).client?.redirectUrl)
  const port = oauth.callbackPort ?? kept ?? 0

  let callback: Awaited<ReturnType<typeof listen>>
  try {
    callback = await listen(port, state).catch(err => {
      // A taken port of a registered client: register a new client on a free port.
      if (oauth.callbackPort === undefined && kept !== undefined) return listen(0, state)
      throw err
    })
  } catch (err) {
    io.print(`cannot listen for the login callback on 127.0.0.1:${port}: ${errorText(err)}`)
    return 1
  }

  const open = io.open ?? openBrowser(io.platform)
  /** Set after the token exchange: one login opens one authorization. */
  let exchanged = false
  const provider = oauthProvider(store, oauth, {
    kind: 'login',
    redirectUrl: `http://127.0.0.1:${callback.port}/callback`,
    state,
    open: url => {
      if (exchanged) throw new Error(STILL_ASKS)
      // The URL comes from the metadata of the server. The browser opener also runs files and custom schemes.
      if (url.protocol !== 'https:' && !isLoopbackHttp(url))
        throw new Error(
          'the authorization URL from the server is not https, or http on 127.0.0.1, ::1 or localhost, so login did not open it',
        )
      io.print(`Log in to ${key} in the browser. If the browser does not open, open this URL:\n${url.href}`)
      open(url.href)
    },
  })
  const limitMs = io.timeoutMs ?? CONNECT_TIMEOUT_MS
  const serverUrl = new URL(server.url).href
  const plain = serverFetch(server)
  /** A transport that sends its MCP requests plainly and its authorization steps with `authFetch`. */
  const connect = async (authFetch: FetchLike = plain) => {
    // Login never reads the stream of server messages. A 401 to its GET would start a second authorization beside the
    // one of a request or of login itself: a second registration and browser tab, of which only the last works. A GET
    // with Last-Event-ID resumes the stream of a request, which can carry the answer, so it goes to the server, but a
    // 401 to it becomes a 403: the SDK starts an authorization on a 401 to a GET, and retries it once.
    const fetchFn: FetchLike = (url, init) =>
      new URL(url).href !== serverUrl
        ? authFetch(url, init)
        : init?.method !== 'GET'
          ? plain(url, init)
          : new Headers(init.headers).has('last-event-id')
            ? plain(url, init).then(r => (r.status === 401 ? new Response(null, { status: 403 }) : r))
            : Promise.resolve(new Response(null, { status: 405 }))
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider, fetch: fetchFn })
    const client = new Client({ name: 'toolscript-mcp', version: io.version })
    try {
      await client.connect(transport, { timeout: limitMs })
      return { client, transport }
    } catch (err) {
      await client.close().catch(() => {})
      if (err instanceof UnauthorizedError) return { transport }
      throw err
    }
  }

  let timer: NodeJS.Timeout | undefined
  let client: Client | undefined
  let code: string | undefined
  // A server can echo the request in an error: the state, the code, the verifier, the client secret or a token.
  const hide = (text: string) =>
    hideClientSecret(
      redact(text, server, [...provider.secrets(), ...(code === undefined ? [] : [code])]),
      provider.clientSecret(),
    )
  try {
    // The authorization steps of the first transport. The connect bounds the steps that start in it, and each later
    // phase gets a time limit from its start: the steps before the browser, then the token exchange.
    let authFetch = plain
    const first = await connect((url, init) => authFetch(url, init))
    client = first.client
    // A server can answer initialize without a token and 401 to tools/list: the transport then starts the login.
    authFetch = within(plain, limitMs, 'the login did not start')
    const listed =
      client === undefined
        ? undefined
        : await listAll(client).catch(err => {
            if (err instanceof UnauthorizedError) return undefined
            throw err
          })
    await client?.close()
    client = undefined
    if (listed !== undefined) {
      const tools = plural(listed.length)
      // These steps run outside a connect, so they share one time limit: a stalled well-known URL ends the login.
      const fetchFn = within(plain, limitMs, 'the login did not start')
      try {
        if (!(await takesOAuth(server.url, fetchFn))) {
          io.print(`${key} needs no login: it answered without a token. It has ${tools}.`)
          return 0
        }
        // The server asks for a token only on a tool call, as Google Workspace does, so no 401 started the login.
        await auth(provider, { serverUrl: server.url, fetchFn })
      } catch (err) {
        // Exit 1: the server takes OAuth tokens and login stored none, so its calls that need one still fail.
        io.print(
          hide(
            `login to ${key} failed: it answered without a token and has ${tools}, but ${notStarted(err, server.url)}. No tokens were stored.`,
          ),
        )
        return 1
      }
    }
    const timeout = new Promise<Callback>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, why: 'no login in the browser in 5 minutes' }), LOGIN_TIMEOUT_MS)
    })
    const answer = await Promise.race([callback.answer, timeout])
    if (!answer.ok) {
      io.print(`login to ${key} failed: ${hide(answer.why)}`)
      return 1
    }
    code = answer.code
    authFetch = within(plain, limitMs, 'the token exchange did not end')
    await first.transport.finishAuth(code)
    exchanged = true
    client = (await connect()).client
    if (client === undefined) throw new Error(STILL_ASKS)
    const tools = await listAll(client)
    const mode = io.platform === 'win32' ? '' : ' (mode 0600)'
    io.print(`Logged in to ${key}. It has ${plural(tools.length)}. The tokens are in ${store}${mode}.`)
    return 0
  } catch (err) {
    io.print(`login to ${key} failed: ${hide(failure(err))}`)
    return 1
  } finally {
    clearTimeout(timer)
    callback.close()
    await client?.close().catch(() => {})
  }
}
