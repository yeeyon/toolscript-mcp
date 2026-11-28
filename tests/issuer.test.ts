// The checks of the OAuth login that the v2 client adds (issue #154, PR 6): the `iss` of the callback (RFC 9207), the
// `issuer` of the authorization server metadata (RFC 8414), and the text of the SDK that must not reach stderr.

import { after, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerKey } from '../src/core/config.ts'
import { connectAll, type Downstream } from '../src/host/downstream.ts'
import { runLogin } from '../src/host/login.ts'
import { oauthProvider, storeFile } from '../src/host/oauth.ts'
import { servers, startFake, STATIC_ID, STATIC_SECRET, type Fake } from './fake-oauth.ts'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-issuer-test-'))
const KEY = 'fake' as ServerKey
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  for (const s of servers) (s.closeAllConnections(), s.close())
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

const follow = (url: string): void =>
  void (async () => {
    const answer = await fetch(url, { redirect: 'manual' })
    await fetch(new URL(answer.headers.get('location') ?? '')).catch(() => {})
  })()

const setup = (fake: Fake, entry: Record<string, unknown> = {}) => {
  const home = fs.mkdtempSync(path.join(DIR, 'home-'))
  const file = path.join(home, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [KEY]: { type: 'http', url: fake.url, ...entry } } }))
  const lines: string[] = []
  const login = async (): Promise<number> =>
    runLogin([KEY, '--config', file], {
      env: {},
      platform: process.platform,
      home,
      version: '0',
      print: t => void lines.push(t),
      open: follow,
    })
  const stored = (): string => {
    const dir = path.join(home, '.toolscript-mcp', 'oauth')
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
          .join('\n')
      : ''
  }
  return { home, lines, login, stored }
}

const exchanges = (fake: Fake): number =>
  fake.seen.tokens.filter(f => f.get('grant_type') === 'authorization_code').length

const NO_ISS = (issuer: string) =>
  `login to ${KEY} failed: the answer in the browser did not name its authorization server, and ${issuer} says it always does, so its code was not used`
const OTHER_ISS = (issuer: string) =>
  `login to ${KEY} failed: the answer in the browser named another authorization server than ${issuer}, so its code was not used`

for (const [name, change, expected] of [
  ['the flag and no iss', { issSupported: true, callbackIss: 'none' }, NO_ISS],
  ['the flag and another iss', { issSupported: true, callbackIss: 'wrong' }, OTHER_ISS],
  ['no flag and another iss', { issSupported: false, callbackIss: 'wrong' }, OTHER_ISS],
] as const) {
  test(`a login with ${name} sends no code, stores no tokens and prints no iss`, async () => {
    const fake = await startFake()
    Object.assign(fake.change, change)
    const s = setup(fake)
    assert.equal(await s.login(), 1, s.lines.join('\n'))
    const issuer = new URL(fake.url).origin
    assert.ok(
      s.lines.some(l => l === expected(issuer)),
      s.lines.join('\n'),
    )
    assert.equal(exchanges(fake), 0, 'the code was sent to the token endpoint')
    assert.ok(!s.stored().includes('access_token'), 'tokens were stored')
    assert.ok(!s.lines.join('\n').includes('evil.example'), 'the iss of the browser was printed')
  })
}

for (const [name, change] of [
  ['no flag and no iss', { issSupported: false, callbackIss: 'none' }],
  ['the flag and the right iss', { issSupported: true, callbackIss: 'right' }],
] as const) {
  test(`a login with ${name} works`, async () => {
    const fake = await startFake()
    Object.assign(fake.change, change)
    const s = setup(fake)
    assert.equal(await s.login(), 0, s.lines.join('\n'))
    assert.equal(exchanges(fake), 1)
  })
}

test('an error answer of the browser with another iss shows no error text, and one with none shows it as before', async () => {
  const fake = await startFake()
  fake.change.issSupported = true
  const s = setup(fake)
  const cancel =
    (iss?: string) =>
    (url: string): void => {
      const q = new URL(url).searchParams
      const to = new URL(q.get('redirect_uri') ?? '')
      to.searchParams.set('error', 'access_denied')
      to.searchParams.set('error_description', 'evil words')
      to.searchParams.set('state', q.get('state') ?? '')
      if (iss !== undefined) to.searchParams.set('iss', iss)
      void fetch(to).catch(() => {})
    }
  const run = (open: (url: string) => void) =>
    runLogin([KEY, '--config', path.join(s.home, 'config.json')], {
      env: {},
      platform: process.platform,
      home: s.home,
      version: '0',
      print: t => void s.lines.push(t),
      open,
    })
  assert.equal(await run(cancel('https://evil.example')), 1)
  assert.ok(
    s.lines.some(l => l.includes('named another authorization server')),
    s.lines.join('\n'),
  )
  assert.ok(!s.lines.join('\n').includes('evil words'), 'the error text of an unchecked answer was printed')
  s.lines.length = 0
  assert.equal(await run(cancel(new URL(fake.url).origin)), 1)
  assert.ok(
    s.lines.some(l => l.includes('access_denied: evil words')),
    s.lines.join('\n'),
  )
})

test('metadata that names another issuer fails the login and the running link, and sends no token', async () => {
  const fake = await startFake()
  const s = setup(fake)
  assert.equal(await s.login(), 0, s.lines.join('\n'))
  fake.change.metadataIssuer = 'https://other.example'
  fake.revoke()
  s.lines.length = 0
  const text = (received: string) =>
    `the authorization server metadata of ${new URL(fake.url).origin} names another issuer (${received}), so toolscript-mcp sends it no login and no token`
  assert.equal(await s.login(), 1)
  assert.ok(
    s.lines.some(l => l === `login to ${KEY} failed: ${text('https://other.example')}`),
    s.lines.join('\n'),
  )
  const downstream = connectAll(
    new Map([[KEY, { kind: 'http' as const, url: fake.url, headers: {}, oauth: { scopes: [] } }]]),
    '0',
    () => {},
    { home: s.home },
  )
  opened.push(downstream)
  await downstream.settled
  const state = downstream.states()[0]
  assert.ok(state?.status === 'failed' && state.reason === text('https://other.example'), JSON.stringify(state))
  assert.equal(fake.refreshRequests(), 0, 'a refresh token was sent to the authorization server')
})

test('metadata whose issuer has a slash that the URL lacks, and the reverse, still refresh a stored login', async () => {
  const fake = await startFake()
  const s = setup(fake)
  assert.equal(await s.login(), 0, s.lines.join('\n'))
  const origin = new URL(fake.url).origin
  for (const stamp of [origin, `${origin}/`]) {
    const file = storeFile(s.home, KEY, fake.url)
    const store = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: { issuer?: string } }
    store.tokens.issuer = stamp
    fs.writeFileSync(file, JSON.stringify(store))
    fake.expire()
    const downstream = connectAll(
      new Map([[KEY, { kind: 'http' as const, url: fake.url, headers: {}, oauth: { scopes: [] } }]]),
      '0',
      () => {},
      { home: s.home },
    )
    opened.push(downstream)
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'connected', `stamp ${stamp}`)
  }
  assert.ok(fake.refreshRequests() >= 1)
})

for (const error of ['invalid_client', 'invalid_grant'] as const) {
  test(`the SDK's warning after ${error} leaves out the text of the token endpoint, which echoes the code and the client secret`, async () => {
    const fake = await startFake()
    fake.change.echoError = error
    const s = setup(fake, { oauth: { clientId: STATIC_ID, clientSecret: STATIC_SECRET } })
    const written: string[] = []
    const write = mock.method(process.stderr, 'write', (chunk: unknown) => (written.push(String(chunk)), true))
    try {
      await s.login()
    } finally {
      write.mock.restore()
    }
    const warned = written.join('')
    assert.ok(warned.includes(`[mcp-sdk] OAuth "${error}"`), `no warning: ${warned} :: ${s.lines.join(' | ')}`)
    for (const secret of fake.secrets) assert.ok(!warned.includes(secret), `stderr holds ${secret.slice(0, 8)}`)
    assert.ok(!s.lines.join('\n').includes(STATIC_SECRET))
  })
}

test('a store of 1.0.x has no issuer stamp, and the running server refreshes it with no SEP-2352 line on stderr', async () => {
  const fake = await startFake()
  const s = setup(fake)
  assert.equal(await s.login(), 0, s.lines.join('\n'))
  const file = storeFile(s.home, KEY, fake.url)
  const store = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    tokens: { issuer?: string }
    client: { info: { issuer?: string } }
  }
  delete store.tokens.issuer
  delete store.client.info.issuer
  fs.writeFileSync(file, JSON.stringify(store))
  fake.expire()
  const written: string[] = []
  const write = mock.method(process.stderr, 'write', (chunk: unknown) => (written.push(String(chunk)), true))
  try {
    const entry = { kind: 'http' as const, url: fake.url, headers: {}, oauth: { scopes: [] } }
    const downstream = connectAll(new Map([[KEY, entry]]), '0', () => {}, { home: s.home })
    opened.push(downstream)
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'connected')
  } finally {
    write.mock.restore()
  }
  assert.ok(fake.refreshRequests() >= 1, 'the store was refreshed')
  assert.ok(!written.join('').includes('SEP-2352'), written.join(''))
})

test('a code that is not an OAuth error code is not printed in a warning of the SDK', () => {
  oauthProvider(path.join(DIR, 'guard.json'), { scopes: [] }, { kind: 'serve', reason: 'r', refreshTimeoutMs: 1000 })
  const written: string[] = []
  const write = mock.method(process.stderr, 'write', (chunk: unknown) => (written.push(String(chunk)), true))
  try {
    console.warn('[mcp-sdk] OAuth "s3cr3t-shaped-code" - invalidating the stored tokens. Cause: "echo s3cr3t"')
    console.warn('[mcp-sdk] OAuth "invalid_grant" - invalidating the stored tokens. Cause: "echo s3cr3t"')
  } finally {
    write.mock.restore()
  }
  const text = written.join('')
  assert.ok(!text.includes('s3cr3t'), text)
  assert.ok(text.includes('OAuth "invalid_grant"'), text)
})
