// The checks of a first run: `toolscript-mcp tools <server>` against the demo server and fake servers, `toolscript-mcp
// runs` on a temp run log, and the first task of the demo through run_code, from the run to the run log. Every HOME and
// config is in a temp dir.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { NPX_LAUNCH, parseConfig } from '../src/core/config.ts'
import { oldRunLogFile, runLogFile } from '../src/core/paths.ts'
import { newKept } from '../src/core/protocol.ts'
import { runLine, type RunRecord } from '../src/core/runlog.ts'
import { runRuns, runTools, type CheckIo } from '../src/host/diagnose.ts'
import { connectAll } from '../src/host/downstream.ts'
import { runCode, type RunContext } from '../src/host/run.ts'
import { MAX_PAGE_SIZE, OPEN_BY_AUTHOR, PULL_REQUESTS } from '../demo/data.mjs'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-diagnose-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

const DEMO = path.join(import.meta.dirname, '..', 'demo', 'server.mjs')
const SECRET = 'fake-secret-value-0123456789'

// A stdio server whose tools carry each hint and the mark of a tool that needs a person. It writes SECRET to stderr.
const FAKE = path.join(ROOT, 'fake-server.mjs')
fs.writeFileSync(
  FAKE,
  `import readline from 'node:readline'
process.stderr.write('started with ${SECRET}\\n')
const tools = [
  { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'wipe', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  { name: 'send', inputSchema: { type: 'object' }, _meta: { 'anthropic/requiresUserInteraction': true } },
  { name: 'both', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
]
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  if (m.method === 'initialize')
    return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
  if (m.method === 'tools/list') return reply({ tools })
  reply({})
})
`,
)

/** A temp HOME and a config file of `json`, and an io that keeps what the command prints. */
const setup = (json: unknown) => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  const config = path.join(dir, 'config.json')
  fs.writeFileSync(config, JSON.stringify(json))
  const printed: string[] = []
  const io: CheckIo = {
    env: {
      TOOLSCRIPT_CONFIG: undefined,
      APPDATA: path.join(home, 'AppData'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
    },
    platform: process.platform,
    home,
    version: '0.0.0',
    launch: NPX_LAUNCH,
    print: text => void printed.push(...text.split('\n')),
  }
  return { home, config, io, printed, tools: (key: string) => runTools([key, '--config', config], io) }
}

const demoEntry = { command: process.execPath, args: [DEMO] }

describe('tools', () => {
  test('lists the tools of the demo server with their hints and the decision of the policy', async () => {
    const s = setup({ mcpServers: { demo: demoEntry }, policy: [{ match: 'mcp__demo__list_*', action: 'allow' }] })
    assert.equal(await s.tools('demo'), 0, s.printed.join('\n'))
    assert.deepEqual(s.printed, [
      'demo: connected, 2 tools',
      'mcp__demo__list_pull_requests read-only allow',
      'mcp__demo__get_pull_request read-only ask',
    ])
  })

  test('shows a deny rule and the tools that need a person, and drops the stderr of the child', async () => {
    const s = setup({
      mcpServers: { fake: { command: process.execPath, args: [FAKE] } },
      policy: [
        { match: 'mcp__fake__wipe', action: 'deny' },
        { match: 'mcp__fake__both', action: 'deny' },
        { match: 'mcp__fake__*', action: 'allow' },
      ],
    })
    const writes: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => (writes.push(String(chunk)), true)) as typeof write
    try {
      assert.equal(await s.tools('fake'), 0, s.printed.join('\n'))
    } finally {
      process.stderr.write = write
    }
    assert.deepEqual(s.printed, [
      'fake: connected, 4 tools',
      'mcp__fake__read read-only allow',
      'mcp__fake__wipe destructive deny',
      'mcp__fake__send - allow, a person each run',
      'mcp__fake__both read-only deny',
    ])
    assert.ok(!writes.join('').includes(SECRET), 'the stderr of the child stays out of the output')
  })

  test('names the servers of the config when the server is not in it', async () => {
    const s = setup({ mcpServers: { demo: demoEntry, other: demoEntry } })
    assert.equal(await s.tools('nope'), 1)
    assert.deepEqual(s.printed, [`the config ${s.config} has no server "nope". Its servers: demo, other`])
  })

  test('gives the reason of a server that cannot connect, without its secrets', async () => {
    const s = setup({
      mcpServers: {
        broken: {
          command: process.execPath,
          args: ['-e', 'console.error("bad token " + process.env.API_TOKEN); process.exit(3)'],
          env: { API_TOKEN: SECRET },
        },
      },
    })
    assert.equal(await s.tools('broken'), 1)
    assert.equal(s.printed.length, 1)
    assert.match(s.printed[0]!, /^broken: cannot connect: .*bad token \*\*\*/)
    assert.ok(!s.printed[0]!.includes(SECRET))
  })

  test('gives the login command of a server that needs an OAuth login, and registers no client', async () => {
    const paths: string[] = []
    const server = http.createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`)
      req.resume()
      if (req.url?.startsWith('/.well-known/')) return void res.writeHead(404).end()
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const s = setup({ mcpServers: { fake: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, oauth: true } } })
      assert.equal(await s.tools('fake'), 1)
      assert.equal(s.printed.length, 1)
      assert.match(
        s.printed[0]!,
        /^fake: needs an OAuth login\. Run this command in a terminal, then run tools again: npx -y toolscript-mcp login fake --config /,
      )
      assert.deepEqual(
        paths.filter(p => p.includes('register')),
        [],
      )
    } finally {
      server.close()
    }
  })

  test('exits 2 on a usage error', async () => {
    const s = setup({ mcpServers: {} })
    assert.equal(await runTools([], s.io), 2)
    assert.equal(await runTools(['a', 'b'], s.io), 2)
    assert.equal(await runTools(['a', '--nope'], s.io), 2)
  })
})

const record = (o: Partial<RunRecord> & Pick<RunRecord, 'time' | 'ending' | 'calls'>): RunRecord => ({
  id: 'run',
  ms: 100,
  chars: 10,
  ...o,
})

describe('runs', () => {
  const setupLog = (lines: readonly string[], old: readonly string[] = []) => {
    const s = setup({ mcpServers: {} })
    fs.mkdirSync(path.dirname(runLogFile(s.home)), { recursive: true })
    fs.writeFileSync(runLogFile(s.home), lines.join(''))
    if (old.length > 0) fs.writeFileSync(oldRunLogFile(s.home), old.join(''))
    return { ...s, runs: (...args: string[]) => runRuns(args, s.io) }
  }
  const done = runLine(
    record({
      time: '2026-01-01T00:00:01.000Z',
      ending: 'done',
      calls: [{ tool: 'mcp__demo__list_pull_requests', decision: 'allow', ms: 5, ok: true }],
    }),
  )
  const denied = runLine(
    record({
      time: '2026-01-01T00:00:02.000Z',
      ending: 'refused',
      ms: 0,
      calls: [{ tool: 'mcp__demo__get_pull_request', decision: 'denied', ms: 0, ok: false, error: 'denied' }],
    }),
  )
  const noServer = runLine(
    record({
      time: '2026-01-01T00:00:03.000Z',
      ending: 'error',
      calls: [{ tool: 'mcp__other__ping', decision: 'allow', ms: 1, ok: false, error: 'no-server' }],
    }),
  )
  const unapproved = runLine(
    record({
      time: '2026-01-01T00:00:04.000Z',
      ending: 'refused',
      ms: 0,
      calls: [{ tool: 'mcp__demo__get_pull_request', decision: 'unapproved', ms: 0, ok: false, error: 'unapproved' }],
    }),
  )
  // Newer than the others, but none is a run: not JSON, a wrong ending, and a control character in a tool name.
  const malformed = [
    'not json\n',
    `${JSON.stringify({ ...JSON.parse(done), time: '2026-01-01T00:00:09.000Z', ending: 'weird' })}\n`,
    `${JSON.stringify({ ...JSON.parse(done), time: '2026-01-01T00:00:09.000Z', calls: [{ ...JSON.parse(done).calls[0], tool: 'mcp__demo__x\u001b[2J' }] })}\n`,
  ]

  test('with no log, says no run yet and exits 1', async () => {
    const s = setup({ mcpServers: {} })
    assert.equal(await runRuns([], s.io), 1)
    assert.deepEqual(s.printed, ['no run yet'])
  })

  test('shows the newest run of the server and the next step for each problem, and skips malformed lines', async () => {
    const s = setupLog([denied, noServer, unapproved, ...malformed], [done])
    assert.equal(await s.runs('--server', 'demo'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:04.000Z refused 0 ms',
      '  mcp__demo__get_pull_request unapproved unapproved',
      'unapproved: approve the tool in the prompt, or add an allow rule with its exact name. A tool that needs a person each run needs the prompt.',
      'refused: the program did not start. A call code says why. A call without a code had a server that was not connected, or arguments that did not fit.',
    ])
  })

  test('--last shows more runs, newest first, with one line for each distinct problem', async () => {
    const s = setupLog([denied, noServer, unapproved, ...malformed], [done])
    assert.equal(await s.runs('--server', 'demo', '--last', '5'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:04.000Z refused 0 ms',
      '  mcp__demo__get_pull_request unapproved unapproved',
      '2026-01-01T00:00:02.000Z refused 0 ms',
      '  mcp__demo__get_pull_request denied denied',
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
      'unapproved: approve the tool in the prompt, or add an allow rule with its exact name. A tool that needs a person each run needs the prompt.',
      'refused: the program did not start. A call code says why. A call without a code had a server that was not connected, or arguments that did not fit.',
      'denied: a deny rule of the policy matches the tool. The policy decides: setup does not override it.',
    ])
  })

  test('a server that did not connect points at the tools command of that server', async () => {
    const s = setupLog([done, noServer])
    assert.equal(await s.runs('--server', 'other'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:03.000Z error 100 ms',
      '  mcp__other__ping allow no-server',
      'no-server: the server did not connect. Run `npx -y toolscript-mcp tools other` to see the connection or login problem.',
      'error: the program threw an error. Read it in the run_code result.',
    ])
  })

  test('exits 0 when the newest run of the server ended done and each of its calls worked', async () => {
    const s = setupLog([denied, noServer, done])
    assert.equal(await s.runs('--server', 'demo'), 0)
    assert.deepEqual(s.printed, ['2026-01-01T00:00:01.000Z done 100 ms', '  mcp__demo__list_pull_requests allow ok'])
    assert.equal(await s.runs('--server', 'other'), 1, 'the newest run of other still failed')
  })

  test('without --server, shows the newest run of any server', async () => {
    const s = setupLog([unapproved, noServer])
    assert.equal(await s.runs(), 1)
    assert.equal(s.printed[0], '2026-01-01T00:00:03.000Z error 100 ms')
  })

  test('a server with no run says no run yet', async () => {
    const s = setupLog([done])
    assert.equal(await s.runs('--server', 'other'), 1)
    assert.deepEqual(s.printed, ['no run yet'])
  })

  test('exits 2 on a usage error', async () => {
    const s = setupLog([done])
    for (const args of [['--last', '0'], ['--last', 'x'], ['--server', 'a__b'], ['extra'], ['--nope']])
      assert.equal(await s.runs(...args), 2, args.join(' '))
  })
})

describe('the demo server', () => {
  test('the answer of the first task matches the data, and needs more than one page', () => {
    const open: Record<string, number> = {}
    for (const pr of PULL_REQUESTS.filter(p => p.state === 'open')) open[pr.author] = (open[pr.author] ?? 0) + 1
    assert.deepEqual(open, OPEN_BY_AUTHOR)
    assert.ok(Object.values(open).reduce((a, b) => a + b) > MAX_PAGE_SIZE)
  })

  test('the first task runs through run_code, and runs then reports the route as working', async () => {
    const s = setup({ mcpServers: { demo: demoEntry }, policy: [{ match: 'mcp__demo__list_*', action: 'allow' }] })
    const parsed = parseConfig(fs.readFileSync(s.config, 'utf8'), {}, process.execPath, process.platform)
    assert.ok(parsed.ok)
    const downstream = connectAll(parsed.config.servers, '0.0.0', () => {}, { home: s.home })
    const ctx: RunContext = {
      downstream,
      config: parsed.config,
      kept: newKept(),
      written: new Map(),
      untrustedFiles: new Set(),
      shapes: new Map(),
      filesDir: path.join(s.home, 'files'),
      policyNote: '',
      ask: async () => 'decline',
      canAsk: () => false,
      signal: new AbortController().signal,
      log: () => {},
      home: s.home,
    }
    try {
      const count = await runCode(
        ctx,
        `const open = {}
let cursor
do {
  const page = await call('mcp__demo__list_pull_requests', { state: 'open', per_page: 20, ...(cursor ? { cursor } : {}) })
  for (const pr of page.pull_requests) open[pr.author] = (open[pr.author] ?? 0) + 1
  cursor = page.next_cursor
} while (cursor)
return open`,
      )
      assert.equal(count.isError, false, count.text)
      assert.deepEqual(JSON.parse(count.text.split('\n\n---')[0]!), OPEN_BY_AUTHOR)
      assert.equal(await runRuns(['--server', 'demo'], s.io), 0, s.printed.join('\n'))
      assert.match(s.printed[0]!, /^\S+ done \d+ ms$/)
      assert.deepEqual(s.printed.slice(1), [
        '  mcp__demo__list_pull_requests allow ok',
        '  mcp__demo__list_pull_requests allow ok',
      ])

      s.printed.length = 0
      const one = await runCode(ctx, `return await call('mcp__demo__get_pull_request', { number: 1 })`)
      assert.equal(one.isError, true)
      assert.equal(await runRuns(['--server', 'demo'], s.io), 1)
      assert.match(s.printed.join('\n'), /mcp__demo__get_pull_request unapproved unapproved\nunapproved: /)
    } finally {
      await downstream.close()
    }
  })
})
