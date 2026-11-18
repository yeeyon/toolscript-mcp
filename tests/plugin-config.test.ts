import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { parseConfig } from '../src/core/config.ts'

const SCRIPT = fileURLToPath(new URL('../plugin/skills/setup/config.mjs', import.meta.url))
const SECRETS = [
  'fake-secret-123',
  'fake-header-456',
  'fake-arg-789',
  'fake-q',
  '/fake-path',
  'fake-user',
  'fake-pass',
  'fake-oauth-id',
]

const FIXTURE = {
  mcpServers: {
    local: {
      command: '/usr/bin/fake-server',
      args: ['--key', 'fake-arg-789'],
      env: { TOKEN: 'fake-secret-123' },
    },
    remote: {
      type: 'http',
      url: 'https://fake-user:fake-pass@mcp.example.com/fake-path?token=fake-q',
      headers: { Authorization: 'Bearer fake-header-456' },
    },
    login: {
      type: 'http',
      url: 'https://login.example.com/mcp',
      oauth: { clientId: 'fake-oauth-id' },
    },
    open: { type: 'http', url: 'https://open.example.com/mcp' },
  },
  policy: [{ match: 'mcp__fake__*', action: 'allow' }],
  sandbox: { callTimeoutSeconds: 7 },
}

let dir: string
let n = 0

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-'))
})
after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(...args: string[]) {
  return runWith({}, ...args)
}

function runWith(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function makeConfig(content: string = JSON.stringify(FIXTURE, null, 2)): string {
  const file = path.join(dir, `config-${n++}.json`)
  fs.writeFileSync(file, content)
  return file
}

function makeEntry(value: unknown): string {
  const file = path.join(dir, `entry-${n++}.json`)
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

describe('plugin config helper', () => {
  it('shows the servers and the policy without a secret', () => {
    const { code, out } = run(makeConfig())
    assert.equal(code, 0)
    const lines = out.split('\n')
    assert.ok(lines.includes('local  stdio  fake-server'))
    assert.ok(lines.includes('remote  http  https://mcp.example.com'))
    assert.ok(lines.includes('login  http  https://login.example.com  oauth'))
    assert.ok(lines.includes('open  http  https://open.example.com  oauth'))
    assert.ok(lines.includes('policy:'))
    assert.ok(lines.includes('{"match":"mcp__fake__*","action":"allow"}'))
    for (const secret of SECRETS) assert.ok(!out.includes(secret), secret)
  })

  it('says when the policy is empty', () => {
    const file = makeConfig(JSON.stringify({ mcpServers: {} }))
    assert.match(run(file).out, /policy: empty, so each tool is ask/)
  })

  it('writes the policy in order and keeps the other keys', () => {
    const file = makeConfig()
    const { code, out } = run(file, 'policy', 'deny', 'mcp__fake__delete*', 'allow', 'mcp__fake__*')
    assert.equal(code, 0)
    assert.ok(out.includes('{"match":"mcp__fake__delete*","action":"deny"}\n{"match":"mcp__fake__*","action":"allow"}'))
    const saved = JSON.parse(read(file))
    assert.deepEqual(saved.policy, [
      { match: 'mcp__fake__delete*', action: 'deny' },
      { match: 'mcp__fake__*', action: 'allow' },
    ])
    assert.deepEqual(saved.mcpServers, FIXTURE.mcpServers)
    assert.deepEqual(saved.sandbox, FIXTURE.sandbox)
    assert.ok(read(file).endsWith('}\n'))
  })

  it('puts new rules first and keeps the other rules after them', () => {
    const file = makeConfig(
      JSON.stringify({
        ...FIXTURE,
        policy: [
          { match: 'mcp__fake__*', action: 'allow' },
          { match: 'mcp__cc__Bash', action: 'allow' },
          { match: '*', action: 'allow' },
        ],
      }),
    )
    const rules = ['allow', 'mcp__cc__Read', 'ask', 'mcp__cc__Bash', 'deny', 'mcp__cc__*']
    const expected = [
      { match: 'mcp__cc__Read', action: 'allow' },
      { match: 'mcp__cc__Bash', action: 'ask' },
      { match: 'mcp__cc__*', action: 'deny' },
      { match: 'mcp__fake__*', action: 'allow' },
      { match: '*', action: 'allow' },
    ]
    for (let round = 0; round < 2; round++) {
      const { code, out } = run(file, 'prepend', ...rules)
      assert.equal(code, 0)
      assert.ok(out.includes('{"match":"mcp__cc__*","action":"deny"}\n{"match":"mcp__fake__*","action":"allow"}'))
      const saved = JSON.parse(read(file))
      assert.deepEqual(saved.policy, expected)
      assert.deepEqual(saved.mcpServers, FIXTURE.mcpServers)
      assert.deepEqual(saved.sandbox, FIXTURE.sandbox)
    }
  })

  it('refuses prepend with no pairs or a bad rule and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    assert.equal(run(file, 'prepend').code, 2)
    assert.equal(run(file, 'prepend', 'permit', 'mcp__fake__x').code, 2)
    assert.equal(run(file, 'prepend', 'allow', 'fake__x').code, 2)
    assert.equal(read(file), before)
  })

  it('empties the policy with no pairs', () => {
    const file = makeConfig()
    assert.equal(run(file, 'policy').code, 0)
    assert.deepEqual(JSON.parse(read(file)).policy, [])
  })

  it('refuses a bad action and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    const { code, err } = run(file, 'policy', 'allow', 'mcp__fake__*', 'permit', 'mcp__fake__x')
    assert.equal(code, 2)
    assert.match(err, /allow, deny or ask/)
    assert.equal(read(file), before)
  })

  it('adds a server and shows it', () => {
    const file = makeConfig()
    const entry = makeEntry({ command: 'node', args: ['fake.js'], env: { K: 'fake-secret-123' } })
    const { code, out } = run(file, 'add', 'extra_one', entry)
    assert.equal(code, 0)
    assert.ok(out.includes('extra_one  stdio  node'))
    assert.ok(!out.includes('fake-secret-123'))
    const saved = JSON.parse(read(file))
    assert.equal(saved.mcpServers.extra_one.env.K, 'fake-secret-123')
    assert.deepEqual(saved.policy, FIXTURE.policy)
    assert.equal(Object.keys(saved.mcpServers).length, 5)
  })

  it('refuses a duplicate name, a bad name and a bad entry', () => {
    const file = makeConfig()
    const before = read(file)
    const good = makeEntry({ command: 'node' })
    assert.equal(run(file, 'add', 'local', good).code, 1)
    assert.equal(run(file, 'add', 'bad name', good).code, 1)
    assert.equal(run(file, 'add', 'bad__name', good).code, 1)
    assert.equal(run(file, 'add', 'fresh', makeEntry({ type: 'http' })).code, 1)
    assert.equal(run(file, 'add', 'fresh', makeEntry(['node'])).code, 1)
    assert.equal(run(file, 'add', 'fresh', makeEntry({ command: 5 })).code, 1)
    assert.equal(read(file), before)
  })

  it('refuses a config that is not valid JSON and leaves it as it was', () => {
    const file = makeConfig('{ not json')
    for (const args of [[], ['policy', 'allow', 'mcp__fake__*'], ['add', 'fresh', makeEntry({ command: 'node' })]]) {
      const { code } = run(file, ...args)
      assert.equal(code, 1)
      assert.equal(read(file), '{ not json')
    }
  })

  it('hides a command with arguments in it and a URL from a variable', () => {
    const file = makeConfig(
      JSON.stringify({
        mcpServers: {
          inline: { command: 'npx -y fake-server --api-key fake-secret-123' },
          fromvar: { type: 'http', url: '${FAKE_URL}' },
        },
      }),
    )
    const { code, out } = run(file)
    assert.equal(code, 0)
    assert.ok(out.split('\n').includes('inline  stdio'))
    assert.ok(out.includes('fromvar  http  url-from-a-variable  oauth'))
    assert.ok(!out.includes('fake-secret-123'))
  })

  it('refuses a match that the server rejects and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    for (const match of ['fake__*', '']) {
      const { code, err } = run(file, 'policy', 'allow', match)
      assert.equal(code, 2)
      assert.match(err, /starts with mcp__ or \*/)
    }
    assert.equal(read(file), before)
  })

  it('makes the config and its folder when add finds no config', () => {
    const file = path.join(dir, `new-${n++}`, 'config.json')
    const { code, out } = run(file, 'add', 'fake', makeEntry({ command: 'node' }))
    assert.equal(code, 0)
    assert.ok(out.includes('fake  stdio  node'))
    assert.deepEqual(JSON.parse(read(file)), { mcpServers: { fake: { command: 'node' } }, policy: [] })
  })

  it('sets and removes "untrusted": true on a server, shows it, and keeps the rest', () => {
    const file = makeConfig()
    for (const [args, value, line] of [
      [['remote'], true, 'remote  http  https://mcp.example.com  untrusted'],
      [['remote', 'true'], true, 'remote  http  https://mcp.example.com  untrusted'],
      [['remote', 'false'], undefined, 'remote  http  https://mcp.example.com'],
      [['local', 'true'], true, 'local  stdio  fake-server  untrusted'],
    ] as const) {
      const { code, out } = run(file, 'untrusted', ...args)
      assert.equal(code, 0)
      assert.ok(out.split('\n').includes(line), out)
      for (const secret of SECRETS) assert.ok(!out.includes(secret), secret)
      const saved = JSON.parse(read(file))
      assert.equal(saved.mcpServers[args[0]].untrusted, value)
      const { untrusted: _, ...rest } = saved.mcpServers[args[0]]
      assert.deepEqual(rest, FIXTURE.mcpServers[args[0]])
      assert.deepEqual(saved.policy, FIXTURE.policy)
    }
  })

  it('refuses untrusted for a missing server or a bad value and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    assert.equal(run(file, 'untrusted', 'missing').code, 1)
    assert.equal(run(file, 'untrusted', 'remote', 'yes').code, 2)
    assert.equal(run(file, 'untrusted').code, 2)
    assert.equal(run(file, 'untrusted', 'remote', 'true', 'more').code, 2)
    assert.equal(read(file), before)
  })

  // The review of #47: step 7 runs prepend before add, and prepend failed with ENOENT on a new config.
  it('makes the config when policy or prepend finds no config, as step 7 runs them before add', () => {
    for (const command of ['policy', 'prepend']) {
      const file = path.join(dir, `new-${n++}`, 'config.json')
      assert.equal(run(file, command, 'allow', 'mcp__cc__Read', 'deny', 'mcp__cc__*').code, 0)
      const policy = [
        { match: 'mcp__cc__Read', action: 'allow' },
        { match: 'mcp__cc__*', action: 'deny' },
      ]
      assert.deepEqual(JSON.parse(read(file)), { mcpServers: {}, policy })
      assert.equal(run(file, 'add', 'cc', makeEntry({ command: 'claude', args: ['mcp', 'serve'] })).code, 0)
      const parsed = parseConfig(read(file), {}, process.execPath, process.platform)
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
    }
  })

  it('fails on a config that it cannot read for another reason than a missing file', () => {
    const folder = fs.mkdtempSync(path.join(dir, 'folder-'))
    for (const command of ['policy', 'prepend', 'add', 'untrusted']) {
      const args =
        command === 'add'
          ? ['fake', makeEntry({ command: 'node' })]
          : command === 'untrusted'
            ? ['fake']
            : ['allow', 'mcp__fake__*']
      const { code, err } = run(folder, command, ...args)
      assert.equal(code, 1, command)
      assert.match(err, /^Cannot read the config /, command)
    }
    assert.deepEqual(fs.readdirSync(folder), [])
  })

  // The review of #47: prepend kept an old entry that the server refuses, and the server then did not start.
  it('refuses prepend over an old policy that the server refuses, and leaves the file as it was', () => {
    const bad = [
      [{ match: 'fake__*', action: 'allow' }],
      [{ match: 'mcp__fake__*', action: 'permit' }],
      [{ match: 'mcp__fake__*', action: 'allow', why: 'x' }],
      [{ match: 'mcp__fake__*', action: 'allow' }, 'mcp__fake__x'],
      [null],
      { 'mcp__fake__*': 'allow' },
    ]
    for (const policy of bad) {
      const file = makeConfig(JSON.stringify({ ...FIXTURE, policy }))
      assert.equal(parseConfig(read(file), {}, process.execPath, process.platform).ok, false)
      const before = read(file)
      const { code, err } = run(file, 'prepend', 'deny', 'mcp__cc__*')
      assert.equal(code, 1, JSON.stringify(policy))
      assert.match(err, /config\.mjs wrote nothing\.$/m, JSON.stringify(policy))
      assert.equal(read(file), before)
      assert.equal(run(file, 'policy', 'deny', 'mcp__cc__*').code, 0, 'the policy command replaces a bad policy')
      assert.deepEqual(JSON.parse(read(file)).policy, [{ match: 'mcp__cc__*', action: 'deny' }])
    }
  })

  it('prints the default config path', () => {
    assert.equal(runWith({ TOOLSCRIPT_CONFIG: 'C:/fake/config.json' }, 'path').out.trim(), 'C:/fake/config.json')
    const base = process.platform === 'win32' ? { APPDATA: dir } : { XDG_CONFIG_HOME: dir }
    const { code, out } = runWith({ TOOLSCRIPT_CONFIG: '', ...base }, 'path')
    assert.equal(code, 0)
    assert.equal(out.trim(), path.join(dir, 'toolscript-mcp', 'config.json').replaceAll('\\', '/'))
  })

  it('exits 1 for a missing config and 2 for a usage error', () => {
    assert.equal(run(path.join(dir, 'missing.json')).code, 1)
    const absent = path.join(dir, 'absent', 'config.json')
    assert.equal(run(absent, 'untrusted', 'remote').code, 1)
    assert.equal(fs.existsSync(absent), false)
    assert.equal(run(makeConfig(), 'policy', 'allow').code, 2)
    assert.equal(run(makeConfig(), 'unknown').code, 2)
  })
})
