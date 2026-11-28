// The fake OAuth and MCP server of oauth.test.ts and oauth-lock.test.ts, made with node:http: protected-resource and
// authorization-server metadata, /register, /authorize that redirects to the callback, /token that checks the PKCE
// verifier and refreshes, and an MCP endpoint that answers 401 without a valid Bearer token.

import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer, StreamableHTTPServerTransport } from './sdk.mjs'

export const STATIC_ID = 'fake-static-id'
// A space and the characters that a URL, an HTML form and base64 each write in their own way.
export const STATIC_SECRET = 'fake static secret+/=0123'
/** The static secret as an error can echo it: in a form, in a URL and in a Basic Authorization header. */
export const STATIC_FORMS = [
  new URLSearchParams({ s: STATIC_SECRET }).toString().slice(2),
  encodeURIComponent(STATIC_SECRET),
  Buffer.from(`${STATIC_ID}:${STATIC_SECRET}`).toString('base64'),
]
export const servers: http.Server[] = []

const body = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const json = (res: http.ServerResponse, status: number, value: unknown) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))

/** The fake server. Every token, code and verifier it sees goes into `secrets`, so a test can look for leaks. */
export const startFake = async () => {
  let base = ''
  const clients = new Map<string, { redirectUris: string[] }>([[STATIC_ID, { redirectUris: [] }]])
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  const access = new Set<string>()
  /** The client each access token was issued to, and the refresh tokens that a refresh used up, for reuse detection. */
  const accessOf = new Map<string, string>()
  const used = new Set<string>()
  /** Each refresh token and the client it was issued to. */
  const refresh = new Map<string, string>()
  const secrets = new Set<string>([STATIC_SECRET, ...STATIC_FORMS])
  const seen = {
    registrations: 0,
    /** The body of each registration request, and the content type of each token request. */
    registered: [] as unknown[],
    tokenTypes: [] as (string | undefined)[],
    authorizations: [] as URL[],
    tokens: [] as URLSearchParams[],
    /** The client authentication of each token request that got as far as the client check. */
    methods: [] as string[],
    refreshes: 0,
    /** The refresh requests with a used refresh token that revoked a client, under `reuseDetection`. */
    revocations: 0,
    /** The refresh token that the fake issued last. */
    lastRefresh: '',
    /** The GETs that resumed a stream of `resumeList`. */
    resumes: 0,
    requests: [] as { origin: string; path: string; header: string | string[] | undefined }[],
  }
  /**
   * What a test changes in the answers of the fake. `authServer` is another origin of the fake for its OAuth part.
   * `echo` makes one kind of request fail with an error that echoes its secrets: a call, any MCP request, a refresh
   * or the code exchange. `authMethods` are the client authentications that the token endpoint takes. With
   * `rejectAll`, the MCP endpoint answers 401 to every token. The token endpoint waits for `holdRefreshes` refresh
   * requests before it answers the first, so two clients use one refresh token. With `stallRefreshes`, it never answers
   * a refresh. With `gate`, it answers each refresh only after the gate resolves. With `tokenDown`, the token endpoint drops each connection. `refreshAnswer` answers each refresh. `grantErrorMs` delays each refresh that gets
   * `invalid_grant`. The token endpoint answers `invalid_client` to the client `refuseClient`. A registration answer
   * gives the client `registeredSecret`, if set, and the first of `authMethods`, with the id `registeredId`, if set.
   * `anonymous` lets the MCP
   * requests without a token through: all of them, all but `tools/call`, or all but `tools/list` and `tools/call`.
   * With `streamNeedsToken`, a GET of the stream without a token still gets 401. `resourceMetadata` makes the protected-resource metadata missing (404), never answer, stop in its body, or get
   * another answer. Its resource is `resource`, if set. Without `registration`, the authorization server has no
   * registration endpoint. With `stallServerMetadata`, its metadata never answers. With `stallExchange`, the token
   * endpoint never answers the code exchange. With `resumeList`, a `tools/list` gets a stream with only a priming event
   * that closes, and its answer comes on the GET that resumes the stream with `Last-Event-ID`. With `noRefresh`, the
   * token endpoint issues no refresh token. With `reuseDetection`, a refresh with a refresh token that was used before
   * revokes every access and refresh token of its client, and counts one revocation in `seen.revocations`. The first
   * `abandon` refresh requests get no answer after the gate, and use up no token.
   */
  const change = {
    authorizationEndpoint: '',
    authServer: '',
    echo: '' as '' | 'call' | 'mcp' | 'refresh' | 'exchange',
    authMethods: ['none', 'client_secret_post', 'client_secret_basic'],
    anonymous: '' as '' | 'list' | 'all' | 'initialize',
    streamNeedsToken: false,
    resourceMetadata: 'found' as
      | 'found'
      | 'missing'
      | 'stalled'
      | 'stalled body'
      | { status: number; headers?: Record<string, string>; body?: string },
    resource: '',
    registration: true,
    stallServerMetadata: false,
    stallExchange: false,
    rejectAll: false,
    holdRefreshes: 0,
    stallRefreshes: false,
    gate: undefined as Promise<void> | undefined,
    tokenDown: false,
    refreshAnswer: undefined as { status: number; type: string; body: string } | undefined,
    grantErrorMs: 0,
    refuseClient: '',
    resumeList: false,
    resume401: false,
    noRefresh: false,
    registeredSecret: '',
    registeredId: '',
    reuseDetection: false,
    abandon: 0,
    /** The `iss` of the callback (RFC 9207): none, the issuer of the metadata, or another one. */
    callbackIss: 'none' as 'none' | 'right' | 'wrong',
    /** The metadata says that the authorization server always sends `iss`. */
    issSupported: false,
    /** The `issuer` of the metadata, when it is not the origin that the metadata was read from. */
    metadataIssuer: '',
    /** The token endpoint answers each request with this OAuth error and an error_description that echoes the request. */
    echoError: '' as '' | 'invalid_client' | 'invalid_grant',
  }
  const held: (() => void)[] = []
  const issue = (clientId: string) => {
    const access_token = `fake-access-${randomUUID()}`
    access.add(access_token)
    accessOf.set(access_token, clientId)
    secrets.add(access_token)
    if (change.noRefresh) return { access_token, token_type: 'Bearer', expires_in: 3600 }
    const refresh_token = `fake-refresh-${randomUUID()}`
    refresh.set(refresh_token, clientId)
    seen.lastRefresh = refresh_token
    secrets.add(refresh_token)
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: 3600 }
  }
  /** The answers that wait for the GET that resumes their stream, by event id. */
  const resumable = new Map<string, unknown>()
  const mcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const message = req.method === 'POST' ? (JSON.parse(await body(req)) as { id?: number; method?: string }) : {}
    const anonymous =
      !(change.streamNeedsToken && req.method === 'GET') &&
      (change.anonymous === 'all' ||
        (change.anonymous === 'list' && message.method !== 'tools/call') ||
        (change.anonymous === 'initialize' && !message.method?.startsWith('tools/')))
    if ((bearer === undefined || !access.has(bearer) || change.rejectAll) && !anonymous)
      return void res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
    const sse = { 'content-type': 'text/event-stream' }
    if (change.resume401 && req.method === 'GET' && req.headers['last-event-id'] !== undefined)
      return void res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
    const resumed = req.method === 'GET' ? resumable.get(String(req.headers['last-event-id'])) : undefined
    if (resumed !== undefined) {
      seen.resumes++
      return void res.writeHead(200, sse).end(`id: ${randomUUID()}\ndata: ${JSON.stringify(resumed)}\n\n`)
    }
    if (req.method !== 'POST') return void res.writeHead(405).end()
    if (change.resumeList && message.method === 'tools/list') {
      const id = randomUUID()
      const tools = [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }]
      resumable.set(id, { jsonrpc: '2.0', id: message.id, result: { tools } })
      return void res.writeHead(200, sse).end(`id: ${id}\nretry: 10\ndata: \n\n`)
    }
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
    if (change.echoError !== '') {
      for (const value of [form.get('code'), form.get('code_verifier'), form.get('refresh_token')])
        if (value) secrets.add(value)
      return json(res, 400, { error: change.echoError, error_description: `echo ${text} ${auth ?? ''}` })
    }
    const arrived = seen.tokens.filter(f => f.get('grant_type') === 'refresh_token').length
    if (form.get('grant_type') === 'refresh_token' && change.stallRefreshes) return
    if (form.get('grant_type') === 'refresh_token') await change.gate
    // A client that went away while the answer waited sent no request that the server could finish. The server may see
    // the closed connection late, so a test names the requests whose client died.
    if (res.destroyed || (form.get('grant_type') === 'refresh_token' && arrived <= change.abandon)) return
    if (form.get('grant_type') === 'authorization_code' && change.stallExchange) return
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
    const answer = change.refreshAnswer
    if (answer !== undefined && form.get('grant_type') === 'refresh_token')
      return void res.writeHead(answer.status, { 'content-type': answer.type }).end(answer.body)
    const basic = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : []
    const clientId = form.get('client_id') ?? decodeURIComponent(basic[0] ?? '')
    const secret = form.get('client_secret') ?? decodeURIComponent(basic[1] ?? '')
    const method = basic.length > 0 ? 'client_secret_basic' : form.has('client_secret') ? 'client_secret_post' : 'none'
    seen.methods.push(method)
    if (
      !change.authMethods.includes(method) ||
      !clients.has(clientId) ||
      clientId === change.refuseClient ||
      (clientId === STATIC_ID && secret !== STATIC_SECRET)
    )
      return json(res, 401, { error: 'invalid_client' })
    if (form.get('grant_type') === 'refresh_token') {
      const old = form.get('refresh_token') ?? ''
      if (change.reuseDetection && used.has(old)) {
        seen.revocations++
        for (const [token, owner] of [...accessOf])
          if (owner === clientId) (access.delete(token), accessOf.delete(token))
        for (const [token, owner] of [...refresh]) if (owner === clientId) refresh.delete(token)
        return json(res, 400, { error: 'invalid_grant' })
      }
      if (refresh.get(old) !== clientId) {
        await new Promise(resolve => setTimeout(resolve, change.grantErrorMs))
        return json(res, 400, { error: 'invalid_grant' })
      }
      refresh.delete(old)
      used.add(old)
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
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource') && change.resourceMetadata !== 'missing') {
      const answer = change.resourceMetadata
      if (answer === 'stalled') return
      if (answer === 'stalled body') return void res.writeHead(200, { 'content-type': 'application/json' }).write('{')
      if (typeof answer === 'object') return void res.writeHead(answer.status, answer.headers).end(answer.body)
      return json(res, 200, { resource: change.resource || `${base}/mcp`, authorization_servers: [auth] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' && change.stallServerMetadata) return
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: change.metadataIssuer || auth,
        ...(change.issSupported && { authorization_response_iss_parameter_supported: true }),
        authorization_endpoint: change.authorizationEndpoint || `${auth}/authorize`,
        token_endpoint: `${auth}/token`,
        ...(change.registration && { registration_endpoint: `${auth}/register` }),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: change.authMethods,
      })
    if (url.pathname === '/register') {
      const metadata = JSON.parse(await body(req)) as { redirect_uris: string[] }
      const number = ++seen.registrations
      seen.registered.push(metadata)
      const clientId = change.registeredId === '' ? `fake-client-${number}` : change.registeredId
      clients.set(clientId, { redirectUris: metadata.redirect_uris })
      const secret = change.registeredSecret
      if (secret === '') return json(res, 201, { ...metadata, client_id: clientId })
      secrets.add(secret).add(Buffer.from(`${clientId}:${secret}`).toString('base64'))
      const method = change.authMethods[0]
      return json(res, 201, {
        ...metadata,
        client_id: clientId,
        client_secret: secret,
        token_endpoint_auth_method: method,
      })
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
      if (change.callbackIss !== 'none')
        to.searchParams.set('iss', change.callbackIss === 'right' ? auth : 'https://evil.example')
      return void res.writeHead(302, { location: to.href }).end()
    }
    if (url.pathname === '/token' && change.tokenDown) return void req.socket.destroy()
    if (url.pathname === '/token') (seen.tokenTypes.push(req.headers['content-type']), void 0)
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
    /** The refresh requests that the token endpoint got, answered or not. */
    refreshRequests: () => seen.tokens.filter(form => form.get('grant_type') === 'refresh_token').length,
  }
}
export type Fake = Awaited<ReturnType<typeof startFake>>
