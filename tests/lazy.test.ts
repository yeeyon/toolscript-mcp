// Lazy start (issue #63, slice 5, decision 028): the rule, the cache file, and connectAll with real stdio children
// (tests/probe-server.mjs, tests/pid-server.mjs): a lazy server with a cached list has no process until a nested call
// names it, and it stops after the idle time with no process of its tree left.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shownStates, type DownstreamTool } from '../src/core/catalog.ts'
import { lazyFindings } from '../src/core/doctor.ts'
import { parseConfig, serverKey, type ServerConfig, type ServerKey, type StdioServer } from '../src/core/config.ts'
import {
  LAZY_IDLE_MS,
  MAX_CACHE_TOOLS,
  isLazy,
  lazyIdleMs,
  parseToolsCache,
  toolsCacheText,
  toolsKeyText,
  type CachedList,
} from '../src/core/lazy.ts'
import { connectAll, type Downstream, type ToolsStore } from '../src/host/downstream.ts'
import { toolsKey } from '../src/host/toolscache.ts'

const PROBE = path.join(import.meta.dirname, 'probe-server.mjs')
const PID_SERVER = path.join(import.meta.dirname, 'pid-server.mjs')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-lazy-test-'))
const KEY = serverKey('claude-code')!
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (ok: () => boolean, what: string, ms = 8000) => {
  for (let waited = 0; !ok(); waited += 25) {
    assert.ok(waited < ms, `timed out: ${what}`)
    await sleep(25)
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const IDLE_MS = 500
const PROBE_TOOL: DownstreamTool = {
  name: 'probe',
  description: 'Returns the pid.',
  inputSchema: { type: 'object', properties: {} },
}

/** An in-memory tool cache with a stable key: the arguments of the launch. */
const memoryStore = (initial: Iterable<[string, CachedList]> = []) => {
  const saved = new Map<string, CachedList>(initial)
  const store: ToolsStore = {
    key: s => JSON.stringify([s.command, s.args]),
    load: async () => new Map(saved),
    save: async (id, tools) => void saved.set(id, { at: Date.now(), tools }),
  }
  return { saved, store }
}

type Rig = {
  downstream: Downstream
  logs: string[]
  starts: () => number
  saved: Map<string, CachedList>
  id: string
}

/** One lazy probe server. `warm`: the cache already holds a list for its launch. */
const rig = (
  { warm = false, idleMs = IDLE_MS, server }: { warm?: boolean; idleMs?: number; server?: Partial<StdioServer> } = {},
  list: readonly DownstreamTool[] = [PROBE_TOOL],
): Rig => {
  const file = path.join(DIR, `${randomUUID()}.json`)
  const config: StdioServer = {
    kind: 'stdio',
    command: process.execPath,
    args: [PROBE, file],
    env: {},
    ...server,
  }
  const id = JSON.stringify([config.command, config.args])
  const { saved, store } = memoryStore(warm ? [[id, { at: 1, tools: list }]] : [])
  const logs: string[] = []
  const downstream = connectAll(new Map<ServerKey, ServerConfig>([[KEY, config]]), '0', line => logs.push(line), {
    lazy: { bridges: new Set([KEY]), idleMs, cache: store },
  })
  opened.push(downstream)
  const starts = () =>
    fs.existsSync(`${file}.log`)
      ? fs
          .readFileSync(`${file}.log`, 'utf8')
          .split('\n')
          .filter(line => line.includes('"event":"start"')).length
      : 0
  return { downstream, logs, starts, saved, id }
}

const pidOf = async (downstream: Downstream, tool = 'probe'): Promise<number> => {
  const link = await downstream.client(KEY)
  assert.ok(link.ok, link.ok ? '' : link.reason)
  const r = await link.client.callTool({ name: tool, arguments: {} })
  const content = r.content as { text: string }[]
  const text = content[0]!.text
  return Number(/\d+/.exec(text)![0])
}

describe('the rule', () => {
  const bridge = (lazy?: boolean): StdioServer => ({
    kind: 'stdio',
    command: 'claude',
    args: ['mcp', 'serve'],
    env: {},
    ...(lazy !== undefined && { lazy }),
  })
  const other = (lazy?: boolean): StdioServer => ({ ...bridge(lazy), command: 'x', args: [] })
  const bridges = new Set([KEY])
  const other_ = serverKey('other')!

  test('a bridge is lazy unless its entry says false, and no other server is lazy unless it says true', () => {
    assert.equal(isLazy(KEY, bridge(), bridges, true), true)
    assert.equal(isLazy(KEY, bridge(true), bridges, true), true)
    assert.equal(isLazy(KEY, bridge(false), bridges, true), false)
    assert.equal(isLazy(other_, other(), bridges, true), false)
    assert.equal(isLazy(other_, other(false), bridges, true), false)
    assert.equal(isLazy(other_, other(true), bridges, true), true)
  })

  test('the switch off turns every lazy start off, and an HTTP or invalid entry is never lazy', () => {
    assert.equal(isLazy(KEY, bridge(), bridges, false), false)
    assert.equal(isLazy(other_, other(true), bridges, false), false)
    assert.equal(isLazy(other_, { kind: 'http', url: 'https://x.example/mcp', headers: {} }, bridges, true), false)
    assert.equal(isLazy(other_, { kind: 'invalid', errors: ['x'] }, bridges, true), false)
  })

  test('the idle time is 10 minutes, or TOOLSCRIPT_LAZY_IDLE_MS of at least 1000', () => {
    assert.equal(LAZY_IDLE_MS, 600_000)
    assert.equal(lazyIdleMs(undefined), LAZY_IDLE_MS)
    assert.equal(lazyIdleMs('5000'), 5000)
    assert.equal(lazyIdleMs('1000'), 1000)
    for (const bad of ['999', '0', '-5', '1e4', 'x', '', '99999999999']) assert.equal(lazyIdleMs(bad), LAZY_IDLE_MS)
  })
})

describe('the config', () => {
  const parse = (value: unknown, env: Record<string, string> = {}) => {
    const parsed = parseConfig(JSON.stringify(value), env, '/usr/bin/node', 'linux')
    return parsed
  }
  const entry = (value: unknown, env: Record<string, string> = {}, name = 'a') => {
    const parsed = parse(value, env)
    assert.ok(parsed.ok)
    return parsed.config.servers.get(serverKey(name)!)
  }

  test('"lazy" is a boolean on a stdio entry, and the switch reads TOOLSCRIPT_LAZY', () => {
    assert.deepEqual(entry({ mcpServers: { a: { command: 'x', lazy: true } } }), {
      kind: 'stdio',
      command: 'x',
      args: [],
      env: {},
      lazy: true,
    })
    for (const lazy of ['yes', 1, null, [], {}])
      assert.deepEqual(entry({ mcpServers: { a: { command: 'x', lazy } } }), {
        kind: 'invalid',
        errors: ['mcpServers.a.lazy: must be true or false'],
      })
    const on = (env?: Record<string, string>) => {
      const parsed = parse({ mcpServers: {} }, env)
      assert.ok(parsed.ok)
      return parsed.config.lazy
    }
    assert.equal(on(), true)
    assert.equal(on({ TOOLSCRIPT_LAZY: '1' }), true)
    assert.equal(on({ TOOLSCRIPT_LAZY: '0' }), false)
    const bad = parse({ mcpServers: {} }, { TOOLSCRIPT_LAZY: 'no' })
    assert.deepEqual(bad.ok ? [] : bad.errors, ['TOOLSCRIPT_LAZY: must be 0 or 1'])
  })

  test('with sharing on, "lazy" on a shared or per-folder server is an error of its entry; a per-session one keeps it', () => {
    const servers = {
      mcpServers: {
        a: { command: 'x', lazy: true },
        b: { command: 'y', share: false, lazy: true },
        c: { command: 'z', cwd: '/srv', lazy: false },
        'claude-code': { command: 'claude', args: ['mcp', 'serve'], lazy: false },
      },
    }
    const on = { TOOLSCRIPT_SHARE: '1' }
    assert.equal(entry(servers, on, 'a')!.kind, 'invalid')
    assert.equal(entry(servers, on, 'b')!.kind, 'stdio')
    assert.equal(entry(servers, on, 'c')!.kind, 'invalid')
    assert.equal(entry(servers, on, 'claude-code')!.kind, 'stdio')
    // With the share switch off, "lazy": true works on any stdio server.
    assert.equal(entry(servers, {}, 'a')!.kind, 'stdio')
    assert.equal(entry(servers, {}, 'c')!.kind, 'stdio')
  })

  test('an HTTP entry has no "lazy" key', () => {
    assert.equal(
      entry({ mcpServers: { a: { type: 'http', url: 'https://x.example/mcp', lazy: true } } })!.kind,
      'invalid',
    )
  })
})

describe('the tool cache file', () => {
  const id = 'a'.repeat(64)
  const good = {
    version: 1,
    entries: { [id]: { at: 5, tools: [{ name: 'probe', description: 'd', inputSchema: {} }] } },
  }

  test('a list written is read back, with the five fields of a tool and no other', () => {
    const list: CachedList = {
      at: 7,
      tools: [
        {
          name: 't',
          description: 'd',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
          _meta: { 'anthropic/requiresUserInteraction': true },
          extra: 'dropped',
        } as DownstreamTool,
      ],
    }
    const { cache, problem } = parseToolsCache(toolsCacheText(new Map([[id, list]])))
    assert.equal(problem, undefined)
    assert.deepEqual(cache.get(id), {
      at: 7,
      tools: [{ ...list.tools[0]!, extra: undefined }].map(t => JSON.parse(JSON.stringify(t))),
    })
  })

  test('a hostile or half written file gives no cache, with a fixed problem text and no content', () => {
    const text = JSON.stringify(good)
    const cases = [
      'x'.repeat(5_000_000),
      text.slice(0, text.length - 7),
      '',
      '[]',
      'null',
      JSON.stringify({ version: 2, entries: {} }),
      JSON.stringify({ version: 1, entries: [] }),
    ]
    for (const bad of cases) {
      const { cache, problem } = parseToolsCache(bad)
      assert.equal(cache.size, 0)
      assert.match(problem!, /^the file is /)
    }
  })

  test('an entry with the wrong types, an odd key or too many tools is skipped, a tool with a bad field loses the field', () => {
    const many = Array.from({ length: MAX_CACHE_TOOLS + 1 }, (_, i) => ({ name: `t${i}` }))
    const { cache } = parseToolsCache(
      JSON.stringify({
        version: 1,
        entries: {
          [id]: {
            at: 1,
            tools: [{ name: 'ok', description: 5, inputSchema: 'x', _meta: [1] }, { name: 7 }, null, { name: '' }],
          },
          ['b'.repeat(64)]: { at: 'now', tools: [] },
          ['c'.repeat(64)]: { at: 1, tools: many },
          '../x': { at: 1, tools: [] },
          __proto__: { at: 1, tools: [] },
        },
      }),
    )
    assert.deepEqual([...cache.keys()], [id])
    assert.deepEqual(cache.get(id)!.tools, [{ name: 'ok' }])
  })

  test('the key is stable under env order, differs on an argument, an env value and the cwd, and ignores the folder of the session', () => {
    const server = (over: Partial<StdioServer> = {}): StdioServer => ({
      kind: 'stdio',
      command: 'claude',
      args: ['mcp', 'serve'],
      env: { A: '1', B: '2' },
      ...over,
    })
    const text = (s: StdioServer, env = s.env) => toolsKeyText(s, env)
    assert.equal(text(server(), { B: '2', A: '1' }), text(server()))
    assert.notEqual(text(server({ args: ['mcp', 'serve', '-v'] })), text(server()))
    assert.notEqual(text(server(), { A: '1', B: '3' }), text(server()))
    assert.notEqual(text(server({ cwd: '/srv/a' })), text(server()))
    assert.notEqual(text(server({ cwd: '/srv/a' })), text(server({ cwd: '/srv/b' })))
    const hash = toolsKey(server())
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(toolsKey(server()), hash)
    const before = process.cwd()
    process.chdir(DIR)
    try {
      assert.equal(toolsKey(server()), hash)
    } finally {
      process.chdir(before)
    }
  })
})

describe('a lazy server', () => {
  test('with a cached list it starts asleep with no process, and the display shows its cached tools', async () => {
    const { downstream, starts } = rig({ warm: true })
    await downstream.settled
    await sleep(200)
    assert.equal(starts(), 0)
    const [state] = downstream.states()
    assert.equal(state?.status, 'asleep')
    const [shown] = shownStates(downstream.states())
    assert.deepEqual(shown, { key: KEY, status: 'connected', tools: [PROBE_TOOL] })
    // A search does not wake it.
    await downstream.retry()
    assert.equal(starts(), 0)
    assert.equal(downstream.states()[0]?.status, 'asleep')
  })

  test('3 callers that name the sleeping server start one child, and the log has both lines', async () => {
    const { downstream, starts, logs } = rig({ warm: true })
    await downstream.settled
    const links = await Promise.all([1, 2, 3].map(() => downstream.client(KEY)))
    assert.deepEqual(
      links.map(l => l.ok),
      [true, true, true],
    )
    assert.equal(starts(), 1)
    assert.ok(
      logs.some(l => /^claude-code: started on first use, \d+ ms, 1 tools$/.test(l)),
      logs.join('\n'),
    )
    await until(() => downstream.states()[0]?.status === 'asleep', 'the idle stop')
    assert.ok(
      logs.some(l => /^claude-code: stopped after \d+ s idle$/.test(l)),
      logs.join('\n'),
    )
  })

  test('a run that names it wakes it through retry, and that wait is not the 5 s of a retry', async () => {
    const { downstream, starts } = rig({ warm: true })
    await downstream.settled
    await downstream.retry([KEY])
    assert.equal(downstream.states()[0]?.status, 'connected')
    assert.equal(starts(), 1)
  })

  test('with no cache entry it connects at the start, writes the entry, and stops after the idle time with no call', async () => {
    const { downstream, starts, saved, id } = rig()
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'connected')
    assert.equal(starts(), 1)
    await until(() => saved.has(id), 'the cache entry')
    assert.deepEqual(
      saved.get(id)!.tools.map(t => t.name),
      ['probe'],
    )
    await until(() => downstream.states()[0]?.status === 'asleep', 'the idle stop')
    assert.deepEqual(
      (downstream.states()[0] as { tools: readonly DownstreamTool[] }).tools.map(t => t.name),
      ['probe'],
    )
    // And a call after that works: a new child.
    assert.ok(await pidOf(downstream))
    assert.equal(starts(), 2)
  })

  test('the child is gone after the idle stop, and a call after it gets a new one', async () => {
    const { downstream } = rig({ warm: true })
    await downstream.settled
    const first = await pidOf(downstream)
    await until(() => downstream.states()[0]?.status === 'asleep', 'the idle stop')
    await until(() => !alive(first), 'the end of the child')
    const second = await pidOf(downstream)
    assert.notEqual(second, first)
  })

  test('a call 1 s before the idle end sets the clock back, and a call during the stop waits for it and wakes a new child', async () => {
    const { downstream, starts } = rig({ warm: true, idleMs: 1000 })
    await downstream.settled
    await pidOf(downstream)
    await sleep(800)
    await pidOf(downstream)
    await sleep(600)
    assert.equal(downstream.states()[0]?.status, 'connected', 'the call set the clock back')
    await until(() => downstream.states()[0]?.status === 'asleep', 'the idle stop', 4000)
    // The link is asleep from the moment of the stop: this call comes with the child still ending.
    const answered = await pidOf(downstream)
    assert.ok(answered)
    assert.equal(starts(), 2)
  })

  test('the idle clock waits for an open request', async () => {
    const config: StdioServer = { kind: 'stdio', command: process.execPath, args: [PID_SERVER], env: {} }
    const id = JSON.stringify([config.command, config.args])
    const { store } = memoryStore([[id, { at: 1, tools: [{ name: 'sleep', inputSchema: { type: 'object' } }] }]])
    const d = connectAll(new Map<ServerKey, ServerConfig>([[KEY, config]]), '0', () => {}, {
      lazy: { bridges: new Set([KEY]), idleMs: 300, cache: store },
    })
    opened.push(d)
    await d.settled
    const link = await d.client(KEY)
    assert.ok(link.ok)
    const answer = link.client.callTool({ name: 'sleep', arguments: { ms: 900 } })
    await sleep(600)
    assert.equal(d.states()[0]?.status, 'connected', 'a call is open: no stop')
    const r = await answer
    assert.equal((r.content as { text: string }[])[0]!.text, 'slept 900')
    await until(() => d.states()[0]?.status === 'asleep', 'the idle stop after the answer')
  })

  test('the live list decides, and the cache then holds it: a tool gone, one added', async () => {
    const stale: DownstreamTool[] = [{ name: 'gone', inputSchema: { type: 'object' } }]
    const { downstream, saved, id } = rig({ warm: true }, stale)
    await downstream.settled
    assert.deepEqual(
      (downstream.states()[0] as { tools: readonly DownstreamTool[] }).tools.map(t => t.name),
      ['gone'],
    )
    const link = await downstream.client(KEY)
    assert.ok(link.ok)
    assert.deepEqual(
      link.tools.map(t => t.name),
      ['probe'],
    )
    await until(() => saved.get(id)!.tools[0]?.name === 'probe', 'the cache entry of the live list')
  })

  test('a server that fails at its wake gives the reason of today, keeps the cache entry, and shows no cached tools', async () => {
    const { downstream, saved, id } = rig({ warm: true, server: { command: 'toolscript-no-such-command' } })
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'asleep')
    const link = await downstream.client(KEY)
    assert.equal(link.ok, false)
    const [state] = shownStates(downstream.states())
    assert.equal(state?.status, 'failed')
    assert.ok(saved.has(id), 'the cache entry stays')
  })

  test('close ends an awake child, and a wake after close starts nothing', async () => {
    const { downstream, starts } = rig({ warm: true, idleMs: 60_000 })
    await downstream.settled
    const pid = await pidOf(downstream)
    await downstream.close()
    await until(() => !alive(pid), 'the end of the child')
    const link = await downstream.client(KEY)
    assert.equal(link.ok, false)
    assert.equal(starts(), 1)
  })

  test('close ends the tree of a wrapper that ignores EOF before the 2 s that a client gives the host', async () => {
    const win = process.platform === 'win32'
    const wrapper = win
      ? { command: 'cmd', args: ['/c', 'node', PID_SERVER, '--ignore-eof'] }
      : { command: 'sh', args: ['-c', 'node "$0" --ignore-eof; true', PID_SERVER] }
    const config: StdioServer = { kind: 'stdio', command: wrapper.command, args: wrapper.args, env: {} }
    const id = JSON.stringify([config.command, config.args])
    const { store } = memoryStore([[id, { at: 1, tools: [{ name: 'pid', inputSchema: { type: 'object' } }] }]])
    const d = connectAll(new Map<ServerKey, ServerConfig>([[KEY, config]]), '0', () => {}, {
      lazy: { bridges: new Set([KEY]), idleMs: 60_000, cache: store },
    })
    opened.push(d)
    await d.settled
    const pid = await pidOf(d, 'pid')
    assert.ok(alive(pid))
    const began = Date.now()
    await d.close()
    assert.ok(Date.now() - began < 2000, 'the close took less than 2 s')
    await until(() => !alive(pid), 'the end of the grandchild', 5000)
  })

  test('a wrapper launch that ignores EOF leaves no process of its tree after the idle stop', async () => {
    const win = process.platform === 'win32'
    // The wrapper stays the parent of the server, and the server ignores the end of its stdin.
    const wrapper = win
      ? { command: 'cmd', args: ['/c', 'node', PID_SERVER, '--ignore-eof'] }
      : { command: 'sh', args: ['-c', 'node "$0" --ignore-eof; true', PID_SERVER] }
    const config: StdioServer = { kind: 'stdio', command: wrapper.command, args: wrapper.args, env: {} }
    const id = JSON.stringify([config.command, config.args])
    const { store } = memoryStore([[id, { at: 1, tools: [{ name: 'pid', inputSchema: { type: 'object' } }] }]])
    const d = connectAll(new Map<ServerKey, ServerConfig>([[KEY, config]]), '0', () => {}, {
      lazy: { bridges: new Set([KEY]), idleMs: 400, cache: store },
    })
    opened.push(d)
    await d.settled
    const pid = await pidOf(d, 'pid')
    assert.ok(alive(pid))
    await until(() => d.states()[0]?.status === 'asleep', 'the idle stop')
    await until(() => !alive(pid), 'the end of the grandchild', 10_000)
  })
})

describe('the doctor line', () => {
  const config = (env: Record<string, string> = {}) => {
    const parsed = parseConfig(
      JSON.stringify({
        mcpServers: {
          'claude-code': { command: 'claude', args: ['mcp', 'serve', '--token', 'sekret-arg'] },
          opted: { command: 'node', args: ['/opt/private/x.js'], env: { TOKEN: 'sekret-env' }, lazy: true },
          plain: { command: 'node', args: ['y.js'] },
          web: { type: 'http', url: 'https://mcp.example.com/mcp' },
        },
      }),
      env,
      '/usr/bin/node',
      'linux',
    )
    assert.ok(parsed.ok)
    return parsed.config
  }

  test('one line for each lazy server, cached or not, with no argument, env value or path', () => {
    const found = lazyFindings(config(), key => (key === 'claude-code' ? 12 : undefined))
    assert.deepEqual(
      found.map(f => f.detail),
      [
        'claude-code: starts on first use and stops after 10 min idle, tool list cached (12 tools)',
        'opted: starts on first use and stops after 10 min idle, tool list not cached yet (starts once at the next session)',
      ],
    )
    for (const secret of ['sekret-arg', 'sekret-env', '/opt/private'])
      assert.ok(!JSON.stringify(found).includes(secret), secret)
  })

  test('with TOOLSCRIPT_LAZY=0 one line says that every server starts with the session', () => {
    assert.deepEqual(
      lazyFindings(config({ TOOLSCRIPT_LAZY: '0' }), () => 3).map(f => f.detail),
      ['lazy start is off (TOOLSCRIPT_LAZY=0): every server starts with the session'],
    )
  })
})
