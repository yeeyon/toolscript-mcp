// The first message of each kind of link: the `initialize` request that the client sends (protocol version offered,
// client info, capabilities), byte for byte, for a direct stdio link, a shared link (through a broker in this process)
// and the built-in Workspace. The expected texts in tests/fixtures/initialize-golden.json were recorded at the base of the
// SDK move (`GOLDEN_RECORD=1`). A client of another SDK that offers another version or capability, or probes with
// `server/discover`, changes them (issue #154, PR 5).

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerConfig, ServerKey } from '../src/core/config.ts'
import { WORKSPACE_KEY } from '../src/core/workspace.ts'
import { startBroker } from '../src/host/broker.ts'
import { BrokerTransport } from '../src/host/brokerlink.ts'
import { ChildTransport } from '../src/host/childtransport.ts'
import { connectAll } from '../src/host/downstream.ts'
import { storeFile } from '../src/host/oauth.ts'
import { startGoldenHttp } from './golden-http.ts'
import { bindWorkspace, linkOf } from '../src/host/workspace/bind.ts'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'initialize-golden.json')
const RECORD = process.env.GOLDEN_RECORD === '1'
const PID_SERVER = path.join(import.meta.dirname, 'pid-server.mjs')
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-init-golden-')))
const closers: (() => Promise<void> | void)[] = []
after(async () => {
  for (const close of closers.reverse()) await close()
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
})
const golden: Record<string, string> =
  RECORD || !fs.existsSync(FIXTURE) ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const recorded: Record<string, string> = {}
after(() => {
  if (RECORD) fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
})

/** The first message that a transport sends, as the text of its JSON, and every method that it sent. */
type Sends = { first: string | undefined; methods: string[] }
const watch = (sends: Sends, message: unknown): void => {
  const m = message as { method?: string }
  sends.first ??= JSON.stringify(message)
  if (m.method !== undefined) sends.methods.push(m.method)
}
const KEY = 'g' as ServerKey

const settle = (kind: string, sends: Sends): void => {
  assert.ok(
    sends.first?.includes('"method":"initialize"'),
    `the first message of ${kind} is initialize: ${sends.first}`,
  )
  assert.ok(!sends.methods.includes('server/discover'), `${kind} sent server/discover`)
  recorded[kind] = sends.first
  if (!RECORD) assert.equal(sends.first, golden[kind], `the initialize of ${kind} changed`)
}

test('a direct stdio link', async () => {
  const sends: Sends = { first: undefined, methods: [] }
  const send = ChildTransport.prototype.send
  ChildTransport.prototype.send = function (message, ...rest) {
    watch(sends, message)
    return send.call(this, message, ...rest)
  }
  closers.push(() => void (ChildTransport.prototype.send = send))
  const servers = new Map<ServerKey, ServerConfig>([
    [KEY, { kind: 'stdio', command: process.execPath, args: [PID_SERVER], env: {} }],
  ])
  const downstream = connectAll(servers, '0', () => {})
  closers.push(() => downstream.close())
  await downstream.settled
  assert.equal(downstream.states()[0]?.status, 'connected')
  settle('stdio', sends)
  ChildTransport.prototype.send = send
})

test('a shared link through a broker', async () => {
  const sends: Sends = { first: undefined, methods: [] }
  const send = BrokerTransport.prototype.send
  BrokerTransport.prototype.send = function (message, ...rest) {
    watch(sends, message)
    return send.call(this, message, ...rest)
  }
  closers.push(() => void (BrokerTransport.prototype.send = send))
  const home = fs.mkdtempSync(path.join(ROOT, 'h-'))
  const file = path.join(home, 'broker.js')
  fs.writeFileSync(file, 'build golden')
  const broker = await startBroker({ home, idleMs: 600_000, file })
  assert.ok(broker, 'the broker listens')
  closers.push(() => broker.stop())
  const servers = new Map<ServerKey, ServerConfig>([
    [KEY, { kind: 'stdio', command: process.execPath, args: [PID_SERVER], env: {} }],
  ])
  const downstream = connectAll(servers, '0', () => {}, {
    share: { bridges: new Set(), home, folder: home, brokerFile: file },
  })
  closers.push(() => downstream.close())
  await downstream.settled
  assert.equal(downstream.states()[0]?.status, 'connected')
  settle('shared', sends)
  BrokerTransport.prototype.send = send
})

test('the built-in Workspace', async t => {
  const sends: Sends = { first: undefined, methods: [] }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(ROOT, 'ws-')))
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(ROOT, 'wh-')))
  const binding = await bindWorkspace({
    workspace: { roots: [{ path: root, write: false }], exclude: [], skip: [] },
    start: root,
    home,
    configFile: path.join(home, 'c.json'),
    log: () => {},
  })
  if (!binding.ok) return void t.skip(binding.reason)
  closers.push(() => binding.bound.provider.close())
  const link = linkOf(binding)
  assert.ok(link.ok)
  const servers = new Map<ServerKey, ServerConfig>([
    [WORKSPACE_KEY as ServerKey, { kind: 'workspace', untrusted: true }],
  ])
  const watched = {
    ok: true as const,
    serve: async () => {
      const transport = await link.serve()
      const send = transport.send.bind(transport)
      transport.send = (message, options) => {
        watch(sends, message)
        return send(message, options)
      }
      return transport
    },
  }
  const downstream = connectAll(servers, '0', () => {}, { workspace: watched, home })
  closers.push(() => downstream.close())
  await downstream.settled
  assert.equal(downstream.states()[0]?.status, 'connected')
  settle('workspace', sends)
})

const NAMES = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'authorization']

for (const oauth of [false, true]) {
  test(`an HTTP link ${oauth ? 'with' : 'without'} OAuth`, async () => {
    const fake = await startGoldenHttp()
    closers.push(() => fake.close())
    const home = fs.mkdtempSync(path.join(ROOT, 'hh-'))
    const url = `${fake.origin}/ok`
    if (oauth) {
      const file = storeFile(home, KEY, url)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const client = { info: { client_id: 'golden-client' }, redirectUrl: 'http://127.0.0.1:1/callback' }
      const tokens = { access_token: 'golden-access-1', token_type: 'Bearer', refresh_token: 'golden-refresh-1' }
      fs.writeFileSync(file, JSON.stringify({ client, tokens }))
    }
    const servers = new Map<ServerKey, ServerConfig>([
      [KEY, { kind: 'http', url, headers: {}, ...(oauth && { oauth: { scopes: [] } }) }],
    ])
    const downstream = connectAll(servers, '0', () => {}, { home })
    closers.push(() => downstream.close())
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'connected')
    const posts = fake.seen.filter(s => s.method === 'POST' && s.path === '/ok')
    const first = posts.find(s => s.body.includes('"method":"initialize"'))
    const initialized = posts.find(s => s.body.includes('notifications/initialized'))
    const listed = posts.find(s => s.body.includes('"method":"tools/list"'))
    assert.ok(first && initialized && listed)
    for (const s of fake.seen) {
      assert.ok(!s.body.includes('server/discover'), 'server/discover was sent')
      for (const name of ['mcp-method', 'mcp-name']) assert.equal(s.headers[name], undefined, `${name} was sent`)
    }
    const kind = oauth ? 'http-oauth' : 'http'
    const pick = (s: { headers: Record<string, string> }) =>
      Object.fromEntries(NAMES.filter(n => s.headers[n] !== undefined).map(n => [n, s.headers[n]]))
    recorded[kind] = JSON.stringify({
      initialize: first.body,
      headers: [first, initialized, listed].map(pick),
    })
    if (!RECORD) assert.equal(recorded[kind], golden[kind], `the first requests of ${kind} changed`)
  })
}
