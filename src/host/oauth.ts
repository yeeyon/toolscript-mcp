// The OAuth login of HTTP servers. The SDK does the discovery, the client
// registration, PKCE and the token refresh: this file gives it a provider over
// the store, one JSON file per server under ~/.toolscript-mcp/oauth/ that only
// the user reads. `toolscript-mcp login` fills the store. The running server
// only reads it and saves refreshed tokens: it never opens a browser,
// registers a client or starts a login, because stdio carries JSON-RPC and no
// person watches it. No function here logs a token, code, verifier or secret.

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  basicCredentials,
  parseJson,
  refreshReason,
  type ClientSecret,
  type OAuth,
  type ServerKey,
} from '../core/config.ts'
import { oauthFile } from '../core/paths.ts'
import { errorText } from '../core/protocol.ts'

// Both are OAuthErrors: the SDK passes on an OAuthError from a refresh, and starts a login after any other error.
/** The provider of the running server throws this where a person must log in. Its message is the reason. */
export class LoginNeeded extends OAuthError {}
/**
 * The provider of the running server throws this when a refresh failed but was not refused, as when the
 * authorization server is down: the tokens can still work, so the next use tries again. Its message is the reason.
 */
export class RefreshFailed extends OAuthError {}

/** The refresh token that a refresh request of the SDK sends, or undefined for any other request. */
const refreshTokenOf = (init: RequestInit | undefined): string | undefined =>
  init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token'
    ? (init.body.get('refresh_token') ?? '')
    : undefined

/** True for an answer of the token endpoint that refuses the request: the same request gets it again. */
const isRefusal = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429

/** What the store keeps for one server. */
export type Stored = {
  /** The client that login registered, and the redirect URL it registered: the next login listens on its port. */
  readonly client?: { readonly info: OAuthClientInformationMixed; readonly redirectUrl: string }
  readonly tokens?: OAuthTokens
}

/** The store file of a server: its key and a hash of its URL. */
export const storeFile = (home: string, key: ServerKey, url: string): string =>
  oauthFile(home, key, createHash('sha256').update(url).digest('hex').slice(0, 16))

/** True for an http URL on this machine: 127.0.0.1, ::1 or localhost. */
export const isLoopbackHttp = (url: URL): boolean =>
  url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The store in `text`. A part that does not parse is left out, so a broken file asks for a login again. */
const parseStored = (text: string): Stored => {
  const json = parseJson(text)
  const raw = json.ok && isObject(json.value) ? json.value : {}
  const client = isObject(raw.client) ? raw.client : {}
  const info =
    OAuthClientInformationFullSchema.safeParse(client.info).data ??
    OAuthClientInformationSchema.safeParse(client.info).data
  const tokens = OAuthTokensSchema.safeParse(raw.tokens).data
  const { redirectUrl } = client
  // Login listens on the port of this URL, on this machine.
  const loopback = typeof redirectUrl === 'string' && URL.canParse(redirectUrl) && isLoopbackHttp(new URL(redirectUrl))
  return {
    ...(info !== undefined && loopback && { client: { info, redirectUrl } }),
    ...(tokens !== undefined && { tokens }),
  }
}

export const readStore = async (file: string): Promise<Stored> => {
  try {
    return parseStored(await fs.promises.readFile(file, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/**
 * Renames `from` over `to`. Windows refuses it while another reader or writer has `to` open, so it tries again for up
 * to RENAME_WAIT_MS.
 */
const renameOver = async (from: string, to: string): Promise<void> => {
  const start = Date.now()
  for (;;) {
    try {
      return await fs.promises.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || Date.now() - start >= RENAME_WAIT_MS) throw err
      await new Promise(resolve => setTimeout(resolve, RENAME_POLL_MS))
    }
  }
}
const RENAME_WAIT_MS = 1000
const RENAME_POLL_MS = 10

/**
 * Changes the store: a new 0600 file in a 0700 folder, then a rename, so a reader in another process never sees a
 * part of a file. Windows does not apply the modes. A change that gives undefined leaves the store.
 */
const updateStore = async (file: string, change: (stored: Stored) => Stored | undefined): Promise<void> => {
  const dir = path.dirname(file)
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir does not change a folder that exists.
  if (process.platform !== 'win32') await fs.promises.chmod(dir, 0o700)
  const next = change(await readStore(file))
  if (next === undefined) return
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
    await renameOver(temp, file)
  } finally {
    await fs.promises.rm(temp, { force: true })
  }
}

/**
 * The tokens of the store once it gets a refresh token other than `old`, within ROTATE_WAIT_MS: the process that won
 * a race for a rotating refresh token saves the next one just after the authorization server refused it to this one.
 */
const rotated = async (file: string, old: string): Promise<OAuthTokens | undefined> => {
  for (let waited = 0; ; waited += ROTATE_POLL_MS) {
    const { tokens } = await readStore(file)
    if (tokens?.refresh_token !== undefined && tokens.refresh_token !== old) return tokens
    if (waited >= ROTATE_WAIT_MS) return undefined
    await new Promise(resolve => setTimeout(resolve, ROTATE_POLL_MS))
  }
}
const ROTATE_WAIT_MS = 1000
const ROTATE_POLL_MS = 100

/**
 * The refresh of each store file that is in flight in this process. All calls and links of a server wait for one
 * refresh: a rotating refresh token works once, so a second refresh with it is refused.
 */
const refreshes = new Map<string, Promise<OAuthTokens>>()

/**
 * The tokens of the last refresh of each store file that the store did not take, and the refresh token that the store
 * held then, which the refresh used up. This process uses them until the store holds another one, as after a login.
 */
const unsaved = new Map<string, { readonly tokens: OAuthTokens; readonly storeHad: string }>()

/** The provider of `login`: it opens the browser, and keeps the verifier and the state in memory. */
export type LoginMode = {
  readonly kind: 'login'
  readonly redirectUrl: string
  readonly state: string
  readonly open: (url: URL) => void
}
/**
 * The provider of the running server: where a person must log in, it throws LoginNeeded with `reason`. A refresh
 * without an answer in `refreshTimeoutMs` throws RefreshFailed.
 */
export type ServeMode = { readonly kind: 'serve'; readonly reason: string; readonly refreshTimeoutMs: number }

/** Under CONNECT_TIMEOUT_MS of downstream.ts, so a new link fails with the reason of the refresh. */
export const REFRESH_TIMEOUT_MS = 20_000

/**
 * The SDK's provider, the secrets that it handed out so far, for `redact`: a server can echo one in an error, the
 * last client with a secret, for `hideClientSecret`, and `fetch`, which gives the fetch of the transport. The running
 * server answers each refresh in it.
 */
export type Provider = OAuthClientProvider & {
  readonly secrets: () => readonly string[]
  readonly clientSecret: () => ClientSecret | undefined
  readonly fetch: (base: FetchLike) => FetchLike
}

/**
 * The SDK's OAuth provider for one server over its store `file`. In login mode, `tokens` gives only the tokens of
 * this login, so the old tokens stay in the store until the new ones come, and a person can switch accounts.
 */
export const oauthProvider = (file: string, oauth: OAuth, mode: LoginMode | ServeMode): Provider => {
  const login = mode.kind === 'login' ? mode : undefined
  const needLogin = (): never => {
    throw new LoginNeeded(mode.kind === 'serve' ? mode.reason : 'no login in progress')
  }
  // The running server never sends a person to this URL.
  const redirectUrl = login?.redirectUrl ?? 'http://127.0.0.1/callback'
  const fixed = oauth.client && {
    client_id: oauth.client.id,
    ...(oauth.client.secret !== undefined && { client_secret: oauth.client.secret }),
  }
  let verifier: string | undefined
  let fresh: OAuthTokens | undefined
  // The client that this login registered. It goes into the store only with the tokens: the old tokens refresh only
  // with the old client, so a login that ends early leaves both.
  let own: OAuthClientInformationMixed | undefined
  const known = new Set<string>(login ? [login.state] : [])
  const add = (...values: (string | undefined)[]) => {
    for (const value of values) if (value !== undefined) known.add(value)
  }
  const keepTokens = (tokens: OAuthTokens | undefined) => (add(tokens?.access_token, tokens?.refresh_token), tokens)
  let secretClient: ClientSecret | undefined
  const keepClient = (info: OAuthClientInformationMixed | undefined) => {
    if (info?.client_secret) {
      add(info.client_secret, basicCredentials(info.client_id, info.client_secret))
      secretClient = { id: info.client_id, secret: info.client_secret, registered: !fixed }
    }
    return info
  }
  const client = async (): Promise<OAuthClientInformationMixed | undefined> => {
    if (fixed) return fixed
    if (own) return own
    const { client } = await readStore(file)
    // A client with another redirect URL cannot finish this login, so login registers a new one.
    if (login) return client?.redirectUrl === redirectUrl ? client.info : undefined
    return client?.info ?? needLogin()
  }
  // A refresh of the running server with the refresh token `sent`, which saves the new tokens. The SDK reads a refusal
  // without an OAuth error code as a server error and starts a login after it, so this decides on each answer.
  const renew = async (
    send: (signal: AbortSignal) => Promise<Response>,
    sent: string,
    timeoutMs: number,
  ): Promise<OAuthTokens> => {
    // A call that read the tokens before the last refresh saved them sends a refresh token that is used up.
    const now = await current()
    if (now?.refresh_token !== undefined && now.refresh_token !== sent) return now
    // The refresh token in the store now. A login in another process can save other tokens before the answer comes.
    const storeHad = unsaved.get(file)?.storeHad ?? sent
    // Every call and link of the server waits for this refresh, so a token endpoint that never answers must not hold it.
    const signal = AbortSignal.timeout(timeoutMs)
    const silent = () => new RefreshFailed(refreshReason(`the token endpoint did not answer in ${timeoutMs / 1000} s`))
    let response: Response
    try {
      response = await send(signal)
    } catch (err) {
      if (signal.aborted) throw silent()
      // fetch fails with "fetch failed": its cause says why, as "connect ECONNREFUSED".
      throw new RefreshFailed(
        refreshReason(errorText(err instanceof Error && err.cause !== undefined ? err.cause : err)),
      )
    }
    if (response.ok) {
      const answer = OAuthTokensSchema.safeParse(await response.json().catch(() => undefined)).data
      if (answer === undefined && signal.aborted) throw silent()
      // The refresh token in memory was not used up: the next use refreshes with it again.
      if (answer === undefined) return needLogin()
      // The SDK keeps the refresh token when the answer has none, and stamps the authorization server.
      const tokens = { refresh_token: sent, ...answer, ...(now?.issuer !== undefined && { issuer: now.issuer }) }
      try {
        // A login in another process can save during the refresh: its client and tokens stay. The SDK reads the
        // tokens of the next request from the store, not from this answer.
        await updateStore(file, stored =>
          stored.tokens?.refresh_token === storeHad ? { ...stored, tokens } : undefined,
        )
        unsaved.delete(file)
      } catch (err) {
        unsaved.set(file, { tokens, storeHad })
        const cause = (err as NodeJS.ErrnoException).code ?? errorText(err)
        console.error(
          `toolscript-mcp: could not save the refreshed OAuth tokens in ${file} (${cause}). They work until toolscript-mcp stops or the store gets other tokens, as from a login.`,
        )
      }
      return tokens
    }
    if (!isRefusal(response.status)) throw new RefreshFailed(refreshReason(`HTTP ${response.status}`))
    // The tokens in memory are refused too, so the store decides from now on.
    unsaved.delete(file)
    // Another process can have refreshed `sent` first: then the SDK gets the tokens it saved.
    return (await rotated(file, sent)) ?? needLogin()
  }
  const current = async (): Promise<OAuthTokens | undefined> => {
    const kept = unsaved.get(file)
    let tokens: OAuthTokens | undefined
    try {
      tokens = (await readStore(file)).tokens
    } catch (err) {
      // A store that another program holds open still leaves this process the tokens in memory.
      if (kept !== undefined) return kept.tokens
      throw err
    }
    if (kept !== undefined && tokens?.refresh_token === kept.storeHad) return kept.tokens
    unsaved.delete(file)
    return tokens
  }
  const refresh = async (
    send: (signal: AbortSignal) => Promise<Response>,
    sent: string,
    timeoutMs: number,
  ): Promise<Response> => {
    let flight = refreshes.get(file)
    if (flight === undefined) {
      flight = renew(send, sent, timeoutMs).finally(() => refreshes.delete(file))
      refreshes.set(file, flight)
    }
    return Response.json(keepTokens(await flight))
  }
  return {
    secrets: () => [...known],
    clientSecret: () => secretClient,
    fetch: base =>
      mode.kind === 'login'
        ? base
        : (url, init) => {
            const sent = refreshTokenOf(init)
            return sent === undefined
              ? base(url, init)
              : refresh(signal => base(url, { ...init, signal }), sent, mode.refreshTimeoutMs)
          },
    redirectUrl,
    clientMetadata: {
      client_name: 'toolscript-mcp',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(oauth.scopes.length > 0 && { scope: oauth.scopes.join(' ') }),
    },
    // The SDK asks for the state only to start a new authorization: the running server found no refresh token for
    // this authorization server.
    state: () => login?.state ?? needLogin(),
    clientInformation: async () => keepClient(await client()),
    // Only login registers. Without this method, the SDK never registers a client for the running server.
    ...(login &&
      !fixed && {
        saveClientInformation: (info: OAuthClientInformationMixed) => void (own = keepClient(info)),
      }),
    tokens: async () => {
      return keepTokens(login ? fresh : await current())
    },
    saveTokens: async tokens => {
      // The refresh of the running server saved them.
      if (!login) return
      fresh = keepTokens(tokens)
      const client = own && { info: own, redirectUrl }
      await updateStore(file, stored => ({ ...stored, ...(client && { client }), tokens }))
    },
    redirectToAuthorization: url => (login ? login.open(url) : needLogin()),
    saveCodeVerifier: code => {
      if (!login) needLogin()
      verifier = code
      add(code)
    },
    codeVerifier: () => verifier ?? needLogin(),
    // The SDK calls this when the server refused the client or the code. The running server keeps the store: its
    // refusals of a refresh never reach the SDK.
    invalidateCredentials: async scope => {
      if (!login) needLogin()
      if (scope === 'all' || scope === 'tokens') fresh = undefined
      if (scope === 'all' || scope === 'client') {
        if (fixed) throw new Error('the authorization server refused the OAuth client ID and secret of the config')
        // The code works only with the client it was issued to. A stored client goes, so the next login registers.
        if (own === undefined) await updateStore(file, ({ tokens }) => (tokens ? { tokens } : {}))
        throw new Error(
          'the authorization server refused the OAuth client of this login. Run login again: it registers a new one.',
        )
      }
    },
  }
}
