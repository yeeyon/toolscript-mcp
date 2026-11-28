// The requests that a login sends to its authorization server: the registration, the authorization URL and the code
// exchange, recorded at the base of the SDK move (`GOLDEN_RECORD=1`) and compared after it (issue #154, PR 6). The one
// change that the new SDK makes is `application_type` in the registration body, which this test names.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runLogin } from '../src/host/login.ts'
import { servers, startFake } from './fake-oauth.ts'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'login-golden.json')
const RECORD = process.env.GOLDEN_RECORD === '1'
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-login-golden-'))
after(() => {
  for (const s of servers) (s.closeAllConnections(), s.close())
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

/** A browser that follows the authorization redirect to the callback. */
const browser = (url: string): void =>
  void (async () => {
    const answer = await fetch(url, { redirect: 'manual' })
    await fetch(new URL(answer.headers.get('location') ?? ''))
  })()

test('the registration, the authorization URL and the code exchange of a login', async () => {
  const fake = await startFake()
  const home = fs.mkdtempSync(path.join(DIR, 'home-'))
  const file = path.join(home, 'config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ mcpServers: { fake: { type: 'http', url: fake.url, oauth: { scopes: ['a', 'b'] } } } }),
  )
  const lines: string[] = []
  const code = await runLogin(['fake', '--config', file], {
    env: {},
    platform: process.platform,
    home,
    version: '0',
    print: t => void lines.push(t),
    open: browser,
  })
  const mask = (text: string): string => text.replaceAll(String(fake.port), 'N').replace(/:\d{4,5}\//g, ':P/')
  const shape = (value: unknown): unknown => JSON.parse(mask(JSON.stringify(value)))
  const authorize = fake.seen.authorizations[0]!.searchParams
  const exchange = fake.seen.tokens.find(f => f.get('grant_type') === 'authorization_code')!
  const record = {
    code,
    // The URL has a random state, challenge and port: its parts are below.
    lines: lines.map(l => mask(l.split('\n')[0] ?? '').replace(/(tokens are in ).*/, '$1STORE')),
    registered: shape(fake.seen.registered),
    authorize: {
      names: [...authorize.keys()].sort(),
      fixed: Object.fromEntries(
        ['response_type', 'code_challenge_method', 'scope', 'resource', 'redirect_uri'].map(k => [
          k,
          mask(authorize.get(k) ?? ''),
        ]),
      ),
    },
    exchange: {
      names: [...exchange.keys()].sort(),
      grant_type: exchange.get('grant_type'),
      resource: mask(exchange.get('resource') ?? ''),
      redirect_uri: mask(exchange.get('redirect_uri') ?? ''),
    },
    tokenTypes: fake.seen.tokenTypes,
  }
  if (RECORD) return void fs.writeFileSync(FIXTURE, `${JSON.stringify(record, null, 2)}\n`)
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as typeof record & {
    registered: Record<string, unknown>[]
  }
  // The registration of the new SDK names the kind of application: a native one, for a loopback redirect.
  const registered = JSON.parse(JSON.stringify(record.registered)) as Record<string, unknown>[]
  for (const body of registered) {
    // Absent at the base, native after it.
    if (body.application_type !== undefined) assert.equal(body.application_type, 'native')
    delete body.application_type
  }
  assert.deepEqual({ ...record, registered }, { ...golden, registered: golden.registered })
})
