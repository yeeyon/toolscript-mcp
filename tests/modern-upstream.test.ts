// The factory rule of #154, PR 13: `serveStdio` calls the factory for a probe and again for the connection, so the state of the
// process is made one time, outside it, and every instance shares it. Three instances of one host: one downstream connect, one
// load of the learned shapes, one folder for `saveFile`, a result kept through one instance recalled through another, and an
// instance that is thrown away stops no run and removes no file.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../src/core/config.ts'
import { connectAll } from '../src/host/downstream.ts'
import { createHost } from '../src/host/server.ts'

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-modern-upstream-')))
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

/** A transport for an instance, and the raw peer on the other side of it. */
const rawPair = () => {
  const inbox: Msg[] = []
  const wire = (m: unknown): Msg => JSON.parse(JSON.stringify(m))
  const server: any = {
    start: async () => {},
    send: async (m: unknown) => void inbox.push(wire(m)),
    close: async () => void server.onclose?.(),
  }
  let next = 1
  const take = async (id: number | string, ms = 30_000): Promise<Msg> => {
    for (let waited = 0; waited <= ms; waited += 5) {
      const i = inbox.findIndex(m => m.id === id && m.method === undefined)
      if (i >= 0) return inbox.splice(i, 1)[0]!
      await sleep(5)
    }
    throw new Error('no answer; inbox ' + JSON.stringify(inbox).slice(0, 800))
  }
  const peer = {
    send: (m: Msg) => void queueMicrotask(() => server.onmessage?.({ jsonrpc: '2.0', ...wire(m) })),
    request: async (method: string, params?: unknown) => {
      const id = next++
      peer.send({ id, method, ...(params !== undefined && { params }) })
      const r = await take(id)
      return r.error !== undefined ? { error: r.error } : { result: r.result }
    },
    run: async (code: string): Promise<string> => {
      const r = (await peer.request('tools/call', { name: 'run_code', arguments: { code } })) as any
      assert.ok(r.result, JSON.stringify(r))
      return r.result.content.map((b: any) => b.text ?? '').join('')
    },
  }
  return { server, peer }
}

describe('the factory is called more than once', () => {
  test('one downstream connect, one shapes load, one files folder, a kept result recalled across instances, a discarded instance harmless', async () => {
    // A broken shapes file: each load of it logs one line, so the lines count the loads.
    const learned = path.join(HOME, '.toolscript-mcp', 'learned')
    fs.mkdirSync(learned, { recursive: true })
    fs.writeFileSync(path.join(learned, 'shapes.json'), '{ not json')
    const starts = path.join(ROOT, 'starts.log')
    const server = path.join(import.meta.dirname, 'first-message-server.mjs')
    const text = JSON.stringify({
      mcpServers: { fms: { command: process.execPath, args: [server, `--log=${starts}`], share: false } },
      policy: [{ match: 'mcp__fms__*', action: 'allow' }],
    })
    const file = path.join(ROOT, 'config.json')
    fs.writeFileSync(file, text)
    const parsed = parseConfig(text, process.env, process.execPath, process.platform)
    assert.ok(parsed.ok)
    const { config } = parsed
    const logs: string[] = []
    const downstream = connectAll(config.servers, '0', () => {}, {})
    const host = createHost(downstream, config, file, '0.0.0', line => logs.push(line))
    closers.push(async () => {
      await host.stopRuns()
      await downstream.close()
    })

    // The factory is called three times: a connection, a probe that is thrown away, and a second connection.
    const first = host.make('legacy')
    const probe = host.make('modern')
    const second = host.make('legacy')
    // The load of the shapes began with the host, and the three instances added none (a run saves shapes later, which reads
    // the file again, so the count is taken before any run).
    const loads = () => logs.filter(l => l.includes('learned shapes were not loaded')).length
    for (let i = 0; i < 400 && loads() === 0; i++) await sleep(10)
    await sleep(200)
    assert.equal(loads(), 1, 'one load of the learned shapes for three instances')
    const pairs = [rawPair(), rawPair()]
    await first.connect(pairs[0]!.server)
    await second.connect(pairs[1]!.server)
    for (const pair of pairs)
      await pair.peer.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw', version: '0' },
      })
    for (const pair of pairs) pair.peer.send({ method: 'notifications/initialized' })

    // A run in flight on the first instance, while the probe instance is closed.
    const slow = pairs[0]!.peer.run('await sleep(700); return "slow done"')
    await sleep(100)
    await probe.close()
    assert.match(await slow, /^"slow done"/, 'closing a discarded instance stops no run')

    const saved = await pairs[0]!.peer.run('return await saveFile("shared.txt", "from the first")')
    const kept = await pairs[0]!.peer.run('const r = await call("mcp__fms__ask", {}); return r.length')
    const keptRef = /recall\((\d+)\)/.exec(kept)?.[1] ?? '1'
    // The second instance sees the file that the first saved, and recalls the result that the first kept.
    const read = await pairs[1]!.peer.run('return await readFile("shared.txt")')
    const recalled = await pairs[1]!.peer.run(`const r = await recall(${keptRef}); return r.length`)
    assert.equal(
      read.split('\n')[0],
      '"from the first"',
      'one saveFile folder: a file of one instance is read by another',
    )
    assert.equal(
      recalled.split('\n')[0],
      kept.split('\n')[0],
      'a result kept through one instance is recalled through another',
    )
    const dir = path.dirname(saved.split('\n')[0]!.replace(/^"|"$/g, ''))
    assert.ok(
      fs.existsSync(path.join(dir, 'shared.txt')),
      'the file of the first instance is still there after the probe closed',
    )

    assert.equal(
      fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length,
      1,
      'one downstream connect for all instances',
    )
  })
})
