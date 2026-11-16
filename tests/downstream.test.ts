// connectAll with real stdio children (tests/probe-server.mjs): a server whose
// connection closed connects again on next use, once for all callers, at most
// 3 times in 60 s, and never after close. HTTP servers built with the SDK
// check that a server that restarted connects again after one failed call, and
// that an error of the GET stream or of one request does not end the session.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ServerConfig, ServerKey } from '../src/core/config.ts'
import { connectAll, type Downstream } from '../src/host/downstream.ts'

const PROBE = path.join(import.meta.dirname, 'probe-server.mjs')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-downstream-test-'))
const KEY = 'p' as ServerKey
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

/** One probe server that exits 200 ms after it lists its tools, and a clock the test sets. */
const setup = () => {
  const file = path.join(DIR, `${randomUUID()}.json`)
  const server: ServerConfig = {
    kind: 'stdio',
    command: process.execPath,
    args: [PROBE, file, '--exit-after-list'],
    env: {},
  }
  const clock = { now: 0 }
  const downstream = connectAll(new Map([[KEY, server]]), '0', () => {}, { now: () => clock.now })
  opened.push(downstream)
  const starts = () =>
    fs
      .readFileSync(`${file}.log`, 'utf8')
      .split('\n')
      .filter(line => line.includes('"event":"start"')).length
  const closed = async () => {
    for (let i = 0; i < 100 && downstream.states()[0]?.status !== 'failed'; i++)
      await new Promise(r => setTimeout(r, 50))
    assert.equal(downstream.states()[0]?.status, 'failed', 'the probe server exited')
  }
  return { downstream, clock, starts, closed }
}

describe('reconnect', () => {
  test('a server whose connection closed connects again on next use, one time for all callers', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    const links = await Promise.all([downstream.client(KEY), downstream.client(KEY), downstream.client(KEY)])
    assert.deepEqual(
      links.map(l => l.ok),
      [true, true, true],
    )
    assert.equal(starts(), 2)
  })

  test('retry connects again each failed server, as search_tools does', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    await downstream.retry()
    assert.equal(downstream.states()[0]?.status, 'connected')
    assert.equal(starts(), 2)
  })

  test('two runs that name one failed server both wait for its one attempt', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    const statusAfter = (keys?: ServerKey[]) => downstream.retry(keys).then(() => downstream.states()[0]?.status)
    const [first, second, search] = await Promise.all([statusAfter([KEY]), statusAfter([KEY]), statusAfter()])
    assert.deepEqual([first, second], ['connected', 'connected'])
    assert.equal(search, 'connecting', 'a search does not wait for an attempt that another caller started')
    assert.equal(starts(), 2)
  })

  test('at most 3 attempts in 60 s, then the reason gives the wait, and after 60 s one more', async () => {
    const { downstream, clock, starts, closed } = setup()
    await downstream.settled
    for (const attempt of [2, 3]) {
      await closed()
      assert.equal((await downstream.client(KEY)).ok, true)
      assert.equal(starts(), attempt)
    }
    await closed()
    clock.now = 15_000
    const refused = await downstream.client(KEY)
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.reason, /the connection closed.*tries again on next use after 45 s$/)
    await downstream.retry()
    const state = downstream.states()[0]
    assert.match(state?.status === 'failed' ? state.reason : '', /tries again on next use after 45 s$/)
    assert.equal(starts(), 3, 'no attempt over the cap')
    clock.now = 60_000
    assert.equal((await downstream.client(KEY)).ok, true)
    assert.equal(starts(), 4)
  })

  test('no reconnect after close', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    await downstream.close()
    const link = await downstream.client(KEY)
    assert.equal(link.ok, false)
    assert.match(link.ok ? '' : link.reason, /shutting down/)
    await downstream.retry()
    assert.equal(starts(), 1)
  })

  test('an entry with config errors stays failed with its errors, and no search or call starts it', async () => {
    const lines: string[] = []
    const downstream = connectAll(
      new Map([[KEY, { kind: 'invalid', errors: ['mcpServers.p.env.T: ${T} is not set'] } as const]]),
      '0',
      line => lines.push(line),
    )
    opened.push(downstream)
    await downstream.settled
    await downstream.retry()
    await downstream.retry([KEY])
    const link = await downstream.client(KEY)
    assert.equal(link.ok, false)
    assert.deepEqual(downstream.states(), [
      {
        key: KEY,
        status: 'failed',
        reason: 'invalid entry in the toolscript-mcp config: mcpServers.p.env.T: ${T} is not set',
      },
    ])
    assert.equal(lines.filter(l => l.includes('connecting again')).length, 0, lines.join('\n'))
  })

  test('a transport that cannot be made fails only its server', async () => {
    const downstream = connectAll(
      new Map([[KEY, { kind: 'http', url: 'http://', headers: {} } as const]]),
      '0',
      () => {},
    )
    opened.push(downstream)
    await downstream.settled
    const state = downstream.states()[0]
    assert.match(state?.status === 'failed' ? state.reason : '', /Invalid URL/)
  })
})

/**
 * A stateful HTTP MCP server built with the SDK, with the tools `ping` and
 * `slow` (pong after 300 ms). A request with a session id that it does not
 * know gets `unknown`: a new transport, which answers 400 "Server not
 * initialized", or a 404, as the spec says. With `get`, each GET (the optional
 * SSE stream) gets that status, as a server with only POST /mcp gives. Like a
 * gateway that rejects one payload, it answers 400 to each call of `blocked`.
 */
const startHttp = async (port: number, unknown: 'new transport' | 404, get?: 400 | 404) => {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const fresh = async () => {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => void sessions.set(id, transport),
    })
    const mcp = new McpServer({ name: 'fake-http', version: '1.0.0' })
    const pong = { content: [{ type: 'text' as const, text: 'pong' }] }
    mcp.registerTool('ping', { description: 'Ping.' }, async () => pong)
    mcp.registerTool('slow', { description: 'Slow ping.' }, async () => {
      await new Promise(r => setTimeout(r, 300))
      return pong
    })
    await mcp.connect(transport)
    return transport
  }
  let gets = 0
  const server = http.createServer(async (req, res) => {
    // Later than the tool list, as from a server that is not on this host.
    if (req.method === 'GET' && get !== undefined) {
      await new Promise(r => setTimeout(r, 200))
      res.writeHead(get).end(http.STATUS_CODES[get])
      return void gets++
    }
    const id = req.headers['mcp-session-id']
    const known = typeof id === 'string' ? sessions.get(id) : undefined
    if (known === undefined && id !== undefined && unknown === 404)
      return void res.writeHead(404).end('Session not found')
    if (req.method !== 'POST') return void (await (known ?? (await fresh())).handleRequest(req, res))
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    if (body.includes('"name":"blocked"')) return void res.writeHead(400).end('Request blocked')
    await (known ?? (await fresh())).handleRequest(req, res, JSON.parse(body))
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    gets: () => gets,
    forget: () => sessions.clear(),
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

const PONG = JSON.stringify([{ type: 'text', text: 'pong' }])

/** connectAll with one HTTP server, its log, and a call of one of its tools that gives the content or the error. */
const connectHttp = (port: number) => {
  const lines: string[] = []
  const downstream = connectAll(
    new Map([[KEY, { kind: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} } as const]]),
    '0',
    line => lines.push(line),
  )
  opened.push(downstream)
  const call = async (name = 'ping'): Promise<string> => {
    const link = await downstream.client(KEY)
    if (!link.ok) return link.reason
    const r = await link.client.callTool({ name, arguments: {} }).catch((err: Error) => err)
    return r instanceof Error ? r.message : JSON.stringify(r.content)
  }
  return { downstream, call, lines }
}

describe('http', () => {
  for (const get of [404, 400] as const)
    test(`a server that answers ${get} to the GET stream stays connected`, async () => {
      const fake = await startHttp(0, 'new transport', get)
      const { downstream, call, lines } = connectHttp(fake.port)
      try {
        await downstream.settled
        for (let i = 0; i < 100 && fake.gets() === 0; i++) await new Promise(r => setTimeout(r, 20))
        assert.ok(fake.gets() > 0, 'the server answered the GET stream')
        await new Promise(r => setImmediate(r))
        assert.equal(downstream.states()[0]?.status, 'connected')
        assert.deepEqual([await call(), await call(), await call()], [PONG, PONG, PONG])
        assert.deepEqual(lines, ['p: connected, 2 tools'])
      } finally {
        await downstream.close()
        await fake.close()
      }
    })

  test('a 400 to one request fails only that call, and a call in flight still answers', async () => {
    const fake = await startHttp(0, 'new transport')
    const { downstream, call, lines } = connectHttp(fake.port)
    try {
      await downstream.settled
      const slow = call('slow')
      const blocked = await Promise.all([call('blocked'), call('blocked'), call('blocked')])
      for (const message of blocked) assert.match(message, /Request blocked/)
      assert.equal(await slow, PONG, 'the call in flight answers')
      assert.equal(await call(), PONG)
      assert.deepEqual(lines, ['p: connected, 2 tools'])
    } finally {
      await downstream.close()
      await fake.close()
    }
  })

  const cases = [
    { name: 'a server that restarted', unknown: 'new transport', restart: true, failure: /fetch failed/ },
    {
      name: 'a server that lost its sessions',
      unknown: 'new transport',
      restart: false,
      failure: /Server not initialized/,
    },
    {
      name: 'a server that answers 404 for a lost session',
      unknown: 404,
      restart: false,
      failure: /Session not found/,
    },
  ] as const
  for (const { name, unknown, restart, failure } of cases)
    test(`${name} fails one call, and the next call connects again`, async () => {
      let fake = await startHttp(0, unknown)
      const { downstream, call } = connectHttp(fake.port)
      try {
        await downstream.settled
        assert.equal(await call(), PONG)
        if (restart) {
          await fake.close()
          fake = await startHttp(fake.port, unknown)
        } else fake.forget()
        assert.match(await call(), failure)
        assert.equal(await call(), PONG, 'the call after the failed one connects again')
      } finally {
        await downstream.close()
        await fake.close()
      }
    })
})
