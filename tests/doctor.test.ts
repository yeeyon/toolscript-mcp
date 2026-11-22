// `toolscript-mcp doctor`: the pure parts of its checks, then whole runs against the demo server, failing servers, a
// policy with problems, the run log, a stale OAuth store and a missing config. The sandbox check runs the real runner.
// Every HOME and config is in a temp dir.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NPX_LAUNCH, type ServerKey } from '../src/core/config.ts'
import {
  aclFinding,
  brokerFail,
  checkLine,
  hiddenBy,
  nodeFinding,
  policyFindings,
  shareFindings,
  staleStoreKeys,
} from '../src/core/doctor.ts'
import { parseConfig } from '../src/core/config.ts'
import { appPath, oauthFolder, runLogFile } from '../src/core/paths.ts'
import type { Rule } from '../src/core/policy.ts'
import { runLine, type RunRecord } from '../src/core/runlog.ts'
import type { CheckIo } from '../src/host/diagnose.ts'
import { runDoctor } from '../src/host/doctor.ts'
import { storeFile } from '../src/host/oauth.ts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-doctor-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

const DEMO = path.join(import.meta.dirname, '..', 'demo', 'server.mjs')
const SECRET = 'fake-secret-value-0123456789'

const rules = (...pairs: [string, Rule['action']][]): Rule[] =>
  pairs.map(([match, action], index) => ({ match, action, index }))
const key = (k: string) => k as ServerKey
const connected = (server: string, ...tools: { name: string; _meta?: unknown }[]) => ({
  key: key(server),
  status: 'connected' as const,
  tools,
})
const failed = (server: string) => ({ key: key(server), status: 'failed' as const, reason: 'down' })
const texts = (findings: readonly { status: string; detail: string }[]) => findings.map(f => `${f.status} ${f.detail}`)

describe('hiddenBy', () => {
  test('`*` covers every glob, and no narrower glob covers `*`', () => {
    for (const later of ['*', 'mcp__x__read', 'mcp__x__*', '*delete*', ''])
      assert.equal(hiddenBy('*', later), true, later)
    for (const earlier of ['mcp__*', 'mcp__x__*', '*a*', 'a*', '*a'])
      assert.equal(hiddenBy(earlier, '*'), false, earlier)
  })

  test('`mcp__x__*` covers the names and globs of server x only', () => {
    for (const later of ['mcp__x__read', 'mcp__x__*', 'mcp__x__a*b', 'mcp__x__*__*'])
      assert.equal(hiddenBy('mcp__x__*', later), true, later)
    for (const later of ['mcp__y__read', 'mcp__x*', 'mcp__*__read', 'mcp__x_*', 'mcp__xy__read'])
      assert.equal(hiddenBy('mcp__x__*', later), false, later)
  })

  test('an exact name covers only the same name', () => {
    assert.equal(hiddenBy('mcp__x__read', 'mcp__x__read'), true)
    assert.equal(hiddenBy('mcp__x__read', 'mcp__x__reads'), false)
    assert.equal(hiddenBy('mcp__x__read', 'mcp__x__read*'), false)
    assert.equal(hiddenBy('mcp__x__read', 'mcp__x__*'), false)
  })

  test('globs with several `*` keep the order of their parts', () => {
    assert.equal(hiddenBy('mcp__*__*delete*', 'mcp__x__bulk_delete_all'), true)
    assert.equal(hiddenBy('mcp__*__*delete*', 'mcp__x__*delete*'), true)
    assert.equal(hiddenBy('mcp__*__*delete*', 'mcp__*__delete'), true)
    assert.equal(hiddenBy('*a*b*', 'xa*yb'), true)
    assert.equal(hiddenBy('*a*b*', '*a*b*'), true)
    assert.equal(hiddenBy('*a*b*', '*b*a*'), false, '"ba" has no a before a b')
    assert.equal(hiddenBy('*ab*', '*a*b*'), false, '"axb" has no "ab"')
    assert.equal(hiddenBy('a*', 'ab*'), true)
    assert.equal(hiddenBy('ab*', 'a*'), false)
    assert.equal(hiddenBy('*_read', 'mcp__*__get_read'), true)
    assert.equal(hiddenBy('*_read', 'mcp__*__read'), true, 'each such name ends in "__read"')
    assert.equal(hiddenBy('*_read', 'mcp__*__read*'), false, '"mcp__x__reads" does not end in "_read"')
  })

  test('a `*` of the later glob never matches a literal of the earlier one', () => {
    assert.equal(hiddenBy('a', 'a*'), false)
    assert.equal(hiddenBy('*', 'x'), true)
  })
})

describe('policyFindings', () => {
  const none = new Set<ServerKey>()
  const bridge = new Set([key('claude-code')])

  test('names a rule that an earlier rule always hides, with both rules', () => {
    const found = policyFindings(
      rules(['mcp__x__*', 'allow'], ['mcp__x__wipe', 'deny'], ['mcp__y__wipe', 'deny']),
      none,
      [connected('x', { name: 'wipe' }), connected('y', { name: 'wipe' })],
    )
    assert.deepEqual(texts(found), [
      'warn policy[1] {"match": "mcp__x__wipe", "action": "deny"} never decides a tool: the earlier policy[0] {"match": "mcp__x__*", "action": "allow"} matches each tool that it matches',
    ])
  })

  test('an allow rule that a tool of a bridge skips hides only the rules that name another server', () => {
    const found = policyFindings(
      rules(['*', 'allow'], ['mcp__claude-code__Bash', 'deny'], ['mcp__*__Bash', 'deny'], ['mcp__x__Bash', 'deny']),
      bridge,
      [connected('claude-code', { name: 'Bash' }), connected('x', { name: 'Bash' })],
    )
    const hidden = texts(found).filter(t => t.includes('never decides'))
    assert.deepEqual(
      hidden.map(t => t.slice(0, t.indexOf(' never'))),
      ['warn policy[3] {"match": "mcp__x__Bash", "action": "deny"}'],
    )
  })

  test('a deny or ask rule hides a later rule also for a bridge', () => {
    const found = policyFindings(rules(['*', 'deny'], ['mcp__claude-code__Read', 'allow']), bridge, [])
    assert.ok(texts(found).some(t => t.startsWith('warn policy[1] ') && t.includes('never decides')))
  })

  test('names an allow rule that matches no listed tool, only when every server connected', () => {
    const policy = rules(['mcp__x__gone', 'allow'], ['mcp__x__read', 'allow'], ['mcp__x__nope', 'deny'])
    assert.deepEqual(texts(policyFindings(policy, none, [connected('x', { name: 'read' })])), [
      'warn policy[0] {"match": "mcp__x__gone", "action": "allow"} matches no tool of the servers: check the name, or remove the rule if the tool is gone',
    ])
    assert.deepEqual(texts(policyFindings(policy, none, [connected('x', { name: 'read' }), failed('y')])), [
      'ok 3 rules',
      'info skipped the check for allow rules that match no tool, because a server did not connect',
    ])
  })

  test('names an allow rule such as `*` that does not allow the tools of a bridge', () => {
    const found = policyFindings(
      rules(['*', 'allow'], ['mcp__*__Read', 'allow'], ['mcp__claude-code__*', 'allow'], ['mcp__x__*', 'allow']),
      bridge,
      [connected('claude-code', { name: 'Read' }), connected('x', { name: 'Read' })],
    )
    assert.deepEqual(
      texts(found).filter(t => t.includes('bridge')),
      [
        'warn policy[0] {"match": "*", "action": "allow"} does not allow the tools of the Claude Code bridge claude-code: only an allow rule that starts with mcp__claude-code__ does',
        'warn policy[1] {"match": "mcp__*__Read", "action": "allow"} does not allow the tools of the Claude Code bridge claude-code: only an allow rule that starts with mcp__claude-code__ does',
      ],
    )
  })

  test('lists each tool that needs a person at each run, unless a deny rule matches it', () => {
    const person = { 'anthropic/requiresUserInteraction': true }
    const found = policyFindings(rules(['mcp__x__wipe', 'deny']), none, [
      connected('x', { name: 'send', _meta: person }, { name: 'wipe', _meta: person }, { name: 'read' }),
    ])
    assert.deepEqual(texts(found), [
      'ok 1 rules',
      'info mcp__x__send needs a person at each run: its server marks it, and an allow rule does not replace that',
    ])
  })

  test('says that an empty policy asks for each tool', () => {
    assert.deepEqual(texts(policyFindings([], none, [connected('x', { name: 'read' })])), [
      'ok no rules: a program asks the person before it calls a tool',
    ])
  })
})

test('nodeFinding passes 22.13 and later, and fails an older or unknown version', () => {
  assert.equal(nodeFinding('node', 'v22.13.0\n').status, 'ok')
  assert.equal(nodeFinding('node', 'v23.0.0').status, 'ok')
  assert.equal(nodeFinding('node', 'v24.11.1').status, 'ok')
  assert.equal(nodeFinding('node', 'v22.12.9').status, 'fail')
  assert.equal(nodeFinding('node', 'v20.19.0').status, 'fail')
  assert.deepEqual(nodeFinding('node', 'hello\u001b[31m'), {
    status: 'fail',
    detail: 'node printed "hello\\u001b[31m", which is not a Node version',
  })
})

test('staleStoreKeys names each store file that no server uses, once, by its key', () => {
  const files = ['gone-0123456789abcdef.json', 'gone-fedcba9876543210.json', 'used-0123456789abcdef.json', 'x.tmp']
  assert.deepEqual(staleStoreKeys(files, new Set(['used-0123456789abcdef.json'])), ['gone'])
  assert.deepEqual(staleStoreKeys(['my-server-0123456789abcdef.json'], new Set()), ['my-server'])
})

test('checkLine aligns the columns and escapes what a file or server wrote', () => {
  assert.equal(checkLine({ status: 'ok', name: 'node', detail: 'v22' }), 'ok    node     v22')
  assert.equal(checkLine({ status: 'warn', name: 'run-log', detail: 'a‮b\nc' }), 'warn  run-log  a\\u202eb\\u000ac')
})

/** A temp HOME and a config file of `json` (none when undefined), and an io that keeps what doctor prints. */
const setup = (json: unknown) => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  const config = path.join(dir, 'config.json')
  if (json !== undefined) fs.writeFileSync(config, typeof json === 'string' ? json : JSON.stringify(json))
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
  const doctor = () => runDoctor(['--config', config], io)
  /** The lines of one check, without the status and name columns when `bare`. */
  const of = (name: string) => printed.filter(l => l.slice(6, 6 + name.length + 1) === `${name} `)
  return { dir, home, config, io, printed, doctor, of }
}

const demoEntry = { command: process.execPath, args: [DEMO] }
const exiting = (script: string, extra: object = {}) => ({ command: process.execPath, args: ['-e', script], ...extra })

describe('doctor', () => {
  test('a setup with warnings only: a hidden rule, a dead allow rule, a bridge `*`, the log off, tokens of no server', async () => {
    const s = setup({
      mcpServers: { demo: demoEntry, 'claude-code': demoEntry },
      policy: [
        { match: 'mcp__demo__gone', action: 'allow' },
        { match: 'mcp__demo__*', action: 'allow' },
        { match: 'mcp__demo__get_pull_request', action: 'deny' },
        { match: '*', action: 'allow' },
      ],
      log: false,
    })
    fs.mkdirSync(oauthFolder(s.home), { recursive: true })
    fs.writeFileSync(path.join(oauthFolder(s.home), 'old-server-0123456789abcdef.json'), '{}')
    assert.equal(await s.doctor(), 0, s.printed.join('\n'))
    assert.deepEqual(s.of('servers'), [
      'ok    servers  demo: connected, 2 tools',
      'ok    servers  claude-code: connected, 2 tools',
    ])
    assert.deepEqual(s.of('policy'), [
      'warn  policy   policy[2] {"match": "mcp__demo__get_pull_request", "action": "deny"} never decides a tool: the earlier policy[1] {"match": "mcp__demo__*", "action": "allow"} matches each tool that it matches',
      'warn  policy   policy[0] {"match": "mcp__demo__gone", "action": "allow"} matches no tool of the servers: check the name, or remove the rule if the tool is gone',
      'warn  policy   policy[3] {"match": "*", "action": "allow"} does not allow the tools of the Claude Code bridge claude-code: only an allow rule that starts with mcp__claude-code__ does',
    ])
    assert.deepEqual(s.of('run-log'), [
      'warn  run-log  off: the config sets "log": false, so toolscript-mcp writes no run log, and runs cannot check a run',
    ])
    assert.deepEqual(s.of('files'), [
      `ok    files    ${appPath(s.home)} is writable`,
      `info  files    OAuth tokens that no server of this config uses: old-server. They can belong to another config, or the server is gone or its URL changed. If no other config uses the server, you can delete its file in ${oauthFolder(s.home)}`,
    ])
    assert.equal(s.of('config')[0], `ok    config   ${s.config}`)
    // The checks print in this order.
    const names = [...new Set(s.printed.map(l => l.slice(6, 14).trim()))]
    assert.deepEqual(names, ['node', 'config', 'servers', 'share', 'lazy', 'policy', 'sandbox', 'run-log', 'files'])
    assert.deepEqual(s.of('lazy'), [
      'info  lazy     claude-code: starts on first use and stops after 10 min idle, tool list not cached yet (starts once at the next session)',
    ])
    assert.ok(
      s.printed.every(l => /^(ok|info|warn|fail) +\S+ +\S/.test(l) && /^[\x20-\x7e]*$/.test(l)),
      s.printed.join('\n'),
    )
  })

  test('the sandbox check runs `return 1` in the real sandbox, and names the layers of this system', async () => {
    const s = setup({ mcpServers: {} })
    await s.doctor()
    const sandbox = s.of('sandbox')
    assert.match(sandbox.at(-1)!, /^ok {4}sandbox {2}a run of "return 1" returned 1 in \d+ ms$/)
    const network = sandbox.find(l => l.includes('network'))!
    assert.equal(network.startsWith('warn'), process.platform === 'win32', network)
    assert.match(s.of('node')[0]!, new RegExp(`^ok {4}node {5}this Node ${process.version}$`))
    assert.match(s.of('node')[1]!, /^ok {4}node {5}sandbox\.node .*: v\d+\.\d+\.\d+$/)
  })

  test('fails the node and sandbox checks when sandbox.node does not start', async () => {
    const s = setup({ mcpServers: {}, sandbox: { node: path.join(ROOT, 'no-such-node.exe') } })
    assert.equal(await s.doctor(), 1)
    assert.match(s.of('node')[1]!, /^fail {2}node {5}cannot run sandbox\.node /)
    assert.match(s.of('sandbox').at(-1)!, /^fail {2}sandbox {2}/)
  })

  test('servers that fail: the reason without secrets, no text of an untrusted server, and no unused-rule check', async () => {
    const s = setup({
      mcpServers: {
        demo: demoEntry,
        broken: exiting('console.error("bad token " + process.env.API_TOKEN); process.exit(3)', {
          env: { API_TOKEN: SECRET },
        }),
        sealed: exiting(`console.error(${JSON.stringify(SECRET)}); process.exit(3)`, { untrusted: true }),
      },
      policy: [{ match: 'mcp__demo__gone', action: 'allow' }],
    })
    assert.equal(await s.doctor(), 1)
    const servers = s.of('servers')
    assert.equal(servers[0], 'ok    servers  demo: connected, 2 tools')
    assert.match(servers[1]!, /^fail {2}servers {2}broken: cannot connect: .*Its stderr is not shown here/)
    assert.ok(!servers[1]!.includes('bad token'), servers[1])
    assert.equal(
      servers[2],
      'fail  servers  sealed (untrusted): cannot connect: the connect failed. doctor does not show its error text, because the text of this server is untrusted. When the client starts toolscript-mcp, its log holds the text',
    )
    assert.ok(!s.printed.join('\n').includes(SECRET))
    assert.deepEqual(s.of('policy'), [
      'ok    policy   1 rules',
      'info  policy   skipped the check for allow rules that match no tool, because a server did not connect',
    ])
  })

  test('a missing config fails with the init command, and the checks that need it skip', async () => {
    const s = setup(undefined)
    assert.equal(await s.doctor(), 1)
    assert.deepEqual(s.of('config'), [
      `fail  config   no config at ${s.config}. Run \`npx -y toolscript-mcp init --config ${s.config.replaceAll('\\', '/')}\` to write one from the MCP servers of your clients, or name the config with --config`,
    ])
    assert.deepEqual(s.of('servers'), ['info  servers  skipped, because the config did not load'])
    assert.deepEqual(s.of('policy'), ['info  policy   skipped, because the config did not load'])
    assert.match(s.of('sandbox').at(-1)!, /^ok {4}sandbox {2}a run of "return 1" returned 1/)
  })

  test('a config with errors fails with each error, as loadConfig reports them', async () => {
    const s = setup({ mcpServers: {}, sandbox: { nope: 1 } })
    assert.equal(await s.doctor(), 1)
    assert.deepEqual(s.of('config'), [
      `fail  config   the config ${s.config} has errors:`,
      'fail  config   sandbox.nope: unknown key (known: node, timeoutSeconds, callTimeoutSeconds)',
    ])
  })

  test('the newest run of the log: done is ok, done without a call is info, an error names the runs command', async () => {
    const run = (ending: RunRecord['ending'], ok: boolean, called = true): string =>
      runLine({
        time: '2026-01-02T03:04:05.000Z',
        id: 'r',
        ms: 12,
        ending,
        chars: 1,
        calls: called ? [{ tool: 'mcp__demo__list_pull_requests', decision: 'allow', ms: 3, ok }] : [],
      })
    const s = setup({ mcpServers: {} })
    await s.doctor()
    assert.deepEqual(s.of('run-log'), [`ok    run-log  on: ${runLogFile(s.home)}`, 'info  run-log  no run yet'])

    fs.mkdirSync(appPath(s.home), { recursive: true })
    fs.writeFileSync(runLogFile(s.home), run('done', true))
    s.printed.length = 0
    assert.equal(await s.doctor(), 0, s.printed.join('\n'))
    assert.equal(s.of('run-log')[1], 'ok    run-log  newest run: 2026-01-02T03:04:05.000Z done 12 ms')

    fs.appendFileSync(runLogFile(s.home), run('done', true, false))
    s.printed.length = 0
    await s.doctor()
    assert.equal(
      s.of('run-log')[1],
      'info  run-log  newest run: 2026-01-02T03:04:05.000Z done 12 ms. It called no tool',
    )

    fs.appendFileSync(runLogFile(s.home), 'not a run\n')
    s.printed.length = 0
    await s.doctor()
    assert.equal(
      s.of('run-log')[1],
      'info  run-log  newest run: 2026-01-02T03:04:05.000Z done 12 ms. It called no tool',
    )

    fs.appendFileSync(runLogFile(s.home), run('error', false))
    s.printed.length = 0
    assert.equal(await s.doctor(), 0, 'a failed run is a warning')
    assert.equal(
      s.of('run-log')[1],
      `warn  run-log  newest run: 2026-01-02T03:04:05.000Z error 12 ms. Run \`npx -y toolscript-mcp runs --config ${s.config.replaceAll('\\', '/')}\` to see its calls and the next step`,
    )
  })

  test('the newest run is the one that runs shows: a run dated more than 5 minutes ahead is skipped and counted', async () => {
    const run = (time: string, ending: RunRecord['ending']): string =>
      runLine({ time, id: 'r', ms: 12, ending, chars: 1, calls: [] })
    const s = setup({ mcpServers: {} })
    fs.mkdirSync(appPath(s.home), { recursive: true })
    const soon = new Date(Date.now() + 60_000).toISOString()
    fs.writeFileSync(
      runLogFile(s.home),
      run('2026-01-02T03:04:05.000Z', 'done') + run('2999-01-01T00:00:00.000Z', 'error'),
    )
    await s.doctor()
    assert.deepEqual(s.of('run-log').slice(1), [
      'info  run-log  newest run: 2026-01-02T03:04:05.000Z done 12 ms. It called no tool',
      'info  run-log  skipped runs dated more than 5 minutes after now: 1',
    ])

    // A clock a little ahead is no reason to skip a run.
    fs.appendFileSync(runLogFile(s.home), run(soon, 'done'))
    s.printed.length = 0
    await s.doctor()
    assert.equal(s.of('run-log')[1], `info  run-log  newest run: ${soon} done 12 ms. It called no tool`)

    fs.writeFileSync(runLogFile(s.home), run('2999-01-01T00:00:00.000Z', 'error'))
    s.printed.length = 0
    await s.doctor()
    assert.deepEqual(s.of('run-log').slice(1), [
      'info  run-log  no run yet',
      'info  run-log  skipped runs dated more than 5 minutes after now: 1',
    ])
  })

  test('a file where the folder of toolscript-mcp or HOME goes fails as not a folder', async () => {
    const s = setup({ mcpServers: {} })
    fs.writeFileSync(appPath(s.home), '')
    assert.equal(await s.doctor(), 1)
    assert.deepEqual(s.of('files'), [
      `fail  files    ${appPath(s.home)} is not a folder. Move the file, so toolscript-mcp can make the folder`,
    ])
    // POSIX reads a path under the file with ENOTDIR, Windows with ENOENT: both mean no OAuth store and no run log.
    assert.doesNotMatch(s.printed.join('\n'), /cannot read|ENOTDIR/)

    const home = path.join(s.dir, 'home-file')
    fs.writeFileSync(home, '')
    s.printed.length = 0
    await runDoctor(['--config', s.config], { ...s.io, home })
    assert.deepEqual(s.of('files'), [
      `fail  files    ${home} is not a folder, so toolscript-mcp cannot make ${appPath(home)}. Move the file`,
    ])
  })

  test('a HOME without the folder of toolscript-mcp passes, and doctor leaves no folder or file behind', async () => {
    const s = setup({ mcpServers: {} })
    const home = path.join(s.dir, 'new-home')
    const io = { ...s.io, home }
    s.printed.length = 0
    await runDoctor(['--config', s.config], io)
    assert.deepEqual(s.of('files'), [
      `ok    files    ${appPath(home)} does not exist yet, and toolscript-mcp can make it`,
    ])
    assert.equal(fs.existsSync(home), false)
  })

  test('doctor removes no folder that it did not make, also in a chain of empty folders', async () => {
    const s = setup({ mcpServers: {} })
    const chain = ['a', 'b', 'c', 'home'].map((_, i, names) => path.join(s.dir, 'empty', ...names.slice(0, i + 1)))
    const home = chain.at(-1)!
    fs.mkdirSync(home, { recursive: true })
    s.printed.length = 0
    await runDoctor(['--config', s.config], { ...s.io, home })
    assert.deepEqual(s.of('files'), [
      `ok    files    ${appPath(home)} does not exist yet, and toolscript-mcp can make it`,
    ])
    for (const dir of [path.join(s.dir, 'empty'), ...chain]) assert.ok(fs.existsSync(dir), `${dir} still exists`)
    assert.deepEqual(fs.readdirSync(home), [])
  })

  test('a store file of a server in the config is not stale', async () => {
    const s = setup({ mcpServers: { remote: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } })
    const used = storeFile(s.home, key('remote'), 'http://127.0.0.1:9/mcp')
    fs.mkdirSync(path.dirname(used), { recursive: true })
    fs.writeFileSync(used, '{}')
    await s.doctor()
    assert.deepEqual(s.of('files'), [`ok    files    ${appPath(s.home)} is writable`])
  })

  test('exits 2 on a usage error, and 0 with the usage for --help', async () => {
    const s = setup({ mcpServers: {} })
    assert.equal(await runDoctor(['--nope'], s.io), 2)
    assert.equal(await runDoctor(['extra'], s.io), 2)
    s.printed.length = 0
    assert.equal(await runDoctor(['--help'], s.io), 0)
    assert.deepEqual(s.printed, ['usage: toolscript-mcp doctor [--config <path>] [--help]'])
  })
})

describe('shareFindings', () => {
  const FAKE_ENV = 'fake-env-value-0123456789'
  const entries = {
    grafana: {
      command: 'docker',
      args: ['run', '--token', SECRET, 'mcp/grafana'],
      env: { TOKEN: FAKE_ENV },
      share: true,
    },
    azure: { command: 'node', args: ['/opt/fake/index.js'], env: { TOKEN: FAKE_ENV } },
    github: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'], cwd: '/work/app' },
    files: { command: 'npx', args: ['server-filesystem', '.'], share: 'folder' },
    'claude-code': { command: 'claude', args: ['mcp', 'serve'] },
    keeper: { command: 'node', args: ['x.js'], share: false },
    playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env: { TOKEN: FAKE_ENV } },
    atlassian: { type: 'http', url: 'https://mcp.example.com/mcp' },
  }
  const findings = (json: object, env: Record<string, string> = {}) => {
    const parsed = parseConfig(JSON.stringify(json), env, '/usr/bin/node', 'linux')
    assert.ok(parsed.ok)
    return shareFindings(parsed.config)
  }

  test('prints the switch, then one line per stdio server in config order, all info', () => {
    const found = findings({ mcpServers: entries })
    assert.ok(found.every(f => f.status === 'info'))
    assert.deepEqual(
      found.map(f => f.detail),
      [
        'sharing is off (the default)',
        'grafana: shared by all sessions: "share": true, so it starts in the home folder',
        'azure: one copy per folder: no cwd and no "share" key. Set "share": true when it reads no file of its folder',
        'github: shared by all sessions: it has a cwd',
        'files: one copy per folder: "share": "folder"',
        'claude-code: one copy per session: it is a Claude Code bridge',
        'keeper: one copy per session: "share": false',
        'playwright: one copy per session: it keeps state between calls (playwright). Set "share": true to share it',
      ],
    )
  })

  test('names the switch and its source', () => {
    const first = (json: object, env?: Record<string, string>) =>
      findings({ mcpServers: entries, ...json }, env)[0]!.detail
    const tail = ''
    assert.equal(first({ share: true }), 'sharing is on ("share": true)' + tail)
    assert.equal(first({ share: false }), 'sharing is off ("share": false)' + tail)
    assert.equal(first({}, { TOOLSCRIPT_SHARE: '1' }), 'sharing is on (TOOLSCRIPT_SHARE=1)' + tail)
    assert.equal(first({ share: true }, { TOOLSCRIPT_SHARE: '0' }), 'sharing is off (TOOLSCRIPT_SHARE=0)' + tail)
  })

  test('prints nothing without a stdio server', () => {
    assert.deepEqual(findings({ mcpServers: { atlassian: entries.atlassian } }), [])
    assert.deepEqual(findings({ mcpServers: {} }), [])
  })

  test('no line holds an argument, an env value or a path', () => {
    const all = JSON.stringify(findings({ mcpServers: entries, share: true }))
    for (const secret of [SECRET, FAKE_ENV, '/opt/fake', '/work/app', 'mcp/grafana'])
      assert.ok(!all.includes(secret), secret)
  })

  test('doctor prints the share lines after servers, and the exit code stays 0', async () => {
    const s = setup({ mcpServers: { demo: { ...demoEntry, share: true, env: { TOKEN: SECRET } } } })
    assert.equal(await s.doctor(), 0)
    assert.deepEqual(s.of('share'), [
      'info  share    sharing is off (the default)',
      'info  share    demo: shared by all sessions: "share": true, so it starts in the home folder',
    ])
    assert.ok(
      s.printed.findIndex(l => l.startsWith('info  share')) > s.printed.findIndex(l => l.slice(6, 13) === 'servers'),
    )
    assert.ok(!s.printed.join('\n').includes(SECRET))
  })
})

describe('the broker findings that need no IO', () => {
  test('a peer that is no broker gets the way out for a taken name, with no path but the broker folder', () => {
    for (const platform of ['win32', 'linux']) {
      const line = brokerFail('the shared-server broker is not usable: the peer did not prove the key. Run x', platform)
      assert.equal(line.status, 'fail')
      assert.match(line.detail, /delete the file "key" in the folder "broker" of the folder "\.toolscript-mcp"/)
      assert.match(
        line.detail,
        platform === 'win32' ? /new pipe name/ : /remove that folder, or use a shorter home path/,
      )
      assert.doesNotMatch(line.detail, /[A-Za-z]:\\|\/home\/|\/Users\//)
    }
    assert.equal(brokerFail('its key file is damaged', 'win32').detail, 'its key file is damaged')
  })

  test('the access rules: the user, SYSTEM and Administrators are fine, another principal warns, a bad read is info', () => {
    const me = 'S-1-5-21-1-2-3-1001'
    const rule = (sid: string, type = 'Allow') => `${sid}|${type}|FullControl`
    const fine = [me, rule(me), rule('S-1-5-18'), rule('S-1-5-32-544')].join('\r\n')
    assert.equal(aclFinding(fine).status, 'ok')
    const wide = [me, rule(me), rule('S-1-1-0'), rule('S-1-5-11')].join('\n')
    const warned = aclFinding(wide)
    assert.equal(warned.status, 'warn')
    assert.match(warned.detail, /2 other principal/)
    assert.match(warned.detail, /icacls/)
    assert.equal(
      aclFinding([me, rule(me), rule('S-1-1-0', 'Deny')].join('\n')).status,
      'ok',
      'a Deny rule widens nothing',
    )
    for (const bad of ['', 'garbage', `${me}\nnot a rule`]) assert.equal(aclFinding(bad).status, 'info', bad)
  })
})

describe('the broker check', () => {
  test('is silent with sharing off, and with no shared or per-folder server', async () => {
    const off = setup({ mcpServers: { demo: { ...demoEntry, share: true } } })
    await off.doctor()
    assert.deepEqual(off.of('broker'), [])
    const none = setup({ share: true, mcpServers: { demo: { ...demoEntry, share: false } } })
    await none.doctor()
    assert.deepEqual(none.of('broker'), [])
  })

  test('with sharing on and a shared server, a run from source fails with the reason and the ways out', async () => {
    const s = setup({ share: true, mcpServers: { demo: { ...demoEntry, share: true, env: { TOKEN: SECRET } } } })
    assert.equal(await s.doctor(), 1)
    const [line, ...more] = s.of('broker')
    assert.equal(more.length, 0)
    assert.match(
      line!,
      /^fail {2}broker {3}the shared-server broker is not usable: this run has no broker\.js beside it/,
    )
    assert.match(line!, /toolscript-mcp doctor/)
    assert.match(line!, /"share": false/)
    assert.match(line!, /TOOLSCRIPT_SHARE=0/)
    assert.ok(!s.printed.join('\n').includes(SECRET))
    assert.ok(!fs.existsSync(path.join(s.home, '.toolscript-mcp', 'broker')), 'no broker folder made')
  })
})
