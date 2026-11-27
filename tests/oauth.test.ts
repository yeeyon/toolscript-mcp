// The OAuth login of HTTP servers, against a fake OAuth and MCP server made
// with node:http: protected-resource and authorization-server metadata,
// /register, /authorize that redirects to the callback, /token that checks the
// PKCE verifier and refreshes, and an MCP endpoint that answers 401 without a
// valid Bearer token. `runLogin` gets a browser that follows the redirect.

import { after, afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, type Config, type ServerConfig, type ServerKey } from '../src/core/config.ts'
import { newKept } from '../src/core/protocol.ts'
import { connectAll, type ConnectOptions, type Downstream } from '../src/host/downstream.ts'
import { runLogin } from '../src/host/login.ts'
import { storeFile } from '../src/host/oauth.ts'
import { servers, startFake, STATIC_ID, STATIC_SECRET, type Fake } from './fake-oauth.ts'
import { runCode, type RunContext } from '../src/host/run.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-oauth-test-'))
const KEY = 'fake' as ServerKey
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  for (const s of servers) (s.closeAllConnections(), s.close())
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

/** The store folders of the test that runs: `setup` adds one, and the hook below checks it at the end of each test. */
const stores: string[] = []
/** Every name in a store folder that is not a store file: a lock, a claim or a temp file. A folder that is not made has none. */
const leftovers = (storeDir: string): string[] =>
  fs.existsSync(storeDir) ? fs.readdirSync(storeDir).filter(name => !name.endsWith('.json')) : []
afterEach(() => {
  const left = stores.splice(0).flatMap(leftovers)
  assert.deepEqual(left, [], 'a lock, claim or temp file stayed in the store folder')
})

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
  const login = (open = browser(), timeoutMs?: number) =>
    runLogin([KEY, '--config', file], {
      env,
      platform: process.platform,
      home,
      version: '0',
      print: t => void lines.push(t),
      open,
      ...(timeoutMs !== undefined && { timeoutMs }),
    })
  const connect = (config: ServerConfig = server, options: ConnectOptions = {}) => {
    const downstream = connectAll(new Map([[KEY, config]]), '0', line => void lines.push(line), { home, ...options })
    opened.push(downstream)
    return downstream
  }
  /** The text of a run_code run of `code` in the real sandbox, with `downstream`. */
  const run = async (downstream: Downstream, code: string): Promise<string> => {
    const config: Config = {
      servers: new Map(),
      bridges: new Set(),
      guards: { bridges: new Set(), workspace: false },
      sandbox: { node: process.execPath, timeoutSeconds: 30, callTimeoutSeconds: 30 },
      policy: [{ match: 'mcp__*', action: 'allow', index: 0 }],
      log: false,
    }
    const ctx: RunContext = {
      downstream,
      config,
      kept: newKept(),
      written: new Map(),
      untrustedFiles: new Set(),
      shapes: new Map(),
      filesDir: path.join(home, 'files'),
      policyNote: '',
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
  stores.push(storeDir)
  // The store files. The hook above lists the other names: a refresh makes its `.lock` file beside them for a moment.
  const store = () =>
    fs
      .readdirSync(storeDir)
      .filter(name => name.endsWith('.json'))
      .map(name => path.join(storeDir, name))
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

  test('a registered client that the token endpoint refuses is removed, and the next login registers again', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    fake.change.refuseClient = 'fake-client-1'
    assert.equal(await s.login(), 1, s.lines.join('\n'))
    const refused = s.lines.at(-1) ?? ''
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(fake.seen.registrations, 2)
    assert.match(refused, /refused the OAuth client of this login\. Run login again/)
    fake.expire()
    assert.equal(await s.ping(s.connect()), PONG)
    assert.deepEqual(s.leaks(), [])
  })

  test('a static client that the token endpoint refuses fails the login with the config to check', async () => {
    const fake = await startFake()
    fake.change.refuseClient = STATIC_ID
    const s = setup(fake, { oauth: { clientId: STATIC_ID, clientSecret: '${S}' } }, { S: STATIC_SECRET })
    assert.equal(await s.login(), 1, s.lines.join('\n'))
    assert.match(s.lines.at(-1) ?? '', /refused the OAuth client ID and secret of the config/)
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

  test('a server that asks for a token only on a call gets a login, and a second login after a revoke', async () => {
    const entries = [{}, { oauth: { clientId: STATIC_ID, clientSecret: '${S}' } }]
    for (const entry of entries) {
      const fake = await startFake()
      fake.change.anonymous = 'list'
      const s = setup(fake, entry, { S: STATIC_SECRET })
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      assert.match(s.lines.at(-1) ?? '', /^Logged in to fake\. It has 1 tool\./)
      assert.equal(fake.seen.authorizations.length, 1)
      assert.equal(await s.ping(s.connect()), PONG)
      fake.revoke()
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      assert.equal(fake.seen.authorizations.length, 2, 'the tokens in the store do not stop a new login')
      assert.equal(await s.ping(s.connect()), PONG)
      assert.deepEqual(s.leaks(), [])
    }
  })

  test('a server that answers initialize without a token and 401 to tools/list gets a login', async () => {
    const fake = await startFake()
    fake.change.anonymous = 'initialize'
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.match(s.lines.at(-1) ?? '', /^Logged in to fake\. It has 1 tool\./)
    assert.equal(fake.seen.authorizations.length, 1)
    assert.equal(await s.ping(s.connect()), PONG)
    assert.deepEqual(s.leaks(), [])
  })

  test('a 401 to the GET stream starts no second registration or authorization', async () => {
    for (const anonymous of ['initialize', 'list'] as const) {
      const fake = await startFake()
      fake.change.anonymous = anonymous
      fake.change.streamNeedsToken = true
      const s = setup(fake)
      assert.equal(await s.login(), 0, `${anonymous}: ${s.lines.join('\n')}`)
      assert.equal(fake.seen.registrations, 1, anonymous)
      assert.equal(fake.seen.authorizations.length, 1, anonymous)
      assert.equal(await s.ping(s.connect()), PONG, anonymous)
    }
  })

  test('a server that answers tools/list on a stream it closes and resumes on a GET logs in', async () => {
    for (const anonymous of ['', 'initialize'] as const) {
      const fake = await startFake()
      fake.change.anonymous = anonymous
      fake.change.resumeList = true
      const s = setup(fake)
      assert.equal(await s.login(browser(), 5000), 0, `${anonymous}: ${s.lines.join('\n')}`)
      assert.match(s.lines.at(-1) ?? '', /^Logged in to fake\. It has 1 tool\./, anonymous)
      assert.ok(fake.seen.resumes > 0, `${anonymous}: the list came on a resumed stream`)
      assert.equal(fake.seen.authorizations.length, 1, anonymous)
      assert.equal(await s.ping(s.connect()), PONG, anonymous)
    }
  })

  test('a 401 to the GET that resumes a stream opens no tab', { timeout: 60_000 }, async () => {
    const fake = await startFake()
    fake.change.anonymous = 'list'
    fake.change.resumeList = true
    fake.change.resume401 = true
    const s = setup(fake)
    const opened: string[] = []
    const follow = browser()
    const code = await s.login(url => (opened.push(url), follow(url)), 5000)
    assert.equal(opened.length, 0, s.lines.join('\n'))
    assert.equal(fake.seen.registrations, 0)
    assert.equal(code, 1, s.lines.join('\n'))
  })

  test('a server that still answers 401 after the token exchange fails the login and opens one tab', async () => {
    for (const anonymous of ['', 'initialize'] as const) {
      const fake = await startFake()
      fake.change.anonymous = anonymous
      fake.change.rejectAll = true
      fake.change.noRefresh = true
      const s = setup(fake)
      const opened: string[] = []
      const follow = browser()
      assert.equal(await s.login(url => (opened.push(url), follow(url))), 1, `${anonymous}: ${s.lines.join('\n')}`)
      assert.equal(opened.length, 1, anonymous)
      assert.equal(
        s.lines.at(-1),
        'login to fake failed: the server still asks for a login after the token exchange',
        anonymous,
      )
      assert.deepEqual(s.leaks(), [])
    }
  })

  test('a stall after a 401 to tools/list ends the login at the time limit', { timeout: 120_000 }, async () => {
    for (const stall of ['resource', 'resource body', 'server'] as const) {
      const fake = await startFake()
      fake.change.anonymous = 'initialize'
      if (stall === 'resource') fake.change.resourceMetadata = 'stalled'
      else if (stall === 'resource body') fake.change.resourceMetadata = 'stalled body'
      else fake.change.stallServerMetadata = true
      const s = setup(fake)
      const start = performance.now()
      assert.equal(await s.login(cancel(), 2000), 1, s.lines.join('\n'))
      assert.ok(performance.now() - start < 10_000, stall)
      assert.equal(
        s.lines.join('\n'),
        `login to fake failed: the login did not start within 2 s (waiting for http://127.0.0.1:${fake.port})`,
        stall,
      )
      assert.equal(fake.seen.authorizations.length, 0)
    }
  })

  test('a server that answers without a token and has no protected-resource metadata needs no login', async () => {
    const answers: Fake['change']['resourceMetadata'][] = [
      'missing',
      { status: 405 },
      { status: 403 },
      { status: 401 },
      { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>app</html>' },
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"name":"app"}' },
      // Keys of the metadata count only at the top level.
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"links":{"resource":"x"},"ok":true}' },
      { status: 302, headers: { location: 'https://login.example.com/' } },
    ]
    for (const answer of answers) {
      const fake = await startFake()
      fake.change.anonymous = 'all'
      fake.change.resourceMetadata = answer
      const s = setup(fake)
      const opened: string[] = []
      assert.equal(await s.login(cancel(opened)), 0, `${JSON.stringify(answer)}: ${s.lines.join('\n')}`)
      assert.match(s.lines.join('\n'), /^fake needs no login: it answered without a token\. It has 1 tool\.$/)
      assert.equal(fake.seen.registrations, 0)
      assert.deepEqual(opened, [])
    }
  })

  /** The tokens that the store holds, or none when login stored nothing. */
  const storedTokens = (s: ReturnType<typeof setup>) => {
    try {
      return JSON.parse(s.storeText()).tokens
    } catch {
      return undefined
    }
  }

  test('a server that answers without a token and has no registration says that calls with a token need a clientId', async () => {
    for (const anonymous of ['all', 'list'] as const) {
      const fake = await startFake()
      fake.change.anonymous = anonymous
      fake.change.registration = false
      const s = setup(fake)
      assert.equal(await s.login(cancel()), 1, s.lines.join('\n'))
      assert.equal(
        s.lines.join('\n'),
        'login to fake failed: it answered without a token and has 1 tool, but its authorization server has no dynamic client registration. Calls that need a token need "clientId" in "oauth": see "OAuth login" in the README. No tokens were stored.',
      )
      assert.equal(fake.seen.authorizations.length, 0)
      assert.equal(storedTokens(s), undefined)
    }
  })

  test('a server that answers without a token, with metadata for another resource, says so', async () => {
    const fake = await startFake()
    fake.change.anonymous = 'list'
    fake.change.resource = 'https://other.example.com/mcp'
    const s = setup(fake)
    assert.equal(await s.login(cancel()), 1, s.lines.join('\n'))
    assert.equal(
      s.lines.join('\n'),
      `login to fake failed: it answered without a token and has 1 tool, but its protected-resource metadata is for https://other.example.com/mcp, not ${fake.url}. No tokens were stored.`,
    )
    assert.equal(fake.seen.authorizations.length, 0)
  })

  test('protected-resource metadata that is broken is a failed login, not "needs no login"', async () => {
    const json = { 'content-type': 'application/json' }
    for (const [body, why] of [
      [
        (url: string) => JSON.stringify({ resource: url, authorization_servers: 'not-a-list' }),
        'authorization_servers: Invalid input: expected array, received string',
      ],
      [() => JSON.stringify({ resource: 42 }), 'resource: Invalid input: expected string, received number'],
      // The text of a JSON syntax error differs between Node versions.
      [(url: string) => `{"resource":"${url}","authorization_servers":["http`, ''],
    ] as const) {
      const fake = await startFake()
      fake.change.anonymous = 'all'
      fake.change.resourceMetadata = { status: 200, headers: json, body: body(fake.url) }
      const s = setup(fake)
      const opened: string[] = []
      assert.equal(await s.login(cancel(opened)), 1, s.lines.join('\n'))
      assert.ok(
        s.lines
          .join('\n')
          .startsWith(
            `login to fake failed: it answered without a token and has 1 tool, but its protected-resource metadata is not valid: ${why}`,
          ),
        s.lines.join('\n'),
      )
      assert.equal(fake.seen.registrations, 0)
      assert.deepEqual(opened, [])
    }
  })

  test('protected-resource metadata that fails to load is a failed login with its cause, not "needs no login"', async () => {
    for (const status of [503, 429, 408]) {
      const fake = await startFake()
      fake.change.anonymous = 'all'
      fake.change.resourceMetadata = { status }
      const s = setup(fake)
      assert.equal(await s.login(cancel()), 1, s.lines.join('\n'))
      assert.match(
        s.lines.join('\n'),
        new RegExp(
          `^login to fake failed: it answered without a token and has 1 tool, but the login did not start: HTTP ${status} .*No tokens were stored\\.$`,
        ),
      )
    }
  })

  test('metadata that never answers ends the login at the time limit', async () => {
    for (const stall of ['resource', 'resource body', 'server'] as const) {
      const fake = await startFake()
      fake.change.anonymous = 'list'
      if (stall === 'resource') fake.change.resourceMetadata = 'stalled'
      else if (stall === 'resource body') fake.change.resourceMetadata = 'stalled body'
      else fake.change.stallServerMetadata = true
      const s = setup(fake)
      const start = performance.now()
      assert.equal(await s.login(cancel(), 2000), 1, s.lines.join('\n'))
      assert.ok(performance.now() - start < 10_000, stall)
      assert.equal(
        s.lines.join('\n'),
        `login to fake failed: it answered without a token and has 1 tool, but the login did not start within 2 s (waiting for http://127.0.0.1:${fake.port}). No tokens were stored.`,
        stall,
      )
      assert.equal(fake.seen.authorizations.length, 0)
    }
  })

  test('a token exchange that never answers ends the login at the time limit', { timeout: 30_000 }, async () => {
    const fake = await startFake()
    fake.change.stallExchange = true
    const s = setup(fake)
    const start = performance.now()
    assert.equal(await s.login(browser(), 2000), 1, s.lines.join('\n'))
    assert.ok(performance.now() - start < 10_000)
    assert.equal(
      s.lines.at(-1),
      `login to fake failed: the token exchange did not end within 2 s (waiting for http://127.0.0.1:${fake.port})`,
    )
    assert.equal(storedTokens(s), undefined)
  })

  test('a Google-like server: tools listed without a token, no registration, a static client', async () => {
    const fake = await startFake()
    fake.change.anonymous = 'list'
    fake.change.registration = false
    const s = setup(fake, { oauth: { clientId: STATIC_ID, clientSecret: '${S}' } }, { S: STATIC_SECRET })
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.match(s.lines.at(-1) ?? '', /^Logged in to fake\. It has 1 tool\./)
    assert.equal(fake.seen.authorizations.length, 1)
    assert.equal(fake.seen.registrations, 0)
    assert.ok(storedTokens(s)?.access_token, 'login stored tokens')
    assert.equal(await s.ping(s.connect()), PONG)
    assert.deepEqual(s.leaks(), [])
  })

  test('a static client logs in without a registration endpoint, with a client authentication the server lists', async () => {
    for (const methods of [['client_secret_basic', 'client_secret_post'], ['client_secret_post']]) {
      const fake = await startFake()
      fake.change.registration = false
      fake.change.authMethods = methods
      const s = setup(fake, { oauth: { clientId: STATIC_ID, clientSecret: '${S}' } }, { S: STATIC_SECRET })
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      fake.expire()
      assert.equal(await s.ping(s.connect()), PONG, 'the refresh uses a listed client authentication too')
      assert.deepEqual(fake.seen.methods, [methods[0], methods[0]])
      assert.deepEqual(s.leaks(), [])
    }
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
    assert.equal(await s.login(cancel([], 'denied\u001b[2J\r\nfake: Logged in\u009b\u2028\u202e\u2066')), 1)
    const printed = s.lines.join('\n')
    assert.ok(
      printed.includes('denied\\u001b[2J\\u000d\\u000afake: Logged in\\u009b\\u2028\\u202e\\u2066 description'),
      printed,
    )
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(printed), printed)
    assert.ok(!printed.includes('\nfake:'), printed)
  })

  test('a code exchange refused with a bare invalid_grant prints the error code', async () => {
    const fake = await startFake()
    const s = setup(fake)
    const wrongCode = (url: string) =>
      void (async () => {
        const answer = await fetch(url, { redirect: 'manual' })
        const to = new URL(answer.headers.get('location') ?? '')
        to.searchParams.set('code', 'fake-wrong-code')
        await fetch(to)
      })()
    assert.equal(await s.login(wrongCode), 1, s.lines.join('\n'))
    assert.match(s.lines.at(-1) ?? '', /^login to fake failed: the authorization server answered invalid_grant$/)
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

  test('login on a sigv4 entry says it needs no login and names the AWS command, with no browser', async () => {
    const fake = await startFake()
    const s = setup(fake, { sigv4: { profile: 'dev', region: 'us-east-1', service: 'fake' } })
    const opens: string[] = []
    assert.equal(await s.login(url => void opens.push(url)), 1)
    const text = s.lines.join('\n')
    assert.match(text, /needs no login/)
    assert.match(text, /aws sso login --profile dev/)
    assert.doesNotMatch(text, /oauth/i)
    assert.deepEqual(opens, [])
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

  test('a stored client of another authorization server asks for a login, and the login fixes it', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const [file] = s.store()
    const stored = JSON.parse(fs.readFileSync(file!, 'utf8'))
    stored.client.info.issuer = 'https://auth.example/'
    fs.writeFileSync(file!, JSON.stringify(stored))
    fake.expire()
    const downstream = s.connect()
    await downstream.settled
    const state = downstream.states()[0]
    assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(await s.ping(downstream), PONG)
  })

  test('tokens of another authorization server ask for a login, not a new refresh', async () => {
    const fake = await startFake()
    const s = setup(fake, { oauth: { clientId: STATIC_ID, clientSecret: '${S}' } }, { S: STATIC_SECRET })
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const [file] = s.store()
    const stored = JSON.parse(fs.readFileSync(file!, 'utf8'))
    stored.tokens.issuer = 'https://auth.example/'
    fs.writeFileSync(file!, JSON.stringify(stored))
    fake.expire()
    const downstream = s.connect()
    await downstream.settled
    const state = downstream.states()[0]
    assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON)
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
    assert.match(reason, /^could not refresh the OAuth token: .+\. No login is needed/, reason)
    fake.change.tokenDown = false
    assert.equal(await s.ping(downstream), PONG)
    assert.equal(fake.seen.authorizations.length, 1, 'only the login authorized')
  })

  test('a refresh that fails at each attempt says once that toolscript-mcp tries again', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.tokenDown = true
    for (let attempt = 0; attempt < 3; attempt++) await s.ping(downstream)
    const state = downstream.states()[0]
    const reason = state?.status === 'failed' ? state.reason : ''
    assert.match(
      reason,
      /^could not refresh the OAuth token: .+ toolscript-mcp tries again on next use after \d+ s$/,
      reason,
    )
    assert.equal(reason.match(/tries again/g)?.length, 1, reason)
  })

  test('a refresh that the token endpoint refuses ends the link with the login command', async () => {
    const refusals = [
      { status: 401, type: 'application/json', body: '{"error":"token_revoked"}' },
      { status: 403, type: 'text/html', body: '<html>Forbidden</html>' },
      { status: 400, type: 'application/json', body: '{"error":"invalid_token"}' },
      { status: 400, type: 'application/json', body: '{"error":"invalid_request"}' },
    ]
    for (const answer of refusals) {
      const fake = await startFake()
      const s = setup(fake)
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      const downstream = s.connect()
      assert.equal(await s.ping(downstream), PONG)
      fake.expire()
      fake.change.refreshAnswer = answer
      assert.match(await s.ping(downstream), LOGIN_REASON, answer.body)
      const state = downstream.states()[0]
      assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON, answer.body)
    }
  })

  test('a refresh that gets no answer, 503 or 429 needs no login, and the next use refreshes', async () => {
    const failures = [
      {
        name: 'network',
        fail: (fake: Fake) => void (fake.change.tokenDown = true),
        cause: /other side closed|ECONNRESET|socket/,
      },
      {
        name: '503',
        fail: (fake: Fake) => void (fake.change.refreshAnswer = { status: 503, type: 'text/plain', body: 'down' }),
        cause: /HTTP 503/,
      },
      {
        name: '429',
        fail: (fake: Fake) =>
          void (fake.change.refreshAnswer = { status: 429, type: 'application/json', body: '{"error":"slow_down"}' }),
        cause: /HTTP 429/,
      },
    ]
    for (const { name, fail, cause } of failures) {
      const fake = await startFake()
      const s = setup(fake)
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      const downstream = s.connect()
      assert.equal(await s.ping(downstream), PONG)
      fake.expire()
      fail(fake)
      const text = await s.ping(downstream)
      assert.match(text, /^could not refresh the OAuth token: /, `${name}: ${text}`)
      assert.match(text, cause, `${name}: ${text}`)
      assert.equal(downstream.states()[0]?.status, 'failed', name)
      fake.change.tokenDown = false
      fake.change.refreshAnswer = undefined
      assert.equal(await s.ping(downstream), PONG, name)
      assert.equal(fake.seen.authorizations.length, 1, `${name}: only the login authorized`)
    }
  })

  test('a refresh with no answer fails in time, and the next use refreshes', { timeout: 20_000 }, async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const short = { refreshTimeoutMs: 300 }
    const downstream = s.connect(undefined, short)
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.stallRefreshes = true
    const start = Date.now()
    const second = s.connect(undefined, short)
    const texts = await Promise.all([s.ping(downstream), s.ping(second)])
    assert.ok(Date.now() - start < 5000, `the calls waited ${Date.now() - start} ms`)
    const silent = /could not refresh the OAuth token: the token endpoint did not answer in 0\.3 s\. No login/
    for (const text of texts) assert.match(text, silent, text)
    fake.change.stallRefreshes = false
    assert.deepEqual(await Promise.all([s.ping(downstream), s.ping(second)]), [PONG, PONG])
    assert.equal(fake.seen.authorizations.length, 1, 'only the login authorized')
  })

  test('a refresh token that another process used first gives its saved tokens, with no login', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.holdRefreshes = 2
    // The other process sends the stored refresh token first, so it wins, and saves the next tokens.
    const [file] = s.store()
    const stored = JSON.parse(fs.readFileSync(file!, 'utf8'))
    const other = (async () => {
      const form = { grant_type: 'refresh_token', refresh_token: stored.tokens.refresh_token }
      const answer = await fetch(new URL('/token', fake.url), {
        method: 'POST',
        body: new URLSearchParams({ ...form, client_id: stored.client.info.client_id }),
      })
      fs.writeFileSync(file!, JSON.stringify({ ...stored, tokens: await answer.json() }))
    })()
    while (fake.refreshRequests() === 0) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(await s.ping(downstream), PONG)
    await other
    assert.equal(fake.refreshRequests(), 2)
    assert.equal(fake.seen.authorizations.length, 1, 'only the login authorized')
  })

  /**
   * A login in another process while the token endpoint holds a refresh of the running server: the login saves its
   * tokens, then the refresh gets its answer. Gives the store as the login left it.
   */
  const loginDuringRefresh = async (fake: Fake, s: ReturnType<typeof setup>, downstream: Downstream) => {
    let release = () => {}
    fake.change.gate = new Promise<void>(resolve => (release = resolve))
    fake.expire()
    const call = s.ping(downstream)
    while (fake.refreshRequests() === 0) await new Promise(resolve => setTimeout(resolve, 10))
    const login = await s.login()
    const stored = JSON.parse(s.storeText())
    release()
    assert.equal(login, 0, s.lines.join('\n'))
    assert.equal(await call, PONG)
    return stored
  }

  test('a store removed during a refresh stays removed, and the link needs a login', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    let release = () => {}
    fake.change.gate = new Promise<void>(resolve => (release = resolve))
    fake.expire()
    const call = s.ping(downstream)
    while (fake.refreshRequests() === 0) await new Promise(resolve => setTimeout(resolve, 10))
    for (const file of s.store()) fs.rmSync(file)
    release()
    assert.match(await call, LOGIN_REASON)
    assert.deepEqual(s.store(), [], 'the refresh did not write the store again')
  })

  test('a login during a refresh keeps its tokens in the store, and the next refresh sends them', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    const login = await loginDuringRefresh(fake, s, downstream)
    assert.equal(fake.seen.registrations, 1, 'the login kept the stored client')
    assert.deepEqual(JSON.parse(s.storeText()), login, 'the refresh left the store of the login')
    fake.expire()
    assert.equal(await s.ping(downstream), PONG)
    const refreshes = fake.seen.tokens.filter(form => form.get('grant_type') === 'refresh_token')
    assert.equal(refreshes.at(-1)?.get('refresh_token'), login.tokens.refresh_token)
  })

  test('a login that registers a new client during a refresh keeps its client and tokens, which refresh', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    // Another program now has the port of the registered redirect URL, so the next login registers a new client.
    const redirect = fake.seen.authorizations[0]?.searchParams.get('redirect_uri') ?? ''
    const taken = http.createServer()
    await new Promise<void>(resolve => taken.listen(Number(new URL(redirect).port), '127.0.0.1', resolve))
    servers.push(taken)
    const login = await loginDuringRefresh(fake, s, downstream)
    assert.equal(fake.seen.registrations, 2)
    assert.deepEqual(JSON.parse(s.storeText()), login, 'the refresh left the store of the login')
    fake.expire()
    assert.equal(await s.ping(downstream), PONG, 'the running link refreshes the stored tokens with the stored client')
  })

  test('eight calls of two links at expiry all go on, and the token endpoint gets one refresh', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const links = [s.connect(), s.connect()]
    assert.deepEqual(await Promise.all(links.map(s.ping)), [PONG, PONG])
    fake.expire()
    const calls = links.flatMap(link => Array.from({ length: 4 }, () => s.ping(link)))
    assert.deepEqual(await Promise.all(calls), Array(8).fill(PONG))
    assert.equal(fake.refreshRequests(), 1)
  })

  test('a store that refuses the rename of refreshed tokens for a while gets them, and the call goes on', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    const rename = fs.promises.rename
    let refusals = 3
    mock.method(fs.promises, 'rename', async (from: string, to: string) => {
      if (refusals-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      return rename(from, to)
    })
    fake.expire()
    try {
      assert.equal(await s.ping(downstream), PONG)
    } finally {
      mock.restoreAll()
    }
    assert.equal(await s.ping(s.connect()), PONG, 'a new link uses the saved tokens')
    assert.equal(fake.seen.refreshes, 1)
  })

  test('refreshed tokens that the store never takes work until the process ends, with one log line each', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    mock.method(fs.promises, 'rename', async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    })
    const logged = mock.method(console, 'error', () => {})
    try {
      fake.expire()
      assert.equal(await s.ping(downstream), PONG)
      fake.expire()
      assert.equal(await s.ping(downstream), PONG, 'the next refresh sends the refresh token in memory')
    } finally {
      mock.restoreAll()
    }
    assert.equal(fake.seen.refreshes, 2)
    const lines = logged.mock.calls.map(call => call.arguments.join(' '))
    assert.equal(lines.length, 2, lines.join('\n'))
    assert.match(lines[0] ?? '', /could not save the refreshed OAuth tokens.*EBUSY/)
    assert.deepEqual(
      [...fake.secrets].filter(secret => lines.join('\n').includes(secret)),
      [],
    )
  })

  test('a store that stays locked holds the refresh for about 1 s, also when each rename is slow', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    mock.method(fs.promises, 'rename', async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })
    mock.method(console, 'error', () => {})
    fake.expire()
    const start = Date.now()
    try {
      assert.equal(await s.ping(downstream), PONG)
    } finally {
      mock.restoreAll()
    }
    assert.ok(Date.now() - start < 3000, `the call waited ${Date.now() - start} ms`)
  })

  /** One refresh at expiry whose tokens the store never takes, so this process keeps them in memory. */
  const refreshUnsaved = async (fake: Fake, s: ReturnType<typeof setup>, downstream: Downstream) => {
    mock.method(fs.promises, 'rename', async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
    })
    mock.method(console, 'error', () => {})
    try {
      fake.expire()
      assert.equal(await s.ping(downstream), PONG)
    } finally {
      mock.restoreAll()
    }
  }

  test('a login after a revoke replaces refreshed tokens that the store never took', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    await refreshUnsaved(fake, s, downstream)
    fake.revoke()
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(await s.ping(downstream), PONG)
    assert.equal(await s.ping(s.connect()), PONG, 'a new link uses the tokens of the login')
  })

  test('refreshed tokens that the store never took do not replace the grant of a later login', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    await refreshUnsaved(fake, s, downstream)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const login = JSON.parse(s.storeText()).tokens.refresh_token
    fake.expire()
    assert.equal(await s.ping(downstream), PONG)
    const refreshes = fake.seen.tokens.filter(form => form.get('grant_type') === 'refresh_token')
    assert.equal(refreshes.at(-1)?.get('refresh_token'), login, 'the refresh sent the refresh token of the login')
  })

  test('a refresh answer that holds no tokens keeps refreshed tokens that the store never took', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    await refreshUnsaved(fake, s, downstream)
    fake.expire()
    fake.change.refreshAnswer = { status: 200, type: 'text/html', body: '<html>maintenance</html>' }
    assert.notEqual(await s.ping(downstream), PONG)
    fake.change.refreshAnswer = undefined
    assert.equal(await s.ping(downstream), PONG, 'the refresh token in memory still refreshes')
  })

  test('refreshed tokens that the store never took work while the store cannot be read', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    await refreshUnsaved(fake, s, downstream)
    mock.method(fs.promises, 'readFile', async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' })
    })
    try {
      assert.equal(await s.ping(downstream), PONG)
    } finally {
      mock.restoreAll()
    }
  })

  test('a late invalid_grant of one of two calls at expiry needs no login', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.grantErrorMs = 300
    assert.deepEqual(await Promise.all([s.ping(downstream), s.ping(downstream)]), [PONG, PONG])
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

  test('a refresh token that the authorization server echoes in a refusal never reaches the program', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const downstream = s.connect()
    assert.equal(await s.ping(downstream), PONG)
    fake.expire()
    fake.change.echo = 'refresh'
    const text = await s.run(downstream, CALL)
    assert.match(text, /needs an OAuth login/, text)
    assert.deepEqual(leaked(fake, text), [])
  })

  test('a token shorter than 8 characters is never hidden, so a server cannot blank the words of a reason', async () => {
    const fake = await startFake()
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    const [file] = s.store()
    const stored = JSON.parse(fs.readFileSync(file!, 'utf8'))
    fs.writeFileSync(
      file!,
      JSON.stringify({ ...stored, tokens: { ...stored.tokens, access_token: 'login', refresh_token: 'OAuth' } }),
    )
    const downstream = s.connect()
    await downstream.settled
    const state = downstream.states()[0]
    assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON)
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

  test('login hides a registered client secret of any length where it stands as the secret', async () => {
    for (const [method, secret] of [
      ['client_secret_post', 'ab'],
      ['client_secret_post', 'k3y'],
      ['client_secret_post', 'fk5ec7'],
      ['client_secret_post', '123456'],
      ['client_secret_post', '12345678'],
      ['client_secret_post', 'login'],
      ['client_secret_basic', 'ab'],
      ['client_secret_basic', 'login'],
    ] as const) {
      const fake = await startFake()
      fake.change.echo = 'exchange'
      fake.change.authMethods = [method]
      fake.change.registeredSecret = secret
      const s = setup(fake)
      assert.equal(await s.login(), 1, method)
      const printed = s.lines.join('\n')
      const what = `${method} ${secret}: ${printed}`
      assert.match(printed, /login to fake failed: .*bad request: /, what)
      assert.ok(!printed.includes(`client_secret=${secret}`), what)
      assert.ok(!printed.includes(Buffer.from(`fake-client-1:${secret}`).toString('base64')), what)
      if (method === 'client_secret_post') assert.ok(printed.includes('client_secret=***'), what)
      const others = [...fake.secrets].filter(v => v !== secret && printed.includes(v))
      assert.deepEqual(others, [], what)
    }
  })

  test('a registered client whose id and short secret a reason holds blanks no words of the login output', async () => {
    const fake = await startFake()
    fake.change.echo = 'exchange'
    fake.change.authMethods = ['client_secret_post']
    fake.change.registeredId = 'response'
    fake.change.registeredSecret = ' Synta'
    const s = setup(fake)
    assert.equal(await s.login(), 1)
    const printed = s.lines.join('\n')
    assert.match(printed, /Invalid OAuth error response: SyntaxError/, printed)
    assert.ok(!printed.includes('client_secret=+Synta'), printed)
  })

  test('a registered client secret that is a common word never blanks the words of a reason', async () => {
    for (const secret of ['login', 'fake', 'OAuth']) {
      const fake = await startFake()
      fake.change.authMethods = ['client_secret_post']
      fake.change.registeredSecret = secret
      const s = setup(fake)
      assert.equal(await s.login(), 0, s.lines.join('\n'))
      const downstream = s.connect()
      assert.equal(await s.ping(downstream), PONG, secret)
      fake.revoke()
      assert.match(await s.run(downstream, CALL), LOGIN_REASON, secret)
      const later = s.connect()
      await later.settled
      const state = later.states()[0]
      assert.match(state?.status === 'failed' ? state.reason : '', LOGIN_REASON, secret)
    }
  })
})
