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
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { basicCredentials, parseJson, type OAuth, type ServerKey } from '../core/config.ts'
import { oauthFile } from '../core/paths.ts'

/** The provider of the running server throws this where a person must log in. Its message is the reason. */
export class LoginNeeded extends Error {}

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
 * Changes the store: a new 0600 file in a 0700 folder, then a rename, so a reader in another process never sees a
 * part of a file. Windows does not apply the modes.
 */
const updateStore = async (file: string, change: (stored: Stored) => Stored): Promise<void> => {
  const dir = path.dirname(file)
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir does not change a folder that exists.
  if (process.platform !== 'win32') await fs.promises.chmod(dir, 0o700)
  const text = JSON.stringify(change(await readStore(file)), null, 2)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temp, text, { mode: 0o600, flag: 'wx' })
    await fs.promises.rename(temp, file)
  } finally {
    await fs.promises.rm(temp, { force: true })
  }
}

/** The provider of `login`: it opens the browser, and keeps the verifier and the state in memory. */
export type LoginMode = {
  readonly kind: 'login'
  readonly redirectUrl: string
  readonly state: string
  readonly open: (url: URL) => void
}
/** The provider of the running server: where a person must log in, it throws LoginNeeded with `reason`. */
export type ServeMode = { readonly kind: 'serve'; readonly reason: string }

/** The SDK's provider, and the secrets that it handed out so far, for `redact`: a server can echo one in an error. */
export type Provider = OAuthClientProvider & { readonly secrets: () => readonly string[] }

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
  // The client of this login, once it registered one or dropped the stored one. It goes into the store only with the
  // tokens: the old tokens refresh only with the old client, so a login that ends early leaves both.
  let own: { readonly info?: OAuthClientInformationMixed } | undefined
  const known = new Set<string>(login ? [login.state] : [])
  const add = (...values: (string | undefined)[]) => {
    for (const value of values) if (value) known.add(value)
  }
  const keepTokens = (tokens: OAuthTokens | undefined) => (add(tokens?.access_token, tokens?.refresh_token), tokens)
  const keepClient = (info: OAuthClientInformationMixed | undefined) => {
    if (info?.client_secret) add(info.client_secret, basicCredentials(info.client_id, info.client_secret))
    return info
  }
  const client = async (): Promise<OAuthClientInformationMixed | undefined> => {
    if (fixed) return fixed
    if (own) return own.info
    const { client } = await readStore(file)
    // A client with another redirect URL cannot finish this login, so login registers a new one.
    if (login) return client?.redirectUrl === redirectUrl ? client.info : undefined
    return client?.info ?? needLogin()
  }
  return {
    secrets: () => [...known],
    redirectUrl,
    clientMetadata: {
      client_name: 'toolscript-mcp',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(oauth.scopes.length > 0 && { scope: oauth.scopes.join(' ') }),
    },
    state: () => login?.state ?? needLogin(),
    clientInformation: async () => keepClient(await client()),
    // Only login registers. Without this method, the SDK never registers a client for the running server.
    ...(login &&
      !fixed && {
        saveClientInformation: (info: OAuthClientInformationMixed) => void (own = { info: keepClient(info) }),
      }),
    tokens: async () => keepTokens(login ? fresh : (await readStore(file)).tokens),
    saveTokens: async tokens => {
      fresh = keepTokens(tokens)
      const client = own?.info && { info: own.info, redirectUrl }
      await updateStore(file, stored => ({ ...stored, ...(client && { client }), tokens }))
    },
    redirectToAuthorization: url => (login ? login.open(url) : needLogin()),
    saveCodeVerifier: code => {
      if (!login) needLogin()
      verifier = code
      add(code)
    },
    codeVerifier: () => verifier ?? needLogin(),
    // The SDK calls this when the server refused the client or the refresh token. The running server keeps the
    // store: another process can have saved new tokens since this one read them.
    invalidateCredentials: async scope => {
      if (!login) needLogin()
      if (scope === 'all' || scope === 'tokens') fresh = undefined
      if (scope === 'all' || scope === 'client') own = {}
    },
  }
}
