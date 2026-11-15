// The OAuth login of HTTP servers, against a fake OAuth and MCP server made
// with node:http: protected-resource and authorization-server metadata,
// /register, /authorize that redirects to the callback, /token that checks the
// PKCE verifier and refreshes, and an MCP endpoint that answers 401 without a
// valid Bearer token. `runLogin` gets a browser that follows the redirect.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { parseConfig, type Config, type ServerConfig, type ServerKey } from '../src/core/config.ts'
import { newKept } from '../src/core/protocol.ts'
import { connectAll, type Downstream } from '../src/host/downstream.ts'
import { runLogin } from '../src/host/login.ts'
import { storeFile } from '../src/host/oauth.ts'
import { runCode, type RunContext } from '../src/host/run.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-oauth-test-'))
const KEY = 'fake' as ServerKey
const STATIC_ID = 'fake-static-id'
// A space and the characters that a URL, an HTML form and base64 each write in their own way.
const STATIC_SECRET = 'fake static secret+/=0123'
/** The static secret as an error can echo it: in a form, in a URL and in a Basic Authorization header. */
const STATIC_FORMS = [
  new URLSearchParams({ s: STATIC_SECRET }).toString().slice(2),
  encodeURIComponent(STATIC_SECRET),
  Buffer.from(`${STATIC_ID}:${STATIC_SECRET}`).toString('base64'),
]
const opened: Downstream[] = []
const servers: http.Server[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  for (const s of servers) (s.closeAllConnections(), s.close())
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

const body = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const json = (res: http.ServerResponse, status: number, value: unknown) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))

/** The fake server. Every token, code and verifier it sees goes into `secrets`, so a test can look for leaks. */
const startFake = async () => {
  let base = ''
  const clients = new Map<string, { redirectUris: string[] }>([[STATIC_ID, { redirectUris: [] }]])
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  const access = new Set<string>()
  /** Each refresh token and the client it was issued to. */
  const refresh = new Map<string, string>()
  const secrets = new Set<string>([STATIC_SECRET, ...STATIC_FORMS])
  const seen = {
    registrations: 0,
    authorizations: [] as URL[],
    tokens: [] as URLSearchParams[],
    refreshes: 0,
    requests: [] as { origin: string; path: string; header: string | string[] | undefined }[],
  }
  /**
   * What a test changes in the answers of the fake. `authServer` is another origin of the fake for its OAuth part.
   * `echo` makes one kind of request fail with an error that echoes its secrets: a call, any MCP request, a refresh
   * or the code exchange. `authMethods` are the client authentications that the token endpoint takes. With
   * `rejectAll`, the MCP endpoint answers 401 to every token. The token endpoint waits for `holdRefreshes` refresh
   * requests before it answers the first, so two clients use one refresh token. With `tokenDown`, the token endpoint
   * drops each connection.
   */
  const change = {
    authorizationEndpoint: '',
    authServer: '',
    echo: '' as '' | 'call' | 'mcp' | 'refresh' | 'exchange',
    authMethods: ['none', 'client_secret_post', 'client_secret_basic'],
    rejectAll: false,
    holdRefreshes: 0,
    tokenDown: false,
  }
  const held: (() => void)[] = []
  const issue = (clientId: string) => {
    const tokens = { access_token: `fake-access-${randomUUID()}`, refresh_token: `fake-refresh-${randomUUID()}` }
    access.add(tokens.access_token)
    refresh.set(tokens.refresh_token, clientId)
    secrets.add(tokens.access_token).add(tokens.refresh_token)
    return { ...tokens, token_type: 'Bearer', expires_in: 3600 }
  }
  const mcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (bearer === undefined || !access.has(bearer) || change.rejectAll)
      return void res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
    if (req.method !== 'POST') return void res.writeHead(405).end()
    const message = JSON.parse(await body(req)) as { method?: string }
    if (change.echo === 'mcp' || (change.echo === 'call' && message.method === 'tools/call'))
      return void res.writeHead(500).end(`boom for Bearer ${bearer}`)
    const server = new McpServer({ name: 'fake-oauth', version: '1.0.0' })
    server.registerTool('ping', { description: 'Ping.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, message)
  }
  const token = async (text: string, auth: string | undefined, res: http.ServerResponse) => {
    const form = new URLSearchParams(text)
    seen.tokens.push(form)
    if (form.get('grant_type') === 'refresh_token' && change.holdRefreshes > 0)
      await new Promise<void>(resolve => {
        held.push(resolve)
        if (held.length < change.holdRefreshes) return
        change.holdRefreshes = 0
        for (const release of held.splice(0)) release()
      })
    if (change.echo === 'exchange' && form.get('grant_type') === 'authorization_code') {
      secrets.add(form.get('code') ?? '').add(form.get('code_verifier') ?? '')
      return void res.writeHead(400, { 'content-type': 'text/plain' }).end(`bad request: ${text} ${auth ?? ''}`)
    }
    if (change.echo === 'refresh' && form.get('grant_type') === 'refresh_token')
      return json(res, 400, { error: 'invalid_request', error_description: `bad ${form.get('refresh_token')}` })
    const basic = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : []
    const clientId = form.get('client_id') ?? decodeURIComponent(basic[0] ?? '')
    const secret = form.get('client_secret') ?? decodeURIComponent(basic[1] ?? '')
    if (!clients.has(clientId) || (clientId === STATIC_ID && secret !== STATIC_SECRET))
      return json(res, 401, { error: 'invalid_client' })
    if (form.get('grant_type') === 'refresh_token') {
      const old = form.get('refresh_token') ?? ''
      if (refresh.get(old) !== clientId) return json(res, 400, { error: 'invalid_grant' })
      refresh.delete(old)
      seen.refreshes++
      return json(res, 200, issue(clientId))
    }
    const code = form.get('code') ?? ''
    const verifier = form.get('code_verifier') ?? ''
    secrets.add(code).add(verifier)
    const grant = codes.get(code)
    codes.delete(code)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (grant?.challenge !== challenge || grant.redirectUri !== form.get('redirect_uri') || grant.clientId !== clientId)
      return json(res, 400, { error: 'invalid_grant' })
    return json(res, 200, issue(clientId))
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    seen.requests.push({
      origin: `http://${req.headers.host}`,
      path: url.pathname,
      header: req.headers['x-fake-header'],
    })
    const auth = change.authServer || base
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [auth] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: auth,
        authorization_endpoint: change.authorizationEndpoint || `${auth}/authorize`,
        token_endpoint: `${auth}/token`,
        registration_endpoint: `${auth}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: change.authMethods,
      })
    if (url.pathname === '/register') {
      const metadata = JSON.parse(await body(req)) as { redirect_uris: string[] }
      const clientId = `fake-client-${++seen.registrations}`
      clients.set(clientId, { redirectUris: metadata.redirect_uris })
      return json(res, 201, { ...metadata, client_id: clientId })
    }
    if (url.pathname === '/authorize') {
      seen.authorizations.push(url)
      const q = url.searchParams
      const clientId = q.get('client_id') ?? ''
      const redirectUri = q.get('redirect_uri') ?? ''
      const client = clients.get(clientId)
      if (client === undefined || (clientId !== STATIC_ID && !client.redirectUris.includes(redirectUri)))
        return void res.writeHead(400).end('unknown client or redirect_uri')
      const code = `fake-code-${randomUUID()}`
      codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri, clientId })
      const to = new URL(redirectUri)
      to.searchParams.set('code', code)
      to.searchParams.set('state', q.get('state') ?? '')
      return void res.writeHead(302, { location: to.href }).end()
    }
    if (url.pathname === '/token' && change.tokenDown) return void req.socket.destroy()
    if (url.pathname === '/token') return token(await body(req), req.headers.authorization, res)
    if (url.pathname.startsWith('/mcp')) return mcp(req, res)
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${base}/mcp`,
    port: (server.address() as AddressInfo).port,
    seen,
    secrets,
    change,
    /** Every access token stops working, as when they expire. */
    expire: () => access.clear(),
    /** Every refresh token stops working too, as when the person revokes the grant. */
    revoke: () => (access.clear(), refresh.clear()),
  }
}

type Fake = Awaited<ReturnType<typeof startFake>>

/** A browser that follows the authorization redirect to the callback, with the state `change` makes. */
const browser =
  (change: (state: string) => string = s => s) =>
  (url: string) =>
    void (async () => {
      const answer = await fetch(url, { redirect: 'manual' })
      const to = new URL(answer.headers.get('location') ?? '')
      to.searchParams.set('state', change(to.searchParams.get('state') ?? ''))
      await fetch(to)
    })()

/**
 * A browser where the person cancels the login: the callback gets an error, with `error` as its code. It keeps each
 * URL it gets in `opened`.
 */
const cancel =
  (opened: string[] = [], error = 'access_denied') =>
  (url: string) => {
    opened.push(url)
    const q = new URL(url).searchParams
    const to = new URL(q.get('redirect_uri') ?? '')
    to.searchParams.set('error', error)
    to.searchParams.set('error_description', `${error} description`)
    to.searchParams.set('state', q.get('state') ?? '')
    void fetch(to).catch(() => {})
  }

/** A home folder and a config with one HTTP server `fake`. */
const setup = (fake: Fake, entry: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
  const home = fs.mkdtempSync(path.join(DIR, 'home-'))
  const file = path.join(home, 'config.json')
  const text = JSON.stringify({ mcpServers: { [KEY]: { type: 'http', url: fake.url, ...entry } } })
  fs.writeFileSync(file, text)
  const parsed = parseConfig(text, env, process.execPath, process.platform)
  assert.ok(parsed.ok)
  const server = parsed.config.servers.get(KEY) as ServerConfig
  const lines: string[] = []
  const login = (open = browser()) =>
    runLogin([KEY, '--config', file], {
      env,
      platform: process.platform,
      home,
      version: '0',
      print: t => void lines.push(t),
      open,
    })
  const connect = (config: ServerConfig = server) => {
    const downstream = connectAll(new Map([[KEY, config]]), '0', line => void lines.push(line), { home })
    opened.push(downstream)
    return downstream
  }
  /** The text of a run_code run of `code` in the real sandbox, with `downstream`. */
  const run = async (downstream: Downstream, code: string): Promise<string> => {
    const config: Config = {
      servers: new Map(),
      sandbox: { node: process.execPath, timeoutSeconds: 30, callTimeoutSeconds: 30 },
      policy: [{ match: 'mcp__*', action: 'allow', index: 0 }],
      log: false,
    }
    const ctx: RunContext = {
      downstream,
      config,
      kept: newKept(),
      shapes: new Map(),
      filesDir: path.join(home, 'files'),
      ask: async () => 'accept',
      canAsk: () => true,
      signal: new AbortController().signal,
      log: () => {},
      home,
    }
    return (await runCode(ctx, code)).text
  }
  const ping = async (downstream: Downstream): Promise<string> => {
    const link = await downstream.client(KEY)
    if (!link.ok) return link.reason
    const r = await link.client.callTool({ name: 'ping', arguments: {} }).catch((err: Error) => err)
    return r instanceof Error ? r.message : JSON.stringify(r.content)
  }
  const storeDir = path.join(home, '.toolscript-mcp', 'oauth')
  const store = () => fs.readdirSync(storeDir).map(name => path.join(storeDir, name))
  const storeText = () =>
    store()
      .map(f => fs.readFileSync(f, 'utf8'))
      .join('\n')
  /** The lines printed and logged so far that hold a token, code, verifier or client secret. */
  const leaks = () => lines.filter(line => [...fake.secrets].some(s => line.includes(s)))
  return { home, lines, login, connect, run, ping, store, storeText, leaks }
}

const PONG = JSON.stringify([{ type: 'text', text: 'pong' }])
/** The reason of a server that needs a login, with the command as the README installs toolscript-mcp. */
const LOGIN_REASON = /needs an OAuth login.*`npx -y toolscript-mcp login fake`/

describe('login', () => {
  test('login registers a client, gets tokens, and the server then lists and calls the tools', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(fake.seen.registrations, 1)
    assert.match(s.lines.join('\n'), /Logged in to fake\. It has 1 tool\./)
    const downstream = s.connect()
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'connected')
    assert.equal(await s.ping(downstream), PONG)
    assert.deepEqual(s.leaks(), [])
  })

  test('a second login keeps the registered client and its redirect URL', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(fake.seen.registrations, 1)
    const [first, second] = fake.seen.authorizations.map(u => u.searchParams.get('redirect_uri'))
    assert.equal(first, second)
    assert.match(first ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  test('a login that registers a new client and is cancelled keeps the old client and tokens working', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const redirect = fake.seen.authorizations[0]?.searchParams.get('redirect_uri') ?? ''
    // Another program now has the port of the registered redirect URL.
    const taken = http.createServer()
    await new Promise<void>(resolve => taken.listen(Number(new URL(redirect).port), '127.0.0.1', resolve))
    servers.push(taken)
    assert.equal(await s.login(cancel()), 1, s.lines.join('\n'))
    assert.equal(fake.seen.registrations, 2, 'the second login registered a client on a free port')
    fake.expire()
    assert.equal(await s.ping(s.connect()), PONG, 'the old refresh token still refreshes with its own client')
    assert.deepEqual(s.leaks(), [])
  })

  test('a static clientId skips the registration and sends its secret only to the token endpoint', async () => {
    const fake = await startFake()
    const oauth = { clientId: STATIC_ID, clientSecret: '${FAKE_SECRET}' }
    const s = setup(fake, { oauth }, { FAKE_SECRET: STATIC_SECRET })
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(fake.seen.registrations, 0)
    assert.equal(fake.seen.authorizations[0]?.searchParams.get('client_id'), STATIC_ID)
    assert.ok(!s.storeText().includes(STATIC_SECRET), 'the store holds no client secret')
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    assert.deepEqual(s.leaks(), [])
  })

  test('a callback with a wrong or no state is refused, and the right one still logs in', async () => {
    const fake = await startFake()
    const s = setup(fake)
    const refused: number[] = []
    const forge = (url: string) =>
      void (async () => {
        const callback = new URL(new URL(url).searchParams.get('redirect_uri') ?? '')
        callback.searchParams.set('code', 'fake-forged-code')
        refused.push((await fetch(callback)).status)
        callback.searchParams.set('state', 'fake-wrong-state')
        refused.push((await fetch(callback)).status)
        browser()(url)
      })()
    assert.equal(await s.login(forge), 0, s.lines.join('\n'))
    assert.deepEqual(refused, [400, 400])
    assert.deepEqual(
      fake.seen.tokens.map(form => form.get('code') === 'fake-forged-code'),
      [false],
      'only the right code is exchanged',
    )
    assert.deepEqual(s.leaks(), [])
  })

  test('login never prints or opens an authorization URL that is not https or http on loopback', async () => {
    for (const endpoint of ['file:///C:/fake/run.cmd', 'ms-settings:display', 'http://auth.example/authorize']) {
      const fake = await startFake()
      fake.change.authorizationEndpoint = endpoint
      const s = setup(fake)
      const opened: string[] = []
      assert.equal(await s.login(cancel(opened)), 1, endpoint)
      assert.deepEqual(opened, [], endpoint)
      const printed = s.lines.join('\n')
      assert.match(printed, /login to fake failed: the authorization URL .* is not https/, printed)
      assert.ok(!printed.includes(new URL(endpoint).href), printed)
    }
  })

  test('a stored client whose redirect URL is not a loopback http URL is dropped, and login starts fresh', async () => {
    for (const redirectUrl of ['not a url', 'https://fake.example:8765/callback']) {
      const fake = await startFake()
      const s = setup(fake)
      const file = storeFile(s.home, KEY, fake.url)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ client: { info: { client_id: 'fake-old-client' }, redirectUrl } }))
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      assert.equal(fake.seen.registrations, 1)
    }
  })

  test('login prints the error of the callback with its control characters escaped', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(cancel([], 'denied\u001b[2J\r\nfake: Logged in\u009b')), 1)
    const printed = s.lines.join('\n')
    assert.ok(printed.includes('denied\\u001b[2J\\u000d\\u000afake: Logged in\\u009b description'), printed)
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(printed) && !printed.includes('\nfake:'), printed)
  })

  test('the store file is for the user only on Linux and macOS', { skip: process.platform === 'win32' }, async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const [file] = s.store()
    assert.equal(fs.statSync(file!).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file!)).mode & 0o777, 0o700)
  })

  test('the config headers go to the MCP server and never to an authorization server on another origin', async () => {
    const fake = await startFake()
    fake.change.authServer = `http://localhost:${fake.port}`
    const s = setup(fake, { oauth: true, headers: { 'X-Fake-Header': 'fake-header-value-1' } })
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    fake.expire()
    assert.equal(await s.ping(s.connect()), PONG)
    assert.equal(fake.seen.refreshes, 1)
    const at = (origin: string) => fake.seen.requests.filter(r => r.origin === origin && r.path !== '/authorize')
    const mcp = at(new URL(fake.url).origin)
    const auth = at(fake.change.authServer)
    assert.ok(mcp.length > 0 && auth.length > 0)
    assert.deepEqual(new Set(mcp.map(r => r.header)), new Set(['fake-header-value-1']))
    assert.deepEqual(new Set(auth.map(r => r.header)), new Set([undefined]))
  })

  test('login names a server that is not an OAuth HTTP server', async () => {
    const fake = await startFake()
    const s = setup(fake, { headers: { Authorization: 'Bearer fake-header-token-1' } })
    assert.equal(await s.login(), 1)
    assert.match(s.lines.join('\n'), /fake does not log in with OAuth/)
    assert.ok(!s.lines.join('\n').includes('fake-header-token-1'))
  })
})

describe('the running server', () => {
  test('a server with no tokens fails at once with the login command, and registers no client', async () => {
    const fake = await startFake()
    const s = setup(fake)
    const downstream = s.connect()
    const start = Date.now()
    await downstream.settled
    assert.ok(Date.now() - start < 5000, 'no hang')
    const state = downstream.states()[0]
    assert.equal(state?.status, 'failed')
    assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON)
    assert.equal(fake.seen.registrations, 0)
    assert.equal(fake.seen.authorizations.length, 0)
  })

  test('an expired access token refreshes with no login, at connect and during a session', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const before = s.storeText()
    fake.expire()
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    assert.equal(fake.seen.refreshes, 1)
    const refreshed = s.storeText()
    assert.notEqual(refreshed, before, 'the refreshed tokens are in the store')
    fake.expire()
    assert.equal(await s.ping(downstream), PONG)
    assert.equal(fake.seen.refreshes, 2)
    assert.notEqual(s.storeText(), refreshed)
    assert.equal(fake.seen.authorizations.length, 1, 'only the login authorized')
    assert.deepEqual(s.leaks(), [])
  })

  test('a failed refresh asks for a login, and the next use after the login connects without a restart', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.revoke()
    assert.match(await s.ping(downstream), /needs an OAuth login/)
    assert.equal(downstream.states()[0]?.status, 'failed')
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(await s.ping(downstream), PONG)
    assert.deepEqual(s.leaks(), [])
  })

  test('a changed URL never reuses the tokens of the old one', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect({ kind: 'http', url: `${fake.url}?v=2`, headers: {}, oauth: { scopes: [] } })
    assert.match(await s.ping(downstream), /needs an OAuth login/)
  })

  test('a server that answers 401 after a refresh ends the link with the login command', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.change.rejectAll = true
    await s.ping(downstream)
    const state = downstream.states()[0]
    assert.equal(state?.status, 'failed')
    assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON)
    assert.match(await s.ping(downstream), /needs an OAuth login/)
  })

  test('an authorization server that is down during a refresh needs no login, and the next use refreshes', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.tokenDown = true
    await s.ping(downstream)
    const state = downstream.states()[0]
    const reason = state?.status === 'failed' ? state.reason : ''
    assert.match(reason, /^could not refresh the OAuth token: .+\. It tries again on next use/, reason)
    fake.change.tokenDown = false
    assert.equal(await s.ping(downstream), PONG)
    assert.equal(fake.seen.authorizations.length, 1, 'only the login authorized')
  })

  test('two processes that refresh one rotating refresh token at once both go on with no login', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const [one, two] = [s.connect(), s.connect()]
    assert.deepEqual(await Promise.all([s.ping(one), s.ping(two)]), [PONG, PONG])
    fake.expire()
    fake.change.holdRefreshes = 2
    assert.deepEqual(await Promise.all([s.ping(one), s.ping(two)]), [PONG, PONG])
    assert.equal(fake.seen.authorizations.length, 1, 'only the login authorized')
  })
})

describe('secrets that a server echoes', () => {
  const CALL = 'try { return await call("mcp__fake__ping", {}) } catch (e) { return e.message }'
  const leaked = (fake: Fake, text: string) => [...fake.secrets].filter(v => text.includes(v))

  test('an access token in the error of a call is hidden from the program', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    await downstream.settled
    fake.change.echo = 'call'
    const text = await s.run(downstream, CALL)
    assert.match(text, /boom for Bearer \*\*\*/, text)
    assert.deepEqual(leaked(fake, text), [])
  })

  test('an access token in the error of a connect is hidden from the reason and the log', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    fake.change.echo = 'mcp'
    const downstream = s.connect()
    await downstream.settled
    const state = downstream.states()[0]
    const reason = state?.status === 'failed' ? state.reason : ''
    assert.match(reason, /boom for Bearer \*\*\*/, reason)
    assert.deepEqual(leaked(fake, reason), [])
    assert.ok(s.lines.some(line => line.includes('boom for Bearer ***')))
    assert.deepEqual(s.leaks(), [])
  })

  test('a refresh token that the authorization server echoes is hidden from the program', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.echo = 'refresh'
    const text = await s.run(downstream, CALL)
    assert.match(text, /bad \*\*\*/, text)
    assert.deepEqual(leaked(fake, text), [])
  })

  test('login hides the code, the verifier and the client secret that a token endpoint echoes', async () => {
    for (const method of ['client_secret_post', 'client_secret_basic']) {
      const fake = await startFake()
      fake.change.echo = 'exchange'
      fake.change.authMethods = [method]
      const s = setup(
        fake,
        { oauth: { clientId: STATIC_ID, clientSecret: '${FAKE_SECRET}' } },
        { FAKE_SECRET: STATIC_SECRET },
      )
      assert.equal(await s.login(), 1, method)
      const printed = s.lines.join('\n')
      assert.match(printed, /login to fake failed: .*bad request: .*\*\*\*/, printed)
      assert.deepEqual(s.leaks(), [], method)
    }
  })
})
