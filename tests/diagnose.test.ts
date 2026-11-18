// The checks of a first run: `toolscript-mcp tools <server>` against the demo server and fake servers, `toolscript-mcp
// runs` on a temp run log, and the first task of the demo through run_code, from the run to the run log. Every HOME and
// config is in a temp dir.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
import { runLogin } from '../src/host/login.ts'
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
  { name: 'x\\u202ey z', inputSchema: { type: 'object' } },
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

/** True when no printed line holds a character outside printable ASCII. */
const printableOnly = (lines: readonly string[]): boolean => lines.every(l => /^[\x20-\x7e]*$/.test(l))

describe('tools', () => {
  test('lists the tools of the demo server with their hints and the decision of the policy', async () => {
    const s = setup({ mcpServers: { demo: demoEntry }, policy: [{ match: 'mcp__demo__list_*', action: 'allow' }] })
    assert.equal(await s.tools('demo'), 0, s.printed.join('\n'))
    assert.deepEqual(s.printed, [
      'demo: connected, 2 tools',
      'mcp__demo__list_pull_requests read-only allow',
      'mcp__demo__get_pull_request read-only ask',
      '',
      'Commands that allow tools:',
      '  - mcp__demo__get_pull_request',
      `    npx -y toolscript-mcp allow --config "${s.config.replaceAll('\\', '/')}" "mcp__demo__get_pull_request"`,
    ])
  })

  test('shows a deny rule, the tools that need a person and an escaped name, and drops the stderr of the child', async () => {
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
      'fake: connected, 5 tools',
      'mcp__fake__read read-only allow',
      'mcp__fake__wipe destructive deny',
      'mcp__fake__send - allow, a person each run',
      'mcp__fake__both read-only deny',
      '"mcp__fake__x\\u202ey z" - allow',
    ])
    assert.ok(!writes.join('').includes(SECRET), 'the stderr of the child stays out of the output')
  })

  /** Runs tools on an HTTP server that answers each request with a 500 and `body`. */
  const failingHttp = async (body: string) => {
    const server = http.createServer((req, res) => {
      req.resume()
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const s = setup({ mcpServers: { broken: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } })
      return { code: await s.tools('broken'), printed: s.printed }
    } finally {
      server.close()
    }
  }

  test('escapes the control characters of the error text of a server in the reason', async () => {
    const { code, printed } = await failingHttp('red \u001b[31m')
    assert.equal(code, 1)
    assert.match(printed.join('\n'), /red \\u001b\[31m/)
    assert.ok(printableOnly(printed))
  })

  test('keeps the letters of a user folder name in the reason, and escapes a bidi control', async () => {
    const { code, printed } = await failingHttp('cannot open C:\\Users\\\ud64d\uae38\ub3d9 \u202eevil')
    assert.equal(code, 1)
    assert.match(printed.join('\n'), /cannot open C:\\Users\\\ud64d\uae38\ub3d9 \\u202eevil/)
    assert.equal(printed.length, 1)
  })

  test('make it fail: the reason of an untrusted server holds no text of its child, and names no log that tools lacks', async () => {
    const s = setup({
      mcpServers: {
        broken: {
          command: process.execPath,
          args: ['-e', `console.error(${JSON.stringify(SECRET)}); process.exit(3)`],
          untrusted: true,
        },
      },
    })
    assert.equal(await s.tools('broken'), 1)
    assert.deepEqual(s.printed, [
      'broken: cannot connect: the connect failed. tools does not show its error text, because the text of this server is untrusted. When the client starts toolscript-mcp, its log holds the text',
    ])
  })

  test('names the servers of the config when the server is not in it', async () => {
    const s = setup({ mcpServers: { demo: demoEntry, other: demoEntry } })
    assert.equal(await s.tools('nope'), 1)
    assert.deepEqual(s.printed, [`the config ${s.config} has no server "nope". Its servers: demo, other`])
  })

  test('make it fail: the reason of a child that cannot connect holds no text of its stderr, also a token from outside the config', async () => {
    const outside = 'sk-live-NOTINCONFIG-5f2a9c81d7'
    const s = setup({
      mcpServers: {
        broken: {
          command: process.execPath,
          args: [
            '-e',
            `console.error("bad token " + process.env.API_TOKEN + ", and ${outside} from ~/.netrc"); process.exit(3)`,
          ],
          env: { API_TOKEN: SECRET },
        },
      },
    })
    assert.equal(await s.tools('broken'), 1)
    assert.equal(s.printed.length, 1)
    assert.match(
      s.printed[0]!,
      /^broken: cannot connect: .*\. Its stderr is not shown here\. To read it, run the command of the server in a terminal\. /,
    )
    for (const text of [outside, SECRET, 'bad token']) assert.ok(!s.printed[0]!.includes(text), s.printed[0])
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
  const setupLog = (lines: readonly string[], old: readonly string[] = [], config: unknown = { mcpServers: {} }) => {
    const s = setup(config)
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
  /** A line of the log as another program can write it. */
  const forged = (o: Record<string, unknown>) => `${JSON.stringify({ ...JSON.parse(done), ...o })}\n`
  // None is a run: not JSON, and a wrong ending.
  const malformed = ['not json\n', forged({ time: '2026-01-01T00:00:09.000Z', ending: 'weird' })]
  const SKIPPED_NEWER =
    'A skipped line is newer than the newest run shown, so runs does not confirm that run. Run the task again.'

  test('with no log, says no run yet and exits 1', async () => {
    const s = setup({ mcpServers: {} })
    assert.equal(await runRuns([], s.io), 1)
    assert.deepEqual(s.printed, ['no run yet'])
  })

  test('shows the newest run of the server and the next step for each problem', async () => {
    const s = setupLog([denied, noServer, unapproved], [done])
    assert.equal(await s.runs('--server', 'demo'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:04.000Z refused 0 ms',
      '  mcp__demo__get_pull_request unapproved unapproved',
      'unapproved: approve the tool in the prompt, or add an allow rule with its exact name. A tool that needs a person each run needs the prompt.',
      'refused: the program did not start. A call code says why. A call without a code had a server that was not connected, or arguments that did not fit.',
    ])
  })

  test('--last shows more runs, newest first, with one line for each distinct problem', async () => {
    const s = setupLog([denied, noServer, unapproved], [done])
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

  test('with --config, the tools command names the same config', async () => {
    const s = setupLog([done, noServer])
    assert.equal(await s.runs('--server', 'other', '--config', s.config), 1)
    assert.match(
      s.printed.join('\n'),
      /^no-server: the server did not connect\. Run `npx -y toolscript-mcp tools other --config \S+config\.json` to see/m,
    )
  })

  test('make it fail: the printed command of a key that starts with - runs in a shell and checks that server', async () => {
    const tool = 'mcp__-x__ping'
    const s = setupLog(
      [forged({ ending: 'error', calls: [{ tool, decision: 'allow', ms: 1, ok: false, error: 'no-server' }] })],
      [],
      { mcpServers: { '-x': demoEntry } },
    )
    const argv = path.join(path.dirname(s.config), 'argv.js')
    fs.writeFileSync(argv, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    assert.equal(
      await runRuns(['--server=-x', '--config', s.config], { ...s.io, launch: { kind: 'node', main: argv } }),
      1,
    )
    const line = /Run `(.+)` to see/.exec(s.printed.join('\n'))?.[1]
    assert.ok(line !== undefined, s.printed.join('\n'))
    const shell = spawnSync(line, { shell: true, encoding: 'utf8', windowsHide: true })
    assert.equal(shell.status, 0, `${line}\n${shell.stderr}`)
    const [command, ...args] = JSON.parse(shell.stdout) as string[]
    assert.equal(command, 'tools')
    s.printed.length = 0
    assert.equal(await runTools(args, s.io), 0, s.printed.join('\n'))
    assert.equal(s.printed[0], '-x: connected, 2 tools')
    s.printed.length = 0
    assert.equal(await runLogin(args, s.io), 1, 'login reads the same words')
    assert.deepEqual(s.printed, ['-x is a stdio server. Only an HTTP server logs in with OAuth.'])
  })

  test('make it fail: a server name that is not a key never reaches a printed command', async () => {
    const tool = "mcp__x$';echo PWNED >&2;'y__ping"
    const s = setupLog([
      forged({ ending: 'error', calls: [{ tool, decision: 'allow', ms: 1, ok: false, error: 'no-server' }] }),
    ])
    assert.equal(await s.runs(), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:01.000Z error 100 ms',
      `  ${JSON.stringify(tool)} allow no-server`,
      'no-server: the server did not connect. Run toolscript-mcp tools with its key to see the connection or login problem.',
      'error: the program threw an error. Read it in the run_code result.',
    ])
  })

  test('make it fail: escapes C1 control and bidi characters in each printed field', async () => {
    const s = setupLog([
      forged({
        time: '2026-01-01T00:00:02\u009b2J‮Z',
        calls: [{ tool: 'mcp__demo__x\u001b[2J', decision: 'allow', ms: 1, ok: true }],
      }),
    ])
    assert.equal(await s.runs('--server', 'demo'), 0, s.printed.join('\n'))
    assert.deepEqual(s.printed, [
      '"2026-01-01T00:00:02\\u009b2J\\u202eZ" done 100 ms',
      '  "mcp__demo__x\\u001b[2J" allow ok',
    ])
    assert.ok(printableOnly(s.printed))
  })

  test('make it fail: a call that it cannot read keeps its run, shows as unreadable and never counts as ok', async () => {
    const calls = [{ tool: 'mcp__demo__a', decision: 'weird', ms: 1, ok: true }, 42]
    const s = setupLog([done, forged({ time: '2026-01-01T00:00:05.000Z', calls })])
    assert.equal(await s.runs('--server', 'demo'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:05.000Z done 100 ms',
      '  mcp__demo__a unreadable',
      '  - unreadable',
      'unreadable: this toolscript-mcp cannot read the call. Another version or another program wrote it.',
    ])
    assert.equal(await s.runs('--server', 'other'), 1, 'a call without a server can be a call of any server')
  })

  test('make it fail: an unreadable line newer than the newest run never lets an older run pass', async () => {
    const s = setupLog([done, ...malformed])
    assert.equal(await s.runs('--server', 'demo'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
      'skipped unreadable lines of the run log: 2',
      SKIPPED_NEWER,
    ])
  })

  test('make it fail: an ok call that the policy did not let run, or with an error code, is unreadable', async () => {
    for (const call of [
      { decision: 'denied', ok: true },
      { decision: 'unapproved', ok: true },
      { decision: 'invalid', ok: true },
      { decision: 'allow', ok: true, error: 'tool-error' },
    ]) {
      const s = setupLog([forged({ calls: [{ tool: 'mcp__demo__a', ms: 1, ...call }] })])
      assert.equal(await s.runs('--server', 'demo'), 1, JSON.stringify(call))
      assert.deepEqual(s.printed, [
        '2026-01-01T00:00:01.000Z done 100 ms',
        '  mcp__demo__a unreadable',
        'unreadable: this toolscript-mcp cannot read the call. Another version or another program wrote it.',
      ])
    }
    const approved = setupLog([
      forged({ calls: [{ tool: 'mcp__demo__a', decision: 'ask-approved', ms: 1, ok: true }] }),
    ])
    assert.equal(await approved.runs('--server', 'demo'), 0, 'an approved call that worked still counts')
  })

  test('make it fail: a run with calls that were not logged confirms nothing', async () => {
    const s = setupLog([forged({ omitted: 3 })])
    assert.equal(await s.runs('--server', 'demo'), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
      '  3 more calls',
      '3 calls of the newest run were not logged, so runs does not confirm that run. Run a task with at most 200 calls.',
    ])
  })

  test('make it fail: a run dated more than 5 minutes after now never passes --since, nor confirms an older run', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    const future = forged({ time: '2099-01-01T00:00:00.000Z' })
    const s = setupLog([future])
    assert.equal(await s.runs('--server', 'demo', '--since', '1h'), 1)
    assert.deepEqual(s.printed, ['no run yet', 'skipped runs dated more than 5 minutes after now: 1'])
    s.printed.length = 0
    const t = setupLog([done, future])
    assert.equal(await t.runs('--server', 'demo'), 1)
    assert.deepEqual(t.printed, [
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
      'skipped runs dated more than 5 minutes after now: 1',
      SKIPPED_NEWER,
    ])
    const u = setupLog([future, done, forged({ time: soon })])
    assert.equal(await u.runs('--server', 'demo', '--since', '1h'), 0, 'a run a minute ahead still counts')
    assert.equal(u.printed[1], `${soon} done 100 ms`)
    u.printed.length = 0
    assert.equal(await u.runs('--server', 'other'), 1)
    assert.deepEqual(u.printed, ['no run yet'], 'a future run of another server is not counted')
  })

  test('an unreadable line older than the newest run is counted and does not change the exit code', async () => {
    const s = setupLog([...malformed, done])
    assert.equal(await s.runs('--server', 'demo'), 0)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
      'skipped unreadable lines of the run log: 2',
    ])
  })

  test('says so when the config turns the log off, and exits 1', async () => {
    const s = setupLog([done], [], { mcpServers: {}, log: false })
    assert.equal(await s.runs('--server', 'demo', '--config', s.config), 1)
    assert.deepEqual(s.printed, [
      `the config ${s.config} sets "log": false, so toolscript-mcp writes no run log with it. Remove the key to check runs.`,
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
    ])
  })

  test('a --config that cannot be read exits 1, and the default config is not needed', async () => {
    const s = setupLog([done])
    const missing = path.join(path.dirname(s.config), 'missing.json')
    assert.equal(await s.runs('--config', missing), 1)
    assert.match(s.printed[0]!, /^cannot read the config /)
    s.printed.length = 0
    assert.equal(await s.runs(), 0, 'no config at the default path')
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

  test('make it fail: a run that called no tool, or no tool of the server, confirms nothing', async () => {
    const idle = runLine(record({ time: '2026-01-01T00:00:05.000Z', ending: 'done', calls: [] }))
    const s = setupLog([done, idle])
    assert.equal(await s.runs(), 1)
    assert.deepEqual(s.printed, [
      '2026-01-01T00:00:05.000Z done 100 ms',
      'the newest run called no tool. Run a task that calls one.',
    ])
    s.printed.length = 0
    assert.equal(await s.runs('--server', 'demo'), 0, 'the newest run of demo is the one with a call')
    s.printed.length = 0
    const other = forged({
      time: '2026-01-01T00:00:06.000Z',
      calls: [{ tool: 'mcp__other__ping', decision: 'allow', ms: 1, ok: true }],
    })
    const t = setupLog([other])
    assert.equal(await t.runs('--server', 'demo'), 1)
    assert.deepEqual(t.printed, ['no run yet'])
  })

  test('make it fail: --since never lets a run before the time confirm a new attempt', async () => {
    const s = setupLog([done])
    assert.equal(await s.runs('--server', 'demo', '--since', '2026-01-01T00:00:02Z'), 1)
    assert.deepEqual(s.printed, ['no run since 2026-01-01T00:00:02.000Z'])
    s.printed.length = 0
    assert.equal(await s.runs('--server', 'demo', '--since', '2026-01-01T09:00:01+09:00'), 0, 'at the time counts')
    assert.deepEqual(s.printed, [
      'runs since 2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:01.000Z done 100 ms',
      '  mcp__demo__list_pull_requests allow ok',
    ])
    s.printed.length = 0
    assert.equal(await s.runs('--server', 'other', '--since', '1d'), 1)
    assert.deepEqual(s.printed, ['no run yet'], 'a server without any run is still no run yet')
  })

  test('--since with a duration counts back from now, and shows the time', async () => {
    const now = new Date().toISOString()
    const fresh = runLine(record({ time: now, ending: 'done', calls: [JSON.parse(done).calls[0]] }))
    const s = setupLog([done, fresh])
    assert.equal(await s.runs('--since', '30m', '--last', '5'), 0, s.printed.join('\n'))
    assert.match(s.printed[0]!, /^runs since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(s.printed[1], `${now} done 100 ms`)
    assert.equal(s.printed.length, 3, 'the run of 2026-01-01 is older')
  })

  test('exits 2 on a usage error', async () => {
    const s = setupLog([done])
    for (const args of [
      ['--last', '0'],
      ['--last', 'x'],
      ['--server', 'a__b'],
      ['extra'],
      ['--nope'],
      ['--since', 'yesterday'],
      ['--since', '2026-01-01T00:00:00'],
      ['--since', '0m'],
    ])
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
