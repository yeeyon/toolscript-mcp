// The clock rows of the approval on a 2026-07-28 connection (issue #154, P3-1): a state expires in 10 minutes. The host is in this
// process, wired as `auto` wires it (`serveStdio` and the factory), so the test sets the clock that the codec reads. The other rows are
// in tests/modern-approval.e2e.mjs, against the built server.

import { after, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../src/core/config.ts'
import { connectAll } from '../src/host/downstream.ts'
import { serveBoth } from '../src/host/serve.ts'
import { createHost } from '../src/host/server.ts'

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-modern-approval-')))
const HOME = path.join(ROOT, 'home')
fs.mkdirSync(path.join(HOME, 'appdata'), { recursive: true })
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = HOME
process.env.APPDATA = path.join(HOME, 'appdata')
const closers: (() => Promise<void> | void)[] = []
after(async () => {
  for (const close of closers.reverse()) await close()
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
})

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const FAKE = path.join(import.meta.dirname, '..', 'bench', 'fake-server.mjs')
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
}
const CODE = 'const r = await call("mcp__bench__get_deploys", { date: "2026-10-09" }); return r.count'

const open = async () => {
  const log = path.join(fs.mkdtempSync(path.join(ROOT, 'c-')), 'calls.jsonl')
  const text = JSON.stringify({
    mcpServers: { bench: { command: process.execPath, args: [FAKE], env: { BENCH_LOG: log } } },
    policy: [{ match: 'mcp__bench__get_deploys', action: 'ask' }],
  })
  const file = path.join(path.dirname(log), 'config.json')
  fs.writeFileSync(file, text)
  const parsed = parseConfig(text, process.env, process.execPath, process.platform)
  assert.ok(parsed.ok)
  const downstream = connectAll(parsed.config.servers, '0', () => {}, {})
  const host = createHost(downstream, parsed.config, file, '0.0.0', () => {})
  const inbox: Msg[] = []
  const wire = (m: unknown): Msg => JSON.parse(JSON.stringify(m))
  const server: any = {
    start: async () => {},
    send: async (m: unknown) => void inbox.push(wire(m)),
    close: async () => void server.onclose?.(),
  }
  const handle = serveBoth(host, { transport: server, log: () => {} })
  closers.push(async () => {
    await handle.close()
    await host.stopRuns()
    await downstream.close()
  })
  let next = 1
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = next++
    queueMicrotask(() => server.onmessage?.({ jsonrpc: '2.0', id, method, params: { ...params, _meta: ENVELOPE } }))
    for (let i = 0; i < 12_000; i++) {
      const at = inbox.findIndex(m => m.id === id && m.method === undefined)
      if (at >= 0) return inbox.splice(at, 1)[0]!
      await sleep(5)
    }
    throw new Error('no answer to ' + method)
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0)
  await request('server/discover', {})
  return { request, calls }
}

const asked = async (s: Awaited<ReturnType<typeof open>>) => {
  const first = await s.request('tools/call', { name: 'run_code', arguments: { code: CODE } })
  assert.equal(first.result?.resultType, 'input_required', JSON.stringify(first).slice(0, 300))
  return first.result.requestState as string
}
const retry = (s: Awaited<ReturnType<typeof open>>, state: string) =>
  s.request('tools/call', {
    name: 'run_code',
    arguments: { code: CODE },
    inputResponses: { approve: { action: 'accept', content: {} } },
    requestState: state,
  })

describe('the life of a state', () => {
  test('a state of 599 s runs the program, and one of 601 s is -32602 and runs nothing', async t => {
    const s = await open()
    const fresh = await asked(s)
    const old = await asked(s)
    const real = Date.now
    t.mock.method(Date, 'now', () => real() + 599_000)
    const inTime = await retry(s, fresh)
    assert.ok(!inTime.error && !inTime.result.isError, JSON.stringify(inTime).slice(0, 300))
    assert.equal(s.calls(), 1)
    mock.restoreAll()
    t.mock.method(Date, 'now', () => real() + 601_000)
    const late = await retry(s, old)
    assert.equal(late.error?.code, -32602)
    assert.equal(late.error?.message, 'Invalid or expired requestState')
    assert.equal(s.calls(), 1, 'the expired state ran nothing')
    mock.restoreAll()
    // The states of the table that expired are swept: a new state is asked and used as usual.
    const again = await asked(s)
    assert.ok(!(await retry(s, again)).error)
    assert.equal(s.calls(), 2)
  })
})
