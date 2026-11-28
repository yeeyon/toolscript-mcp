// The golden test of what a client of the MCP server sees (issue #154, Phase 1 PR 7). The peer is raw: plain JSON-RPC
// objects over a pair that this file makes, with no SDK client, so the SDK that serves can change and the bytes must not.
// The expected texts in tests/fixtures/upstream-golden.json were recorded at the base of the server move
// (`GOLDEN_RECORD=1`). A difference of key order alone passes and is named on stderr, since no client reads it; any other
// difference fails. The last cases run the built `dist/host/main.js` over stdio, so the transport is in them.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseConfig, type Config } from '../src/core/config.ts'
import { connectAll } from '../src/host/downstream.ts'
import { createServer } from '../src/host/server.ts'
import { createRoots } from '../src/host/workspace/roots.ts'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'upstream-golden.json')
const RECORD = process.env.GOLDEN_RECORD === '1'
const MAIN = path.join(import.meta.dirname, '..', 'dist', 'host', 'main.js')
const DEMO = path.join(import.meta.dirname, '..', 'demo', 'server.mjs')
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-upstream-golden-')))
const HOME = path.join(ROOT, 'home')
fs.mkdirSync(path.join(HOME, 'appdata'), { recursive: true })
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = HOME
process.env.APPDATA = path.join(HOME, 'appdata')
process.env.TOOLSCRIPT_SHARE = '0'
const TMP = path.join(ROOT, 'tmp')
fs.mkdirSync(TMP)
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = TMP
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

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value

/** Asserts the bytes of `value` against the fixture, or records them. */
const settle = (name: string, value: unknown): void => {
  const text = JSON.stringify(value)
  recorded[name] = text
  if (RECORD) return
  const expected = golden[name]
  assert.notEqual(expected, undefined, `no golden value of ${name}`)
  if (text === expected) return
  assert.deepEqual(canonical(JSON.parse(text)), canonical(JSON.parse(expected!)), `the golden value of ${name} changed`)
  console.error(`[golden] ${name}: the same content in another key order`)
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any }

/** A transport for the server and the raw peer on the other side of it. A message is cloned as a wire would carry it. */
const rawPair = () => {
  const inbox: Msg[] = []
  const wire = (m: unknown): Msg => JSON.parse(JSON.stringify(m))
  const server: any = {
    start: async () => {},
    send: async (m: unknown) => void inbox.push(wire(m)),
    close: async () => void server.onclose?.(),
  }
  const take = async (match: (m: Msg) => boolean, ms = 60_000): Promise<Msg> => {
    for (let waited = 0; waited <= ms; waited += 5) {
      const i = inbox.findIndex(match)
      if (i >= 0) return inbox.splice(i, 1)[0]!
      await sleep(5)
    }
    throw new Error('no message arrived; inbox ' + JSON.stringify(inbox).slice(0, 1500))
  }
  let next = 1
  const peer = {
    inbox,
    send: (m: Msg) => void queueMicrotask(() => server.onmessage?.({ jsonrpc: '2.0', ...wire(m) })),
    take,
    /** Sends a request and returns what answered it, as `{ result }` or `{ error }`. */
    request: async (method: string, params?: unknown, id: number | string = next++) => {
      peer.send({ id, method, ...(params !== undefined && { params }) })
      const r = await take(m => m.id === id && m.method === undefined)
      return r.error !== undefined ? { error: r.error } : { result: r.result }
    },
    close: () => server.close(),
  }
  return { server, peer }
}

const configOf = (value: unknown): { config: Config; file: string } => {
  const file = path.join(fs.mkdtempSync(path.join(ROOT, 'c-')), 'config.json')
  const text = JSON.stringify(value)
  fs.writeFileSync(file, text)
  const parsed = parseConfig(text, process.env, process.execPath, process.platform)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
  return { config: parsed.config, file }
}

const EMPTY = { mcpServers: {} }
const DEMO_CONFIG = {
  mcpServers: { demo: { command: process.execPath, args: [DEMO] } },
  policy: [{ match: 'mcp__demo__list_pull_requests', action: 'ask' }],
}
const ASKING = 'return await call("mcp__demo__list_pull_requests", { state: "all", per_page: 1 })'

/** A server on a raw pair. `connect` is false for a case that sends its first message itself. */
const open = async (value: unknown = EMPTY) => {
  const { config, file } = configOf(value)
  const logs: string[] = []
  const downstream = connectAll(config.servers, '0', () => {}, {})
  const served = createServer(downstream, config, file, '0.0.0', line => logs.push(line))
  const pair = rawPair()
  await served.server.connect(pair.server)
  closers.push(async () => {
    await pair.peer.close()
    await served.stopRuns()
    await downstream.close()
  })
  const initialize = (capabilities: object = {}, protocolVersion = '2025-11-25') =>
    pair.peer.request('initialize', { protocolVersion, capabilities, clientInfo: { name: 'raw', version: '0' } })
  const initialized = async (capabilities: object = {}) => {
    const r = await initialize(capabilities)
    pair.peer.send({ method: 'notifications/initialized' })
    return r
  }
  return { served, peer: pair.peer, initialize, initialized, logs }
}

const run = (peer: ReturnType<typeof rawPair>['peer'], code: string, id?: number | string) =>
  peer.request('tools/call', { name: 'run_code', arguments: { code } }, id)

describe('initialize', () => {
  for (const [label, value] of [
    ['empty', EMPTY],
    ['demo', DEMO_CONFIG],
  ] as const)
    test(`the whole result, for each version a client can ask, with the ${label} config`, async () => {
      const results: Record<string, any> = {}
      for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '1999-01-01', '2026-07-28']) {
        const s = await open(value)
        results[version] = await s.initialize({}, version)
      }
      settle(`initialize/${label}`, results)
      for (const version of ['1999-01-01', '2026-07-28'])
        assert.equal(
          results[version].result.protocolVersion,
          results['2025-11-25'].result.protocolVersion,
          `${version} is answered with the first legacy version`,
        )
    })
})

describe('the plain requests', () => {
  test('tools/list, ping, an unknown method, and tools/call with a bad name or bad arguments', async () => {
    const s = await open()
    await s.initialized()
    const out: Record<string, unknown> = {}
    const list = await s.peer.request('tools/list')
    out.list =
      'result' in list ? { bytes: JSON.stringify(list.result).length, sha: sha(JSON.stringify(list.result)) } : list
    out.listNames = 'result' in list ? list.result.tools.map((t: any) => t.name) : undefined
    out.ping = await s.peer.request('ping')
    out.unknownMethod = await s.peer.request('no/such-method')
    out.unknownTool = await s.peer.request('tools/call', { name: 'no_such_tool', arguments: {} })
    out.noCode = await s.peer.request('tools/call', { name: 'run_code', arguments: {} })
    out.noArguments = await s.peer.request('tools/call', { name: 'run_code' })
    out.wrongType = await s.peer.request('tools/call', { name: 'run_code', arguments: { code: 5 } })
    out.extraKey = await s.peer.request('tools/call', { name: 'run_code', arguments: { code: 'return 1', extra: 1 } })
    out.noName = await s.peer.request('tools/call', { arguments: {} })
    out.searchBadType = await s.peer.request('tools/call', { name: 'search_tools', arguments: { query: 5 } })
    out.search = await s.peer.request('tools/call', { name: 'search_tools', arguments: { query: 'zzz' } })
    out.runOk = await run(s.peer, 'return 1')
    settle('plain', out)
    assert.equal(
      sha(JSON.stringify((list as any).result)),
      'a158f339e944a5fa7387b5ce38005b4955fa12a5670d4ef29639e2951d59a420',
    )
  })

  test('a request before initialize', async () => {
    const s = await open()
    settle('beforeInit', await s.peer.request('tools/list'))
  })
})

describe('the probe of a client that asks for the 2026 protocol (G4)', () => {
  const ENVELOPE = {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  }

  test('server/discover first, bare and with the envelope, then a normal session', async () => {
    const out: Record<string, unknown> = {}
    for (const [label, params] of [
      ['bare', undefined],
      ['envelope', ENVELOPE],
    ] as const) {
      const s = await open()
      const probe = await s.peer.request('server/discover', params)
      assert.ok('error' in probe, 'the probe is answered with an error, never a result')
      const init = await s.initialized()
      const list = await s.peer.request('tools/list')
      out[label] = {
        probe,
        init,
        list: 'result' in list ? sha(JSON.stringify(list.result)) : list,
        ping: await s.peer.request('ping'),
      }
    }
    settle('probe', out)
  })

  test('server/discover after initialize', async () => {
    const s = await open()
    await s.initialized()
    const probe = await s.peer.request('server/discover', ENVELOPE)
    assert.ok('error' in probe)
    const list = await s.peer.request('tools/list')
    settle('probeAfter', { probe, list: 'result' in list ? sha(JSON.stringify(list.result)) : list })
  })
})

describe('the ask', () => {
  const ELICIT = { elicitation: { form: {} } }
  const asked = async (answer: (m: Msg) => Msg | 'none', capabilities: object = ELICIT) => {
    const s = await open(DEMO_CONFIG)
    await s.initialized(capabilities)
    s.peer.send({ id: 900, method: 'tools/call', params: { name: 'run_code', arguments: { code: ASKING } } })
    const ask = await s.peer.take(m => m.method === 'elicitation/create')
    const reply = answer(ask)
    if (reply !== 'none') s.peer.send({ id: ask.id, ...(reply as Msg) })
    const done = await s.peer.take(m => m.id === 900)
    return { params: ask.params, done: done.error !== undefined ? { error: done.error } : { result: done.result } }
  }

  test('the request, and the result for accept, decline, cancel, a bad answer and an error', async () => {
    const out: Record<string, unknown> = {}
    out.accept = await asked(() => ({ result: { action: 'accept', content: {} } }))
    out.decline = await asked(() => ({ result: { action: 'decline' } }))
    out.cancel = await asked(() => ({ result: { action: 'cancel' } }))
    out.badAction = await asked(() => ({ result: { action: 'maybe' } }))
    out.badResult = await asked(() => ({ result: {} }))
    out.error = await asked(() => ({ error: { code: -32603, message: 'the person left' } }))
    settle('ask', out)
  })

  test('a client with no elicitation capability is refused with the same text', async () => {
    const s = await open(DEMO_CONFIG)
    await s.initialized({})
    const r = await run(s.peer, ASKING)
    assert.ok(!s.peer.inbox.some(m => m.method === 'elicitation/create'))
    settle('askUnsupported', r)
  })

  test('a client that declared an empty elicitation capability is asked, as a form client', async () => {
    settle('askEmptyCapability', await asked(() => ({ result: { action: 'decline' } }), { elicitation: {} }))
  })
})

describe('roots', () => {
  const asked = async (capabilities: object, answer: (m: Msg) => Msg | 'none', waitMs = 5_000) => {
    const s = await open()
    const roots = createRoots({ log: () => {}, waitMs })
    roots.attach(s.served.server)
    await s.initialize(capabilities)
    assert.equal(s.peer.inbox.length, 0, 'no roots/list before notifications/initialized')
    s.peer.send({ method: 'notifications/initialized' })
    let request: Msg | undefined
    if ('roots' in capabilities) {
      request = await s.peer.take(m => m.method === 'roots/list')
      const reply = answer(request)
      if (reply !== 'none') s.peer.send({ id: request.id, ...reply })
    } else await sleep(200)
    const uris = await roots.read()
    const sent = s.peer.inbox.filter(m => m.method === 'roots/list').length
    roots.close()
    return { request: request && { method: request.method, params: request.params }, uris, extra: sent }
  }

  test('one roots/list after initialized with the capability, and none without it', async () => {
    const out: Record<string, unknown> = {}
    out.list = await asked({ roots: {} }, () => ({
      result: { roots: [{ uri: 'file:///a', name: 'a' }, { uri: 'file:///b' }] },
    }))
    out.error = await asked({ roots: { listChanged: true } }, () => ({ error: { code: -32601, message: 'no' } }))
    out.none = await asked({ roots: {} }, () => 'none', 300)
    out.noCapability = await asked({}, () => 'none')
    settle('roots', out)
  })
})

describe('cancel and a request twice', () => {
  const SLOW = 'await sleep(20000); return 1'

  test('notifications/cancelled ends the run and sends no answer for it', async () => {
    const s = await open()
    await s.initialized()
    s.peer.send({ id: 500, method: 'tools/call', params: { name: 'run_code', arguments: { code: SLOW } } })
    await sleep(700)
    s.peer.send({ method: 'notifications/cancelled', params: { requestId: 500, reason: 'test' } })
    const ping = await s.peer.request('ping')
    await sleep(700)
    settle('cancel', { ping, answered: s.peer.inbox.filter(m => m.id === 500) })
  })

  test('a client that cancels a run while its approval prompt is pending: one cancel of the prompt with the reason, nothing else', async () => {
    const s = await open(DEMO_CONFIG)
    await s.initialized({ elicitation: { form: {} } })
    s.peer.send({ id: 600, method: 'tools/call', params: { name: 'run_code', arguments: { code: ASKING } } })
    const ask = await s.peer.take(m => m.method === 'elicitation/create')
    s.peer.send({ method: 'notifications/cancelled', params: { requestId: 600, reason: 'the person pressed escape' } })
    const ping = await s.peer.request('ping')
    await sleep(700)
    // The id of the prompt is the server's own: it is named `prompt` when it is the one that the cancel refers to.
    const after = s.peer.inbox.map(m => ({
      ...m,
      ...(m.params?.requestId === ask.id && { params: { ...m.params, requestId: 'prompt' } }),
    }))
    settle('cancelWhileAsking', { ping, after })
  })

  test('an id in flight twice', async () => {
    const s = await open()
    await s.initialized()
    const code = 'await sleep(400); return 7'
    s.peer.send({ id: 77, method: 'tools/call', params: { name: 'run_code', arguments: { code } } })
    s.peer.send({ id: 77, method: 'tools/call', params: { name: 'run_code', arguments: { code } } })
    await s.peer.take(m => m.id === 77)
    await sleep(2_000)
    settle('sameId', { more: s.peer.inbox.filter(m => m.id === 77).map(m => m.error ?? m.result) })
  })
})

/** A raw peer over the stdio of the built server. */
const stdio = async (configValue: unknown, onLine?: (line: string) => void) => {
  const { file } = configOf(configValue)
  const child = spawn(process.execPath, [MAIN, '--config', file], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines: string[] = []
  const messages: Msg[] = []
  readline.createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line)
    onLine?.(line)
    try {
      messages.push(JSON.parse(line))
    } catch {
      /* named by the check of `lines` */
    }
  })
  child.stderr.resume()
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  closers.push(() => void child.kill())
  let next = 1
  const send = (m: Msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  const request = async (method: string, params?: unknown) => {
    const id = next++
    send({ id, method, ...(params !== undefined && { params }) })
    for (let i = 0; i < 4_000; i++) {
      const i2 = messages.findIndex(m => m.id === id)
      if (i2 >= 0) {
        const r = messages.splice(i2, 1)[0]!
        return r.error !== undefined ? { error: r.error } : { result: r.result }
      }
      await sleep(5)
    }
    throw new Error(`no answer to ${method}`)
  }
  return { child, lines, messages, send, request, exited }
}

const onlyJsonRpc = (lines: readonly string[]): void => {
  for (const line of lines) {
    const m = JSON.parse(line)
    assert.equal(m.jsonrpc, '2.0', `a line of stdout that is not JSON-RPC: ${line.slice(0, 80)}`)
  }
}

describe('the built server over stdio', () => {
  const built = fs.existsSync(MAIN)
  const mask = (value: any) => JSON.parse(JSON.stringify(value).replace(/"version":"[^"]*"/u, '"version":"<version>"'))

  test(
    'server/discover first, then initialize, initialized and tools/list',
    { skip: !built && 'no build' },
    async () => {
      const s = await stdio(EMPTY)
      const probe = await s.request('server/discover', {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      })
      const init = await s.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw', version: '0' },
      })
      s.send({ method: 'notifications/initialized' })
      const list = await s.request('tools/list')
      const again = await s.request('server/discover')
      settle('stdioProbe', {
        probe,
        init: mask(init),
        list: 'result' in list ? sha(JSON.stringify(list.result)) : list,
        again,
      })
      onlyJsonRpc(s.lines)
      s.child.stdin.end()
      await s.exited
    },
  )

  test(
    'the peer closing in the middle of a run ends the process, with only JSON-RPC on stdout',
    { skip: !built && 'no build' },
    async () => {
      const s = await stdio(EMPTY)
      await s.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw', version: '0' },
      })
      s.send({ method: 'notifications/initialized' })
      s.send({
        id: 99,
        method: 'tools/call',
        params: { name: 'run_code', arguments: { code: 'await sleep(20000); return 1' } },
      })
      await sleep(800)
      s.child.stdin.end()
      const code = await Promise.race([s.exited, sleep(15_000).then(() => 'still running')])
      assert.notEqual(code, 'still running', 'the server ends when its client closes')
      onlyJsonRpc(s.lines)
      settle('stdioClose', { answeredTheRun: s.messages.some(m => m.id === 99) })
    },
  )
})
