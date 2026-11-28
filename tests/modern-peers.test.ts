// Self-tests of the raw modern peers (issue #154, C0): the exchange that each peer gives to the raw client.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { startHttp } from './modern-http.mjs'
import { aliveCount, connectPeer, killAll, OPENINGS, replay, within } from './modern-client.mjs'

after(async () => {
  await killAll()
  assert.equal(aliveCount(), 0, 'a peer process is left behind')
})

const names = answer => answer.result.tools.map(t => t.name)
const json = r => r.json()
const text = answer => JSON.parse(answer.result.content[0].text)

describe('modern', () => {
  test('answers server/discover, refuses initialize and a request with no version, keeps no state between requests', async () => {
    const c = connectPeer('modern')
    const discover = await c.discover()
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28'])
    assert.deepEqual(discover.result.capabilities, { tools: { listChanged: true } })
    assert.deepEqual(discover.result._meta['io.modelcontextprotocol/serverInfo'], {
      name: 'modern-fake',
      version: '0.0.1',
    })
    const init = await c.legacyRequest('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    })
    assert.equal(init.error.code, -32601)
    const bare = await c.legacyRequest('tools/list', {})
    assert.equal(bare.error.code, -32602)
    const wrong = await c.request(
      'tools/list',
      {},
      { meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
    )
    assert.equal(wrong.error.code, -32022)
    assert.deepEqual(wrong.error.data, { supported: ['2026-07-28'], requested: '2099-01-01' })
    const list = await c.request('tools/list')
    assert.deepEqual(names(list), ['echo', 'slow'])
    assert.equal(list.result.ttlMs, 1000)
    assert.equal(list.result.cacheScope, 'private')
    // The capabilities come from each request: two requests with two sets are each answered with their own.
    const a = text(
      await c.request(
        'tools/call',
        { name: 'echo', arguments: { n: 1 } },
        { meta: { 'io.modelcontextprotocol/clientCapabilities': { roots: {} } } },
      ),
    )
    const b = text(
      await c.request(
        'tools/call',
        { name: 'echo', arguments: { n: 2 } },
        { meta: { 'io.modelcontextprotocol/clientCapabilities': {} } },
      ),
    )
    assert.deepEqual([a.args, a.clientCapabilities], [{ n: 1 }, { roots: {} }])
    assert.deepEqual([b.args, b.clientCapabilities], [{ n: 2 }, {}])
    assert.equal(a.pid, c.child.pid)
    assert.equal((await c.request('tools/call', { name: 'nope' })).error.code, -32602)
  })

  test('a slow call that is cancelled gets no answer, and the server records the id', async () => {
    const c = connectPeer('modern')
    const slow = c.start('tools/call', { name: 'slow', arguments: { ms: 60_000 } }, { ms: 60_000 })
    c.cancel(slow.id)
    const echo = text(await c.request('tools/call', { name: 'echo' }))
    assert.equal(echo.args && Object.keys(echo.args).length, 0)
    assert.ok(!c.messages.some(m => m.id === slow.id), 'a cancelled call was answered')
    c.close()
    await c.exited
  })

  test('a slow call that is not cancelled is answered', async () => {
    const c = connectPeer('modern')
    assert.deepEqual(text(await c.request('tools/call', { name: 'slow', arguments: { ms: 20 } })), { done: true })
  })

  test('subscriptions/listen: acknowledged first, then a list change on the stream that asked, stamped with its id', async () => {
    const c = connectPeer('modern')
    const other = connectPeer('modern')
    const asked = await c.listen({ toolsListChanged: true })
    const declined = await c.listen({ toolsListChanged: false })
    assert.equal(asked.ack.params._meta['io.modelcontextprotocol/subscriptionId'], asked.id)
    assert.deepEqual(asked.ack.params.notifications, { toolsListChanged: true })
    assert.equal(c.messages.at(-1).method, 'notifications/subscriptions/acknowledged')
    c.control('add-tool', 'extra')
    // The control line is read before the next request, so the notification is written before its answer.
    assert.deepEqual(names(await c.request('tools/list')), ['echo', 'slow', 'extra'])
    assert.equal(asked.notifications().length, 1)
    assert.equal(asked.notifications()[0].method, 'notifications/tools/list_changed')
    assert.equal(declined.notifications().length, 0)
    // Another process has its own tool list and no stream.
    assert.deepEqual(names(await other.request('tools/list')), ['echo', 'slow'])
    assert.equal(other.notifications().length, 0)
    // A cancelled stream gets no more.
    c.cancel(asked.id)
    c.control('remove-tool', 'extra')
    assert.deepEqual(names(await c.request('tools/list')), ['echo', 'slow'])
    assert.equal(asked.notifications().length, 1)
  })

  test('a listen with no filter is refused', async () => {
    const c = connectPeer('modern')
    const answer = await c.request('subscriptions/listen', {})
    assert.equal(answer.error.code, -32602)
  })
})

describe('dual', () => {
  test('a modern first message pins the era: initialize is then refused', async () => {
    const c = connectPeer('dual')
    assert.deepEqual((await c.discover()).result.supportedVersions, ['2026-07-28'])
    assert.equal(
      (
        await c.legacyRequest('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        })
      ).error.code,
      -32601,
    )
    assert.deepEqual(names(await c.request('tools/list')), ['echo', 'slow'])
  })

  test('an initialize first pins the 2025 era: server/discover is then refused, and a change gets a plain notification', async () => {
    const c = connectPeer('dual')
    assert.equal((await c.legacyOpen()).result.protocolVersion, '2025-06-18')
    assert.equal((await c.discover()).error.code, -32601)
    assert.deepEqual(names(await c.legacyRequest('tools/list')), ['echo', 'slow'])
    c.control('add-tool')
    assert.deepEqual(names(await c.legacyRequest('tools/list')), ['echo', 'slow', 'extra'])
    assert.deepEqual(
      c.notifications().map(m => [m.method, m.params]),
      [['notifications/tools/list_changed', undefined]],
    )
  })
})

describe('the old kinds answer the probe as written, then serve a 2025 session', () => {
  // A full 2025 session on a connection whose probe is over: initialize, the tool list, a call.
  const session = async c => {
    assert.equal((await c.legacyOpen()).result.serverInfo.name, 'modern-fake')
    assert.deepEqual(names(await c.legacyRequest('tools/list')), ['echo', 'slow'])
    assert.deepEqual(text(await c.legacyRequest('tools/call', { name: 'echo', arguments: { a: 1 } })).args, { a: 1 })
  }

  test('e32601: -32601', async () => {
    const c = connectPeer('e32601')
    assert.equal((await c.discover()).error.code, -32601)
    await session(c)
  })

  test('eother: -32600, and -32602 or -32000 by argument', async () => {
    for (const [arg, code] of [
      [undefined, -32600],
      ['32602', -32602],
      ['32000', -32000],
    ]) {
      const c = connectPeer('eother', arg)
      assert.equal((await c.discover()).error.code, code)
      await session(c)
    }
  })

  test('garbage: a result that is not a discover result', async () => {
    const c = connectPeer('garbage')
    const answer = await c.discover()
    assert.equal(Array.isArray(answer.result.supportedVersions), false)
    await session(c)
  })

  test('e32022: data.supported of a legacy-only or a modern list', async () => {
    const legacy = connectPeer('e32022')
    const a = await legacy.discover()
    assert.equal(a.error.code, -32022)
    assert.deepEqual(a.error.data, { supported: ['2025-06-18', '2025-03-26'], requested: '2026-07-28' })
    await session(legacy)
    const modern = connectPeer('e32022', 'modern')
    assert.deepEqual((await modern.discover()).error.data.supported, ['2027-01-15'])
  })

  test('slow: -32601 after the time of the argument', async () => {
    const c = connectPeer('slow', 150)
    const t = performance.now()
    assert.equal((await c.discover()).error.code, -32601)
    assert.ok(performance.now() - t >= 140, 'answered too early')
    await session(c)
  })

  test('silent: no answer to the probe, and the 2025 session still works on the same process', async () => {
    const c = connectPeer('silent')
    await assert.rejects(c.discover({ ms: 200 }), /timeout after 200 ms/)
    await session(c)
  })

  // On Windows a Node process cannot give up its own stdout pipe while it lives (closing the handle and the descriptor
  // leaves the pipe open: tried 2026-11-28, Node 22), so the `closes` kind ends the stream on Linux and macOS only.
  test(
    'closes: the probe ends stdout, and the process stays alive',
    { skip: process.platform === 'win32' && 'a Windows process cannot close its stdout pipe while it lives' },
    async () => {
      const c = connectPeer('closes')
      await assert.rejects(c.discover(), /the connection closed/)
      await c.closed
      assert.equal(c.child.exitCode, null)
      assert.equal(c.child.signalCode, null)
    },
  )

  test('exits: the probe ends the process with 1', async () => {
    const c = connectPeer('exits')
    await assert.rejects(c.discover(), /the connection closed/)
    assert.deepEqual(await within(c.exited, 5000, 'the exit'), { code: 1, signal: null })
  })
})

describe('the openings', () => {
  const run = (name, kind, arg) => replay(OPENINGS[name], () => connectPeer(kind, arg))
  const summary = out =>
    out.map(s => [
      s.conn,
      s.method,
      s.reply === undefined
        ? 'none'
        : s.reply.ack !== undefined
          ? 'stream'
          : s.reply.error === undefined
            ? 'result'
            : s.reply.error.code,
    ])

  test('legacy against an old server, modern against modern', async () => {
    assert.deepEqual(summary(await run('legacy', 'e32601')), [
      [0, 'initialize', 'result'],
      [0, 'notifications/initialized', 'none'],
      [0, 'tools/list', 'result'],
    ])
    assert.deepEqual(summary(await run('modern', 'modern')), [
      [0, 'server/discover', 'result'],
      [0, 'tools/list', 'result'],
    ])
  })

  test('probe-then-initialize on one connection: the probe fails, the same process serves the session', async () => {
    assert.deepEqual(summary(await run('probe-then-initialize', 'e32601')), [
      [0, 'server/discover', -32601],
      [0, 'initialize', 'result'],
      [0, 'notifications/initialized', 'none'],
      [0, 'tools/list', 'result'],
    ])
  })

  test('probe-sibling: the probe process is ended, the session runs on a new one (also for a server that exits at the probe)', async () => {
    const out = await run('probe-sibling', 'e32601')
    assert.deepEqual(
      summary(out).map(s => s[1]),
      ['server/discover', 'close', 'initialize', 'notifications/initialized', 'tools/list'],
    )
    assert.deepEqual(
      summary(out).map(s => s[0]),
      [0, 0, 1, 1, 1],
    )
    const exits = await replay(OPENINGS['probe-sibling'], () => connectPeer('exits'))
    assert.equal(exits[0].reply.failed, true)
    assert.equal(exits[2].reply.error, undefined)
    assert.equal(exits[4].reply.error, undefined)
  })

  test('claude-code-auto: discover, listen, discover, resources/list on one connection', async () => {
    for (const kind of ['modern', 'dual']) {
      assert.deepEqual(summary(await run('claude-code-auto', kind)), [
        [0, 'server/discover', 'result'],
        [0, 'subscriptions/listen', 'stream'],
        [0, 'server/discover', 'result'],
        [0, 'resources/list', -32601],
      ])
    }
  })

  test('claude-code-legacy: initialize, initialized, resources/list', async () => {
    for (const kind of ['e32601', 'dual']) {
      assert.deepEqual(summary(await run('claude-code-legacy', kind)), [
        [0, 'initialize', 'result'],
        [0, 'notifications/initialized', 'none'],
        [0, 'resources/list', -32601],
      ])
    }
  })

  test('the Claude Code openings carry the tasks extension and no other capability', async () => {
    const c = connectPeer('modern')
    const out = await replay(OPENINGS['claude-code-auto'].slice(0, 1), () => c)
    assert.equal(out[0].reply.result.supportedVersions[0], '2026-07-28')
    const echo = await c.request(
      'tools/call',
      { name: 'echo' },
      { meta: { 'io.modelcontextprotocol/clientCapabilities': OPENINGS['claude-code-auto'][0].capabilities } },
    )
    assert.deepEqual(text(echo).clientCapabilities, { extensions: { 'io.modelcontextprotocol/tasks': {} } })
  })
})

const withHttp = async (kind, fn) => {
  const server = await startHttp(kind)
  try {
    return await fn(server)
  } finally {
    await server.close()
  }
}
const post = (server, body, headers = {}, init = {}) =>
  fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
    ...init,
  })
const ENV = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const modernHeaders = (method, name) => ({
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': method,
  ...(name === undefined ? {} : { 'mcp-name': name }),
})
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: ENV } })

describe('the HTTP peer, modern', () => {
  test('serves discover, list and call when the headers match the body, and records each request', async () => {
    await withHttp('modern', async server => {
      const discover = await json(await post(server, rpc(1, 'server/discover'), modernHeaders('server/discover')))
      assert.deepEqual(discover.result.supportedVersions, ['2026-07-28'])
      assert.deepEqual(names(await json(await post(server, rpc(2, 'tools/list'), modernHeaders('tools/list')))), [
        'echo',
        'slow',
      ])
      const call = await json(
        await post(
          server,
          rpc(3, 'tools/call', { name: 'echo', arguments: { k: 1 } }),
          modernHeaders('tools/call', 'echo'),
        ),
      )
      assert.deepEqual(text(call).args, { k: 1 })
      assert.equal(server.requests.length, 3)
      assert.equal(server.requests[2].headers['mcp-name'], 'echo')
      assert.equal(server.requests[2].json.method, 'tools/call')
      assert.equal(
        server.requests.every(r => r.headers['mcp-session-id'] === undefined),
        true,
      )
    })
  })

  test('a missing or unequal header is -32020 with HTTP 400', async () => {
    await withHttp('modern', async server => {
      const cases = [
        [{}, 'a request with no header'],
        [{ ...modernHeaders('tools/list'), 'mcp-protocol-version': '2025-06-18' }, 'another version'],
        [modernHeaders('tools/call'), 'another method'],
        [modernHeaders('tools/list', 'echo'), 'a name that tools/list does not take is fine'],
      ]
      const bad = await post(server, rpc(1, 'tools/list'), cases[0][0])
      assert.equal(bad.status, 400)
      assert.equal((await json(bad)).error.code, -32020)
      assert.equal((await post(server, rpc(2, 'tools/list'), cases[1][0])).status, 400)
      assert.equal((await post(server, rpc(3, 'tools/list'), cases[2][0])).status, 400)
      assert.equal((await post(server, rpc(4, 'tools/list'), cases[3][0])).status, 200)
      const name = await post(server, rpc(5, 'tools/call', { name: 'echo' }), modernHeaders('tools/call', 'slow'))
      assert.equal(name.status, 400)
      assert.equal((await json(name)).error.code, -32020)
    })
  })

  test('subscriptions/listen is an SSE stream: acknowledged, then the list change from the control call', async () => {
    await withHttp('modern', async server => {
      const stop = new AbortController()
      const res = await post(
        server,
        rpc(7, 'subscriptions/listen', { notifications: { toolsListChanged: true } }),
        modernHeaders('subscriptions/listen'),
        { signal: stop.signal },
      )
      assert.equal(res.headers.get('content-type'), 'text/event-stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let seen = ''
      const until = async needle => {
        while (!seen.includes(needle)) {
          const { value, done } = await within(reader.read(), 5000, `the stream to show ${needle}`)
          if (done) throw new Error('the stream ended')
          seen += decoder.decode(value)
        }
      }
      await until('notifications/subscriptions/acknowledged')
      assert.ok(seen.includes('"io.modelcontextprotocol/subscriptionId":7'))
      await server.control('add-tool', 'extra')
      await until('notifications/tools/list_changed')
      stop.abort()
    })
  })
})

describe('the HTTP peer, legacy', () => {
  test('a stateful 2025 session: the probe before initialize gets 400 with a JSON-RPC error, then a session id', async () => {
    await withHttp('legacy', async server => {
      const probe = await post(server, rpc(1, 'server/discover'), modernHeaders('server/discover'))
      assert.equal(probe.status, 400)
      assert.equal((await json(probe)).error.code, -32000)
      const init = await post(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      })
      const session = init.headers.get('mcp-session-id')
      assert.ok(session)
      assert.equal((await json(init)).result.protocolVersion, '2025-06-18')
      assert.equal(
        (await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': session }))
          .status,
        202,
      )
      const list = await json(
        await post(server, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-session-id': session }),
      )
      assert.deepEqual(names(list), ['echo', 'slow'])
      assert.equal(
        (await post(server, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-session-id': 'nope' })).status,
        404,
      )
      assert.equal((await fetch(server.url, { method: 'DELETE', headers: { 'mcp-session-id': session } })).status, 200)
      assert.equal(
        (await post(server, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { 'mcp-session-id': session })).status,
        404,
      )
    })
  })
})

describe('the HTTP peer, the probe kinds', () => {
  const probe = (server, headers = {}, init) =>
    post(server, rpc(1, 'server/discover'), { ...modernHeaders('server/discover'), ...headers }, init)

  test('plain 400, 404 and 405 for the probe, and a legacy session behind', async () => {
    for (const [kind, status] of [
      ['probe-400', 400],
      ['probe-404', 404],
      ['probe-405', 405],
    ]) {
      await withHttp(kind, async server => {
        const res = await probe(server)
        assert.equal(res.status, status, kind)
        assert.equal(res.headers.get('content-type'), 'text/plain')
        const init = await post(server, {
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        })
        assert.equal(init.status, 200, kind)
      })
    }
  })

  test('400 with a JSON-RPC error body', async () => {
    await withHttp('probe-400-rpc', async server => {
      const res = await probe(server)
      assert.equal(res.status, 400)
      assert.equal((await json(res)).error.code, -32600)
    })
  })

  test('401 with www-authenticate, then a legacy session once a bearer comes, and the record keeps the header', async () => {
    await withHttp('probe-401', async server => {
      const res = await probe(server)
      assert.equal(res.status, 401)
      assert.match(
        res.headers.get('www-authenticate'),
        /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"$/,
      )
      const init = await post(
        server,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        },
        { authorization: 'Bearer abc' },
      )
      assert.equal(init.status, 200)
      assert.equal(server.requests.at(-1).headers.authorization, 'Bearer abc')
      assert.equal(server.requests[0].headers.authorization, undefined)
    })
  })

  test('403, 500 and 503 for every request', async () => {
    for (const [kind, status] of [
      ['probe-403', 403],
      ['probe-500', 500],
      ['probe-503', 503],
    ]) {
      await withHttp(kind, async server => assert.equal((await probe(server)).status, status, kind))
    }
  })

  test('a 307 to another origin', async () => {
    await withHttp('probe-307', async server => {
      const res = await probe(server, {}, { redirect: 'manual' })
      assert.equal(res.status, 307)
      assert.equal(new URL(res.headers.get('location')).hostname, 'localhost')
      assert.notEqual(new URL(res.headers.get('location')).origin, new URL(server.url).origin)
    })
  })

  test('a body that never ends: the first chunk comes, the end does not', async () => {
    await withHttp('probe-hang', async server => {
      const stop = new AbortController()
      const res = await probe(server, {}, { signal: stop.signal })
      assert.equal(res.status, 200)
      const reader = res.body.getReader()
      const first = await within(reader.read(), 5000, 'the first chunk')
      assert.equal(new TextDecoder().decode(first.value), '{')
      assert.equal(first.done, false)
      stop.abort()
      await assert.rejects(reader.read())
    })
  })

  test('waitFor resolves on a request that came, and rejects at its deadline', async () => {
    await withHttp('probe-400', async server => {
      const waiting = server.waitFor(r => r.json?.method === 'server/discover', 5000)
      await probe(server)
      assert.equal((await waiting).path, '/mcp')
      await assert.rejects(
        server.waitFor(r => r.json?.method === 'never', 100),
        /no request matched within 100 ms/,
      )
    })
  })
})
