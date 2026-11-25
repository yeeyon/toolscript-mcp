import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { parseConfig } from '../src/core/config.ts'
import { BUILT_IN_NAMES, LIMITS, rootProblem as coreRootProblem } from '../src/core/workspace.ts'
import { TASK_LIMITS, TASK_NAME, commandProblem as coreCommandProblem } from '../src/core/task.ts'
import * as roots from '../plugin/skills/setup/roots.mjs'

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

  it('labels an entry with sigv4 as sigv4 and never as oauth, with no profile or region', () => {
    const url = 'https://aws-mcp.us-east-1.api.aws/mcp'
    const file = makeConfig(
      JSON.stringify({
        mcpServers: {
          a: { type: 'http', url, sigv4: { profile: 'fakeprofile' } },
          b: { type: 'http', url, sigv4: { profile: 'fakeprofile', region: 'us-east-1', service: 'aws-mcp' } },
          c: { type: 'http', url, headers: { 'X-Fake': 'fake-h' }, sigv4: { profile: 'fakeprofile' } },
          d: { type: 'http', url, oauth: true, sigv4: { profile: 'fakeprofile' } },
          e: { type: 'http', url, sigv4: 'fake-text' },
        },
      }),
    )
    const { code, out } = run(file)
    assert.equal(code, 0)
    const lines = out.split('\n')
    for (const name of ['a', 'b', 'c', 'd'])
      assert.ok(lines.includes(`${name}  http  https://aws-mcp.us-east-1.api.aws  sigv4`), name)
    for (const secret of ['fakeprofile', 'fake-h', 'fake-text', '/mcp']) assert.ok(!out.includes(secret), secret)
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

  it('sets "share": true on a server, removes the key with false, and prints no secret', () => {
    const file = makeConfig()
    for (const [args, value] of [
      [['local'], true],
      [['local', 'false'], undefined],
      [['remote', 'true'], true],
    ] as const) {
      const { code, out } = run(file, 'share', ...args)
      assert.equal(code, 0)
      for (const secret of SECRETS) assert.ok(!out.includes(secret), secret)
      const saved = JSON.parse(read(file))
      assert.equal(saved.mcpServers[args[0]].share, value)
      const { share: _, ...rest } = saved.mcpServers[args[0]]
      assert.deepEqual(rest, FIXTURE.mcpServers[args[0]])
      assert.deepEqual(saved.policy, FIXTURE.policy)
    }
    const before = read(file)
    assert.equal(run(file, 'share', 'missing').code, 1)
    assert.equal(run(file, 'share', 'local', 'yes').code, 2)
    assert.equal(run(file, 'share').code, 2)
    assert.equal(run(file, 'share', 'local', 'true', 'more').code, 2)
    assert.equal(read(file), before)
  })

  it('keeps the share keys, at the top level and on a server', () => {
    const shared = {
      ...FIXTURE,
      share: true,
      mcpServers: { ...FIXTURE.mcpServers, local: { ...FIXTURE.mcpServers.local, share: 'folder' } },
    }
    const file = makeConfig(JSON.stringify(shared))
    assert.equal(run(file, 'untrusted', 'local', 'true').code, 0)
    const saved = JSON.parse(read(file))
    assert.equal(saved.share, true)
    assert.equal(saved.mcpServers.local.share, 'folder')
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

  it('has no allow-tools command: toolscript-mcp allow does it', () => {
    const file = makeConfig()
    const before = read(file)
    assert.equal(run(file, 'allow-tools', 'mcp__gh__get').code, 2)
    assert.equal(read(file), before)
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

describe('the plugin copy of the root rules', () => {
  const names = BUILT_IN_NAMES.map(name => name.replaceAll('*', 'x').replaceAll('?', 'x'))
  const rows: [string, string][] = [
    ['/', '/home/me'],
    ['C:\\', 'C:\\Users\\me'],
    ['C:', 'C:\\Users\\me'],
    ['/home/me', '/home/me'],
    ['/home', '/home/me'],
    ['C:\\Users', 'C:\\Users\\me'],
    ['/home/me/app/.git/modules', '/home/me'],
    ['C:\\Users\\me\\.ssh', 'C:\\Users\\me'],
    ['\\\\server\\share\\app', 'C:\\Users\\me'],
    ['//server/share/x', 'C:\\Users\\me'],
    ['/home/me/app', '/home/me'],
    ['C:\\work\\app', 'C:\\Users\\me'],
    ['/home/me/projects\\app', '/home/me/projects/app'],
    ['/home/me/projects', '/home/me/projects/app'],
    ['/home/me/app/.GIT', '/home/me'],
    ['C:\\USERS\\Me', 'C:\\Users\\me'],
    ['/Users/ME', '/Users/me'],
    ['/home/Zo\u00e9', '/home/Zoe\u0301'],
    ['/home/Zoe\u0301', '/home/Zo\u00e9'],
    ['/home/me/.E\u006e\u0076', '/home/me'],
    ...names.flatMap((name): [string, string][] => [
      [`/home/me/${name}/x`, '/home/me'],
      [`C:\\work\\${name}`, 'C:\\Users\\me'],
      [`/work/${name.toUpperCase()}`, '/home/me'],
    ]),
  ]

  it('has the same names and the same limit as the core', () => {
    assert.deepEqual(roots.BUILT_IN_NAMES, [...BUILT_IN_NAMES])
    assert.equal(roots.ROOTS_MAX, LIMITS.roots)
    assert.equal(roots.TASK_NAME.source, TASK_NAME.source)
    assert.equal(roots.TASKS_MAX, TASK_LIMITS.tasks)
  })

  it('gives the same answer as the core on each command text', () => {
    const commands = [
      'node',
      './gradlew',
      'sub/x',
      'a\\b',
      '/usr/bin/node',
      'C:\\x\\node.exe',
      'C:/x/node',
      'C:node',
      '\\\\s\\x',
      '//s/x',
      'a\u0007b',
    ]
    for (const windows of [true, false])
      for (const command of commands)
        assert.equal(
          roots.commandProblem(command, windows),
          coreCommandProblem(command, windows),
          `${windows} ${command}`,
        )
  })

  it('has the task keys of parseTasks: each key is taken, any other is refused', () => {
    const parse = (task: unknown) =>
      parseConfig(
        JSON.stringify({ mcpServers: {}, workspace: { roots: [{ path: '/work/app', tasks: { t: task } }] } }),
        {},
        process.execPath,
        'linux',
      )
    const all = { command: 'node', args: ['a'], cwd: '.', timeoutSeconds: 5, env: { K: 'v' } }
    assert.deepEqual(Object.keys(all), roots.TASK_KEYS)
    for (const key of roots.TASK_KEYS) {
      const one = parse({ command: 'node', [key]: (all as Record<string, unknown>)[key] })
      assert.equal(one.ok && one.config.workspace !== undefined, true, key)
    }
    const extra = parse({ ...all, shell: true })
    assert.equal(extra.ok && extra.config.workspace === undefined, true)
  })

  it('gives the same answer as the core on every row, reason text included', () => {
    for (const platform of ['linux', 'darwin', 'win32'])
      for (const [real, home] of rows)
        assert.equal(
          roots.rootProblem(real, home, platform),
          coreRootProblem(real, home, platform),
          `${platform} ${JSON.stringify([real, home])}`,
        )
  })
})

describe('plugin config helper: workspace', () => {
  const FIXED = ['mcpServers', 'policy', 'sandbox', 'share']
  let home: string
  before(() => {
    home = fs.mkdtempSync(path.join(dir, 'home-'))
  })

  const ws = (...args: string[]) => runWith({ HOME: home, USERPROFILE: home }, ...args)
  const folder = (name: string) => {
    const made = path.join(dir, 'work', `${n++}-${name}`)
    fs.mkdirSync(made, { recursive: true })
    return made
  }
  const slash = (text: string) => text.replaceAll('\\', '/')
  const real = (text: string) => slash(fs.realpathSync.native(text))
  const section = (file: string) => JSON.parse(read(file)).workspace
  const valid = (file: string) => {
    const parsed = parseConfig(read(file), {}, process.execPath, process.platform)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
    const entry = parsed.config.servers.get('workspace')
    assert.ok(parsed.config.workspace !== undefined, JSON.stringify(entry))
  }
  const taskFile = (value: unknown) => makeEntry(value)
  const TASK = {
    command: 'fake-cmd-secret',
    args: ['fake-arg-789'],
    env: { TOKEN: 'fake-secret-123' },
    cwd: 'fake-dir',
  }

  it('adds a root under its real path, makes the config, and the file passes parseConfig', () => {
    const file = path.join(dir, `new-${n++}`, 'config.json')
    const app = folder('app')
    const { code, out } = ws(file, 'workspace', 'add', app)
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(read(file)), {
      mcpServers: {},
      policy: [],
      workspace: { roots: [{ path: real(app) }] },
    })
    assert.equal(out.trim(), `${JSON.stringify(real(app))}  read-only`)
    valid(file)
  })

  it('stores a path with spaces whole, and remove finds it with the same text', () => {
    const file = makeConfig()
    const app = folder('my app')
    assert.equal(ws(file, 'workspace', 'add', app).code, 0)
    assert.equal(section(file).roots[0].path, real(app))
    assert.equal(ws(file, 'workspace', 'remove', app).code, 0)
    assert.equal(section(file), undefined)
  })

  it('converges: the same folder again, with a trailing separator, or in another case, changes nothing', () => {
    const file = makeConfig()
    const app = folder('app')
    assert.equal(ws(file, 'workspace', 'add', app).code, 0)
    const before = read(file)
    const variants = [app, `${app}/`, `${app}${path.sep}`]
    if (process.platform === 'win32' || process.platform === 'darwin') variants.push(app.toUpperCase())
    for (const variant of variants) {
      const { code, out } = ws(file, 'workspace', 'add', variant)
      assert.equal(code, 0, variant)
      assert.equal(out.trim(), 'already a root')
      assert.equal(read(file), before)
    }
  })

  it('adds a folder inside a root and a folder that holds a root, with one note each', () => {
    const file = makeConfig()
    const outer = folder('outer')
    const inner = path.join(outer, 'inner')
    fs.mkdirSync(inner)
    assert.equal(ws(file, 'workspace', 'add', outer).code, 0)
    const inside = ws(file, 'workspace', 'add', inner)
    assert.equal(inside.code, 0)
    assert.match(inside.out, /^Note: the new root is inside a root that exists\./)
    const other = makeConfig()
    assert.equal(ws(other, 'workspace', 'add', inner).code, 0)
    const holds = ws(other, 'workspace', 'add', outer)
    assert.equal(holds.code, 0)
    assert.match(holds.out, /^Note: the new root holds a root that exists\./)
    valid(file)
    valid(other)
  })

  it('keeps every other key and the entries of the section', () => {
    const first = folder('first')
    const extra = { exclude: ['*.sqlite'], skip: ['tmp'] }
    const file = makeConfig(
      JSON.stringify({ ...FIXTURE, share: true, workspace: { ...extra, roots: [{ path: real(first), write: true }] } }),
    )
    assert.equal(ws(file, 'workspace', 'add', folder('second')).code, 0)
    const saved = JSON.parse(read(file))
    for (const key of FIXED)
      assert.deepEqual(saved[key], key === 'share' ? true : (FIXTURE as Record<string, unknown>)[key])
    assert.deepEqual(saved.workspace.roots[0], { path: real(first), write: true })
    assert.equal(saved.workspace.roots.length, 2)
    assert.deepEqual({ exclude: saved.workspace.exclude, skip: saved.workspace.skip }, extra)
    valid(file)
  })

  it('refuses a folder that the core refuses, a missing one and a bad one, with the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    const file2 = path.join(dir, `a-file-${n++}`)
    fs.writeFileSync(file2, 'x')
    const gitPart = folder('g')
    const hidden = path.join(gitPart, '.git')
    fs.mkdirSync(hidden)
    const holder = path.dirname(home)
    const cases: [string, RegExp][] = [
      [home, /The folder is refused: it is your home folder or holds it\. config\.mjs wrote nothing\.$/],
      [holder, /holds it/],
      [hidden, /The folder is refused: a part of its path has a name that Workspace never opens/],
      [file2, /not a folder/],
      [path.join(dir, 'missing-folder'), /does not exist/],
      ['relative/app', /absolute path/],
      ['${HOME}/app', /absolute path/],
    ]
    if (process.platform === 'win32') cases.push([path.parse(dir).root, /drive or file system root/])
    else cases.push(['/', /drive or file system root/])
    for (const [text, pattern] of cases) {
      const { code, err } = ws(file, 'workspace', 'add', text)
      assert.equal(code, 1, text)
      assert.match(err.trim(), pattern, text)
      assert.match(err.trim(), /config\.mjs wrote nothing\.$/, text)
      assert.equal(read(file), before)
    }
  })

  it('refuses a section that it cannot add to, and a server named workspace, with the file as it was', () => {
    const app = folder('app')
    const bad: [unknown, RegExp][] = [
      [{ ...FIXTURE, mcpServers: { workspace: { command: 'node' } } }, /key workspace/],
      [{ ...FIXTURE, workspace: [] }, /key workspace must be an object/],
      [{ ...FIXTURE, workspace: { roots: {} } }, /workspace\.roots must be an array/],
      [{ ...FIXTURE, workspace: { roots: ['/x'] } }, /workspace\.roots\[0\] must be an object/],
      [{ ...FIXTURE, workspace: { roots: [{ path: 5 }] } }, /string "path"/],
    ]
    for (const [config, pattern] of bad) {
      const file = makeConfig(JSON.stringify(config))
      const before = read(file)
      const { code, err } = ws(file, 'workspace', 'add', app)
      assert.equal(code, 1, JSON.stringify(config))
      assert.match(err, pattern)
      assert.equal(read(file), before)
    }
  })

  it('refuses the 17th root, and still answers "already a root" at 16', () => {
    const paths = Array.from({ length: 16 }, (_, i) => real(folder(`r${i}`)))
    const file = makeConfig(JSON.stringify({ workspace: { roots: paths.map(p => ({ path: p })) } }))
    const before = read(file)
    const { code, err } = ws(file, 'workspace', 'add', folder('seventeen'))
    assert.equal(code, 1)
    assert.match(err, /16/)
    assert.equal(read(file), before)
    assert.equal(ws(file, 'workspace', 'add', paths[3]!).out.trim(), 'already a root')
    assert.equal(read(file), before)
  })

  it('prints off for no section, and lists roots, grants, task names and counts only', () => {
    const file = makeConfig()
    assert.equal(ws(file, 'workspace').out.trim(), 'workspace: off')
    const app = real(folder('app'))
    const config = {
      ...FIXTURE,
      workspace: {
        roots: [{ path: app, write: true, tasks: { test: TASK, Bad: TASK, Worse: TASK } }, { path: '${FAKE_ROOT}' }],
        exclude: ['fake-glob-1', 'fake-glob-2'],
        skip: ['fake-skip'],
      },
    }
    const shown = makeConfig(JSON.stringify(config))
    const { code, out } = ws(shown, 'workspace')
    assert.equal(code, 0)
    assert.deepEqual(out.trim().split('\n'), [
      `${JSON.stringify(app)}  write  tasks: test, 2 invalid names`,
      '"${FAKE_ROOT}"  read-only',
      'exclude: 2 globs',
      'skip: 1 name',
    ])
    for (const text of [...SECRETS, 'fake-cmd-secret', 'fake-dir', 'fake-glob', 'fake-skip', 'Bad'])
      assert.ok(!out.includes(text), text)
  })

  it('removes a root with its grant and tasks, and the whole section with the last root', () => {
    const a = real(folder('a'))
    const b = real(folder('b'))
    const file = makeConfig(
      JSON.stringify({
        ...FIXTURE,
        workspace: { roots: [{ path: a, write: true, tasks: { test: TASK } }, { path: b }], exclude: ['*.x'] },
      }),
    )
    assert.equal(ws(file, 'workspace', 'remove', a).code, 0)
    assert.deepEqual(section(file), { roots: [{ path: b }], exclude: ['*.x'] })
    const { code, out } = ws(file, 'workspace', 'remove', b)
    assert.equal(code, 0)
    assert.equal(out.trim(), 'workspace: off')
    const saved = JSON.parse(read(file))
    assert.equal(saved.workspace, undefined)
    assert.deepEqual(saved.mcpServers, FIXTURE.mcpServers)
    assert.deepEqual(saved.policy, FIXTURE.policy)
  })

  it('removes a root whose folder is gone, found by its text', () => {
    const file = makeConfig(
      JSON.stringify({ workspace: { roots: [{ path: 'C:/gone/App' }, { path: '${FAKE_ROOT}/x' }] } }),
    )
    // On Windows \ separates parts. Elsewhere it is a letter of a name, so the same text finds no root.
    const gone = process.platform === 'win32' ? 'C:\\gone\\App' : 'C:/gone/App'
    assert.equal(ws(file, 'workspace', 'remove', gone).code, 0)
    assert.equal(ws(file, 'workspace', 'remove', '${FAKE_ROOT}/x').code, 0)
    assert.equal(section(file), undefined)
  })

  it(
    'reads \\ as a letter of a name outside Windows, so a backslash text finds no root',
    { skip: process.platform === 'win32' },
    () => {
      const file = makeConfig(JSON.stringify({ workspace: { roots: [{ path: 'C:/gone/App' }] } }))
      const before = read(file)
      assert.equal(ws(file, 'workspace', 'remove', 'C:\\gone\\App').code, 1)
      assert.equal(read(file), before)
    },
  )

  it('sets and unsets the write grant and keeps the rest of the entry', () => {
    const app = real(folder('app'))
    const entry = { path: app, tasks: { test: TASK } }
    const file = makeConfig(JSON.stringify({ mcpServers: {}, workspace: { roots: [entry] } }))
    for (const args of [[app], [app, 'true']]) {
      assert.equal(ws(file, 'workspace', 'write', ...args).code, 0)
      assert.deepEqual(section(file).roots[0], { ...entry, write: true })
    }
    const { out } = ws(file, 'workspace', 'write', app, 'false')
    assert.deepEqual(section(file).roots[0], entry)
    assert.match(out, /read-only {2}tasks: test/)
    valid(file)
  })

  it('sets a task, replaces it with a line that says so, and prints no command, argument or variable', () => {
    const app = real(folder('app'))
    const file = makeConfig(JSON.stringify({ ...FIXTURE, workspace: { roots: [{ path: app }] } }))
    const first = ws(file, 'workspace', 'task', app, 'test', taskFile(TASK))
    assert.equal(first.code, 0, first.err)
    assert.match(first.out, /^Set the task "test"\./)
    assert.deepEqual(section(file).roots[0].tasks.test, TASK)
    const other = { command: 'node', args: ['--test'], timeoutSeconds: 5 }
    const second = ws(file, 'workspace', 'task', app, 'test', taskFile({ ...other, env: { K: 'fake-header-456' } }))
    assert.match(second.out, /^Replaced the task "test"\./)
    assert.equal(section(file).roots[0].tasks.test.command, 'node')
    for (const out of [first.out, second.out]) {
      for (const text of [...SECRETS, 'fake-cmd-secret', 'fake-dir', '--test', 'timeoutSeconds'])
        assert.ok(!out.includes(text), text)
    }
    assert.deepEqual(JSON.parse(read(file)).mcpServers, FIXTURE.mcpServers)
    valid(file)
  })

  it('refuses a bad task file, name or count, with the file as it was', () => {
    const app = real(folder('app'))
    const tasks = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`t${i}`, { command: 'node' }]))
    const file = makeConfig(JSON.stringify({ workspace: { roots: [{ path: app, tasks }] } }))
    const before = read(file)
    const notJson = path.join(dir, `not-json-${n++}`)
    fs.writeFileSync(notJson, '{ no')
    const cases: [string, string][] = [
      ['t0', taskFile({ command: 5 })],
      ['t0', taskFile({ command: '' })],
      ['t0', taskFile({ command: 'node', shell: true })],
      ['t0', taskFile({ command: 'node', args: [1] })],
      ['t0', taskFile({ command: 'node', args: 'x' })],
      ['t0', taskFile(['node'])],
      ['t0', notJson],
      ['t0', path.join(dir, 'no-such-task.json')],
      ['Test!', taskFile({ command: 'node' })],
      ['x'.repeat(33), taskFile({ command: 'node' })],
      ['t33', taskFile({ command: 'node' })],
    ]
    for (const [name, task] of cases) {
      const { code } = ws(file, 'workspace', 'task', app, name, task)
      assert.equal(code, 1, name)
      assert.equal(read(file), before)
    }
    assert.equal(ws(file, 'workspace', 'task', app, 't0', taskFile({ command: 'node', args: ['a'] })).code, 0)
  })

  // The review of #156: a task that parseConfig refuses turns the whole section off, the new root included.
  it('refuses a task that turns the section off, and accepts a full path that parseConfig takes', () => {
    const app = real(folder('app'))
    const file = makeConfig(
      JSON.stringify({ mcpServers: {}, sandbox: { callTimeoutSeconds: 10 }, workspace: { roots: [{ path: app }] } }),
    )
    const before = read(file)
    const bad: unknown[] = [
      { command: './gradlew' },
      { command: 'tools\\gradle' },
      { command: 'sub/gradle' },
      { command: 'no\u0007bell' },
      { command: 'node', timeoutSeconds: 11 },
      { command: 'node', timeoutSeconds: 0 },
      { command: 'node', timeoutSeconds: 1.5 },
      { command: 'node', timeoutSeconds: '5' },
    ]
    for (const task of bad) {
      const { code, err } = ws(file, 'workspace', 'task', app, 'test', taskFile(task))
      assert.equal(code, 1, JSON.stringify(task))
      assert.match(err, /config\.mjs wrote nothing\.$/m)
      assert.equal(read(file), before)
    }
    const good = { command: slash(process.execPath), args: ['--test'], timeoutSeconds: 10 }
    assert.equal(ws(file, 'workspace', 'task', app, 'test', taskFile(good)).code, 0)
    valid(file)
    const parsed = parseConfig(read(file), {}, process.execPath, process.platform)
    assert.ok(parsed.ok && parsed.config.workspace?.roots[0]?.tasks?.length === 1)
  })

  it('fails on a missing config for every command but add, and makes no file', () => {
    const absent = path.join(dir, `absent-${n++}`, 'config.json')
    const app = folder('app')
    const task = taskFile({ command: 'node' })
    for (const args of [[], ['remove', app], ['write', app], ['task', app, 'test', task]]) {
      assert.equal(ws(absent, 'workspace', ...args).code, 1, args.join(' '))
    }
    assert.equal(fs.existsSync(path.dirname(absent)), false)
  })

  it('fails with no section or an unknown root, with the file as it was', () => {
    const app = folder('app')
    const file = makeConfig()
    const before = read(file)
    for (const args of [
      ['remove', app],
      ['write', app],
      ['task', app, 'test', taskFile({ command: 'node' })],
    ])
      assert.equal(ws(file, 'workspace', ...args).code, 1)
    const withRoot = makeConfig(JSON.stringify({ workspace: { roots: [{ path: real(folder('other')) }] } }))
    const before2 = read(withRoot)
    assert.equal(ws(withRoot, 'workspace', 'remove', app).code, 1)
    assert.equal(read(file), before)
    assert.equal(read(withRoot), before2)
  })

  it('exits 2 for a usage error and leaves the file as it was', () => {
    const app = folder('app')
    const file = makeConfig()
    const before = read(file)
    for (const args of [
      ['unknown'],
      ['add'],
      ['add', app, 'more'],
      ['remove'],
      ['write'],
      ['write', app, 'yes'],
      ['write', app, 'true', 'more'],
      ['task', app, 'test'],
      ['task', app, 'test', 'x', 'more'],
    ])
      assert.equal(ws(file, 'workspace', ...args).code, 2, args.join(' '))
    assert.equal(read(file), before)
  })

  it(
    'accepts a path with backslashes and a drive letter, and stores it with /',
    { skip: process.platform !== 'win32' },
    () => {
      const file = makeConfig()
      const app = folder('app').replaceAll('/', '\\')
      assert.equal(ws(file, 'workspace', 'add', app).code, 0)
      assert.equal(section(file).roots[0].path, real(app))
      assert.ok(!section(file).roots[0].path.includes('\\'))
      assert.equal(ws(file, 'workspace', 'add', app.toLowerCase()).out.trim(), 'already a root')
    },
  )
})
