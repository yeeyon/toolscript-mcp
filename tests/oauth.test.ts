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
import { parseConfig, type ServerConfig, type ServerKey } from '../src/core/config.ts'
import { connectAll, type Downstream } from '../src/host/downstream.ts'
import { runLogin } from '../src/host/login.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-oauth-test-'))
const KEY = 'fake' as ServerKey
const STATIC_ID = 'fake-static-id'
const STATIC_SECRET = 'fake-static-secret-0123'
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
  const refresh = new Set<string>()
  const secrets = new Set<string>([STATIC_SECRET])
  const seen = { registrations: 0, authorizations: [] as URL[], tokens: [] as URLSearchParams[], refreshes: 0 }
  const issue = () => {
    const tokens = { access_token: `fake-access-${randomUUID()}`, refresh_token: `fake-refresh-${randomUUID()}` }
    access.add(tokens.access_token)
    refresh.add(tokens.refresh_token)
    secrets.add(tokens.access_token).add(tokens.refresh_token)
    return { ...tokens, token_type: 'Bearer', expires_in: 3600 }
  }
  const mcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (bearer === undefined || !access.has(bearer))
      return void res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
    if (req.method !== 'POST') return void res.writeHead(405).end()
    const server = new McpServer({ name: 'fake-oauth', version: '1.0.0' })
    server.registerTool('ping', { description: 'Ping.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, JSON.parse(await body(req)))
  }
  const token = (form: URLSearchParams, auth: string | undefined, res: http.ServerResponse) => {
    seen.tokens.push(form)
    const basic = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : []
    const clientId = form.get('client_id') ?? decodeURIComponent(basic[0] ?? '')
    const secret = form.get('client_secret') ?? decodeURIComponent(basic[1] ?? '')
    if (!clients.has(clientId) || (clientId === STATIC_ID && secret !== STATIC_SECRET))
      return json(res, 401, { error: 'invalid_client' })
    if (form.get('grant_type') === 'refresh_token') {
      const old = form.get('refresh_token') ?? ''
      if (!refresh.delete(old)) return json(res, 400, { error: 'invalid_grant' })
      seen.refreshes++
      return json(res, 200, issue())
    }
    const code = form.get('code') ?? ''
    const verifier = form.get('code_verifier') ?? ''
    secrets.add(code).add(verifier)
    const grant = codes.get(code)
    codes.delete(code)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (grant?.challenge !== challenge || grant.redirectUri !== form.get('redirect_uri') || grant.clientId !== clientId)
      return json(res, 400, { error: 'invalid_grant' })
    return json(res, 200, issue())
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
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
    if (url.pathname === '/token') return token(new URLSearchParams(await body(req)), req.headers.authorization, res)
    if (url.pathname.startsWith('/mcp')) return mcp(req, res)
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${base}/mcp`,
    seen,
    secrets,
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
  return { home, lines, login, connect, ping, store, storeText, leaks }
}

const PONG = JSON.stringify([{ type: 'text', text: 'pong' }])

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

  test('a callback with a wrong state is refused, and no code is exchanged', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(browser(state => `${state}x`)), 1)
    assert.match(s.lines.join('\n'), /wrong state/)
    assert.equal(fake.seen.tokens.length, 0)
    assert.ok(!s.storeText().includes('access_token'))
    assert.deepEqual(s.leaks(), [])
  })

  test('the store file is for the user only on Linux and macOS', { skip: process.platform === 'win32' }, async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const [file] = s.store()
    assert.equal(fs.statSync(file!).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(file!)).mode & 0o777, 0o700)
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
    assert.match(state?.status === 'failed' ? state.reason : '', /needs an OAuth login.*`toolscript-mcp login fake`/)
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
})
