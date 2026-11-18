import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loginCommand, NPX_LAUNCH, parseConfig, pathWord, shellWord, type Launch } from '../src/core/config.ts'
import { clientFiles, configText, importServers, initReport } from '../src/core/init.ts'
import { runInit } from '../src/host/init.ts'
import { detectLaunch } from '../src/host/start.ts'

const SECRETS = ['fake-secret-env', 'fake-secret-header', 'fake-secret-pass', 'fake-secret-query']

// User scope only: the project entry must not be imported.
const CLAUDE_CODE = {
  mcpServers: {
    github: { type: 'stdio', command: 'npx', args: ['-y', 'fake-github'], env: { TOKEN: 'fake-secret-env' } },
    toolscript: { command: 'npx', args: ['-y', 'toolscript-mcp'] },
    events: { type: 'sse', url: 'https://mcp.example.com/sse' },
  },
  projects: { '/work': { mcpServers: { project_only: { command: 'fake' } } } },
}
const CLAUDE_DESKTOP = {
  mcpServers: {
    github: { command: 'npx', args: ['-y', 'fake-github'], env: { TOKEN: 'fake-secret-env' } },
    'my notes': {
      command: 'node',
      args: ['notes.js', 'postgres://user:fake-secret-pass@db.example.com/x'],
      cwd: '/srv',
    },
    self: { command: 'node', args: ['/opt/toolscript-mcp/dist/host/main.js', '--config', '/x.json'] },
    off: { command: 'fake', disabled: true },
  },
}
const CURSOR = {
  mcpServers: {
    github: { command: 'other-github' },
    // A server in a clone of toolscript-mcp is not toolscript-mcp itself.
    bench: { command: 'node', args: ['/src/toolscript-mcp/bench/fake-server.mjs'] },
    badcwd: { command: 'fake', cwd: 1 },
    tracker: {
      url: 'https://mcp.example.com/mcp?key=fake-secret-query',
      headers: { Authorization: 'Bearer fake-secret-header' },
    },
  },
}
const CLIENTS = {
  '.claude.json': CLAUDE_CODE,
  '.config/Claude/claude_desktop_config.json': CLAUDE_DESKTOP,
  '.cursor/mcp.json': CURSOR,
}

const temps: string[] = []
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

/** A temp home folder with these files, by path from the home. A string is written as it is. */
const homeWith = (files: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-init-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return dir
}

const init = async (home: string, args: string[] = [], platform = 'linux', launch: Launch = NPX_LAUNCH) => {
  let out = ''
  const env = { XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, '.config') }
  const code = await runInit(args, env, platform, home, text => (out += `${text}\n`), launch)
  return { code, out, file: path.join(home, '.config', 'toolscript-mcp', 'config.json') }
}

const noSecret = (text: string) => {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} is shown:\n${text}`)
}

describe('toolscript-mcp init', () => {
  test('imports the user-scope servers of each client into a config that toolscript-mcp reads', async () => {
    const home = homeWith(CLIENTS)
    const before = Object.keys(CLIENTS).map(rel => fs.readFileSync(path.join(home, rel), 'utf8'))
    const { code, out, file } = await init(home)
    assert.equal(code, 0, out)

    const parsed = parseConfig(fs.readFileSync(file, 'utf8'), {}, '/usr/bin/node', 'linux')
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
    assert.deepEqual(Object.fromEntries(parsed.config.servers), {
      github: { kind: 'stdio', command: 'npx', args: ['-y', 'fake-github'], env: { TOKEN: 'fake-secret-env' } },
      'my-notes': {
        kind: 'stdio',
        command: 'node',
        args: ['notes.js', 'postgres://user:fake-secret-pass@db.example.com/x'],
        env: {},
        cwd: '/srv',
      },
      bench: { kind: 'stdio', command: 'node', args: ['/src/toolscript-mcp/bench/fake-server.mjs'], env: {} },
      tracker: {
        kind: 'http',
        url: 'https://mcp.example.com/mcp?key=fake-secret-query',
        headers: { Authorization: 'Bearer fake-secret-header' },
      },
    })
    assert.deepEqual(parsed.config.policy, [])
    assert.deepEqual(
      Object.keys(CLIENTS).map(rel => fs.readFileSync(path.join(home, rel), 'utf8')),
      before,
      'the client files are unchanged',
    )
  })

  test('the report says what to remove and add in each client, and shows no secret', async () => {
    const home = homeWith(CLIENTS)
    const { out, file } = await init(home)
    noSecret(out)
    const lines = out.split('\n').map(l => l.trim())
    const has = (line: string) => assert.ok(lines.includes(line), `missing line: ${line}\n\n${out}`)
    has('claude mcp remove github --scope user')
    has('claude mcp remove toolscript --scope user')
    has(`claude mcp add --scope user toolscript -- npx -y toolscript-mcp --config ${shellWord(file, 'linux')}`)
    has('Remove from "mcpServers": "github", "my notes", "self"')
    has('Remove from "mcpServers": "bench", "tracker"')
    has(
      `Add to "mcpServers": "toolscript": {"command":"npx","args":["-y","toolscript-mcp","--config",${JSON.stringify(file)}]}`,
    )
    assert.match(out, /- Claude Code "toolscript": .*toolscript-mcp/)
    assert.match(out, /- Claude Desktop "self": .*toolscript-mcp/)
    assert.match(out, /- Claude Code "events": .*sse/)
    assert.match(out, /- Claude Desktop "off": .*disabled/)
    assert.match(out, /- Cursor "github": .*Claude Code/)
    has('- my-notes, from Claude Desktop "my notes"')
    assert.match(out, /- Cursor "badcwd": "cwd" is not a string/)
    assert.doesNotMatch(out, /project_only/)
    assert.match(out, /"policy"/)
    has('toolscript-mcp reads the policy again at each run. It asks you to approve a new allow rule before it applies.')
    has('If your client cannot ask, restart toolscript-mcp to apply a new allow rule.')
    assert.doesNotMatch(out, /needs no restart/)
  })

  test('the config is readable by its owner only, and an existing config needs --force', async () => {
    const home = homeWith(CLIENTS)
    const first = await init(home)
    assert.equal(first.code, 0, first.out)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(first.file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(first.file)).mode & 0o777, 0o700)
    }

    fs.writeFileSync(first.file, '{"mcpServers": {}}')
    const refused = await init(home)
    assert.equal(refused.code, 1)
    assert.match(refused.out, /--force/)
    assert.equal(fs.readFileSync(first.file, 'utf8'), '{"mcpServers": {}}')

    fs.chmodSync(first.file, 0o644)
    const forced = await init(home, ['--force'])
    assert.equal(forced.code, 0, forced.out)
    assert.match(fs.readFileSync(first.file, 'utf8'), /"tracker"/)
    if (process.platform !== 'win32') assert.equal(fs.statSync(first.file).mode & 0o777, 0o600)
  })

  test('--force never writes the secrets into the old config, and leaves no temp file', async () => {
    const old = '{"mcpServers": {}}'
    const home = homeWith({ ...CLIENTS, '.config/toolscript-mcp/config.json': old })
    const file = path.join(home, '.config', 'toolscript-mcp', 'config.json')
    fs.chmodSync(file, 0o644)
    // A reader that opened the old config while others could read it.
    const reader = fs.openSync(file, 'r')
    try {
      const { code, out } = await init(home, ['--force'])
      if (process.platform === 'win32') {
        // Windows cannot rename onto an open file: the replace fails, and the old config stays whole.
        assert.equal(code, 1, out)
        assert.equal(fs.readFileSync(file, 'utf8'), old)
      } else {
        assert.equal(code, 0, out)
        assert.equal(fs.readFileSync(reader, 'utf8'), old, 'the old file did not get the secrets')
        assert.equal(fs.statSync(file).mode & 0o777, 0o600)
        assert.match(fs.readFileSync(file, 'utf8'), /"tracker"/)
      }
    } finally {
      fs.closeSync(reader)
    }
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['config.json', 'config.json.bak'])
  })

  test('--force keeps the old config as config.json.bak and lists the parts that the new one leaves out', async () => {
    const old = JSON.stringify(
      {
        mcpServers: {
          github: { command: 'fake-old-github' },
          mine: { command: 'fake-mine' },
          bench: { command: 'node', args: ['/src/toolscript-mcp/bench/fake-server.mjs'] },
        },
        policy: [{ match: 'mcp__github__*', action: 'allow' }],
        sandbox: { timeoutSeconds: 30 },
        log: false,
      },
      null,
      2,
    )
    const home = homeWith({
      ...CLIENTS,
      '.config/toolscript-mcp/config.json': old,
      '.config/toolscript-mcp/config.json.bak': 'an older backup',
    })
    const file = path.join(home, '.config', 'toolscript-mcp', 'config.json')
    const bak = `${file}.bak`
    fs.chmodSync(bak, 0o644)
    const { code, out } = await init(home, ['--force'])
    assert.equal(code, 0, out)
    assert.match(fs.readFileSync(file, 'utf8'), /"tracker"/)
    assert.equal(fs.readFileSync(bak, 'utf8'), old)
    if (process.platform !== 'win32') assert.equal(fs.statSync(bak).mode & 0o777, 0o600)
    assert.ok(out.includes(`${bak} holds the old config`), out)
    const lines = out.split('\n')
    for (const part of [
      '"policy"',
      '"sandbox"',
      '"log"',
      'the server "github": a different entry',
      'the server "mine": not in the new config',
    ])
      assert.ok(lines.includes(`- ${part}`), `missing - ${part}:\n${out}`)
    assert.doesNotMatch(out, /the server "bench"/, 'an entry that the new config has as it is')
    assert.doesNotMatch(out, /fake-old-github|fake-mine|timeoutSeconds/, 'no value of the old config')
  })

  test('--dry-run hides the whole user and password of a URL, also with @ or / in the password', async () => {
    const home = homeWith({
      '.cursor/mcp.json': {
        mcpServers: {
          api: { url: 'https://user:fake@secret@example.com/mcp' },
          db: {
            command: 'node',
            args: ['--db=postgres://user:fake@secret@db.example.com/x', 'mysql://user:fake/secret@db.example.com'],
          },
        },
      },
    })
    const { code, out } = await init(home, ['--dry-run'])
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /fake[@/]secret/)
    assert.match(out, /"https:\/\/\*\*\*@example\.com\/mcp"/)
    assert.match(out, /"--db=postgres:\/\/\*\*\*@db\.example\.com\/x"/)
  })

  test('--dry-run hides the secrets in arguments, URL paths and fragments, and keeps other arguments', async () => {
    const home = homeWith({
      '.cursor/mcp.json': {
        mcpServers: {
          remote: {
            command: 'npx',
            args: [
              '-y',
              '@fake-scope/fake-remote@1.2.3',
              'https://mcp.example.com/api/mcp/s/fakeSecretPath0123456789/mcp',
              '--header',
              'Authorization: Bearer fake-secret-header-arg',
              '--api-key',
              'fake-secret-flag',
              '--token=fake-secret-assign',
              '-e',
              'GITHUB_TOKEN=fake-secret-env-arg',
              '-H',
              'X-Fake: Bearer fake-secret-bearer',
              'https://mcp.example.com/x#frag=fake-secret-fragment',
              '/srv/data/notes',
              '--port',
              '8080',
            ],
          },
          api: { url: 'https://mcp.example.com/mcp/fake0secret0path0abcd/sse#k=fake-secret-url-fragment' },
        },
      },
    })
    const { code, out } = await init(home, ['--dry-run'])
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /fake.?secret/i)
    for (const kept of [
      '"-y"',
      '"@fake-scope/fake-remote@1.2.3"',
      '"https://mcp.example.com/api/mcp/s/***/mcp"',
      '"--header"',
      '"Authorization: ***"',
      '"--api-key"',
      '"--token=***"',
      '"GITHUB_TOKEN=***"',
      '"X-Fake: Bearer ***"',
      '"https://mcp.example.com/x#***"',
      '"/srv/data/notes"',
      '"--port",\n        "8080"',
      '"https://mcp.example.com/mcp/***/sse#***"',
    ])
      assert.ok(out.includes(kept), `missing ${kept}:\n${out}`)
    assert.match(
      out,
      /key, token, secret, pass, pwd, auth, bearer, header, credential, cookie, session or dsn, or the part pat, sig, sas or pw/,
    )
    assert.match(out, /do not share this output/)
  })

  test('--dry-run hides a URL password with a space, and a secret inside an argument of several words', async () => {
    const home = homeWith({
      '.cursor/mcp.json': {
        mcpServers: {
          api: { url: 'https://fake-user:fake pass w0rd@h.example/mcp?fakeBareToken1' },
          shell: {
            command: 'sh',
            args: ['-c', `export GITHUB_TOKEN=ghp_fake${'0'.repeat(32)}; npx fake-server --api-key sk-fake-12345`],
          },
        },
      },
    })
    const { code, out } = await init(home, ['--dry-run'])
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /fake pass|w0rd|ghp_fake|sk-fake|fakeBareToken/)
    assert.ok(out.includes('"url": "https://***@h.example/mcp?***"'), out)
    assert.ok(out.includes('"export GITHUB_TOKEN=***; npx fake-server --api-key ***"'), out)
  })

  test('--dry-run hides the secrets of a JSON argument and the password after -u', async () => {
    const home = homeWith({
      '.cursor/mcp.json': {
        mcpServers: {
          json: { command: 'fake', args: ['--config', '{"apiKey": "fake-secret-json", "url": "https://h.example"}'] },
          curl: { command: 'sh', args: ['-c', 'curl -u fake:fake-secret-user https://h.example', '-u', '1000:1000'] },
        },
      },
    })
    const { code, out } = await init(home, ['--dry-run'])
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /fake.?secret/i)
    for (const kept of [
      String.raw`"{\"apiKey\":\"***\",\"url\":\"https://h.example\"}"`,
      '"curl -u fake:*** https://h.example"',
      '"-u",\n        "1000:1000"',
    ])
      assert.ok(out.includes(kept), `missing ${kept}:\n${out}`)
    assert.match(out, /- in a JSON argument: each value under a key with such a name/)
    assert.match(out, /- the password of user:password after -u, --user or --proxy-user/)
  })

  test('the mode of the .bak file is named only on Linux and macOS', async () => {
    for (const [platform, mode] of [
      ['linux', true],
      ['win32', false],
    ] as const) {
      const home = homeWith({ ...CLIENTS, '.config/toolscript-mcp/config.json': '{"mcpServers": {}}' })
      const { code, out } = await init(home, ['--force'], platform)
      assert.equal(code, 0, out)
      assert.match(out, /config\.json\.bak holds the old config/)
      assert.equal(out.includes('0600'), mode, out)
    }
  })

  test('on a file system without hard links, init copies the temp file and still never replaces a config', async t => {
    t.mock.method(fs.promises, 'link', async () => {
      throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
    })
    const home = homeWith(CLIENTS)
    const first = await init(home)
    assert.equal(first.code, 0, first.out)
    assert.match(fs.readFileSync(first.file, 'utf8'), /"tracker"/)
    if (process.platform !== 'win32') assert.equal(fs.statSync(first.file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(path.dirname(first.file)), ['config.json'])

    fs.writeFileSync(first.file, '{"mcpServers": {}}')
    const refused = await init(home)
    assert.equal(refused.code, 1, refused.out)
    assert.match(refused.out, /--force/)
    assert.equal(fs.readFileSync(first.file, 'utf8'), '{"mcpServers": {}}')
    assert.deepEqual(fs.readdirSync(path.dirname(first.file)), ['config.json'])
  })

  test('--dry-run says what init does with an existing config, with and without --force', async () => {
    const old = JSON.stringify({ mcpServers: {}, policy: [{ match: 'mcp__github__*', action: 'allow' }] })
    const home = homeWith({ ...CLIENTS, '.config/toolscript-mcp/config.json': old })
    const file = path.join(home, '.config', 'toolscript-mcp', 'config.json')
    const plain = await init(home, ['--dry-run'])
    assert.equal(plain.code, 0, plain.out)
    assert.ok(plain.out.includes(`${file} exists, so init refuses to replace it without --force.`), plain.out)

    const forced = await init(home, ['--dry-run', '--force'])
    assert.equal(forced.code, 0, forced.out)
    assert.doesNotMatch(forced.out, /refuses to replace/)
    assert.ok(forced.out.includes(`${file} exists. init would replace it and keep the old file as ${file}.bak.`))
    assert.ok(forced.out.split('\n').includes('- "policy"'), forced.out)
    assert.equal(fs.readFileSync(file, 'utf8'), old)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json'])
  })

  test('--dry-run writes nothing and prints the config with the secrets hidden', async () => {
    const home = homeWith(CLIENTS)
    const { code, out, file } = await init(home, ['--dry-run'])
    assert.equal(code, 0, out)
    assert.equal(fs.existsSync(file), false)
    noSecret(out)
    assert.match(out, /"tracker": \{/)
    assert.match(out, /"TOKEN": "\*\*\*"/)
    assert.match(out, /postgres:\/\/\*\*\*@db\.example\.com\/x/)
  })

  test('--config sets where the config goes', async () => {
    const home = homeWith(CLIENTS)
    const target = path.join(home, 'elsewhere', 'toolscript.json')
    const { code, out } = await init(home, ['--config', target])
    assert.equal(code, 0, out)
    assert.ok(fs.existsSync(target))
    assert.ok(out.includes(`--config ${shellWord(target, 'linux')}`), out)
  })

  test('with no server to import, nothing is written', async () => {
    const home = homeWith({ '.cursor/mcp.json': { mcpServers: { toolscript: { command: 'npx' } } } })
    const { code, out, file } = await init(home)
    assert.equal(code, 1)
    assert.equal(fs.existsSync(file), false)
    assert.match(out, /no file/)
    assert.match(out, /- Cursor "toolscript": .*toolscript-mcp/, 'the report says why the entry was not imported')
  })

  test('a client file that is not valid JSON is named without its text, and the other clients still import', async () => {
    const home = homeWith({
      '.cursor/mcp.json': '{"mcpServers": {"x": {"env": {"T": fake-secret-env}}}}',
      '.config/Claude/claude_desktop_config.json': CLAUDE_DESKTOP,
    })
    const { code, out, file } = await init(home)
    assert.equal(code, 0, out)
    noSecret(out)
    assert.match(out, /Cursor, .*mcp\.json: not valid JSON/)
    assert.match(fs.readFileSync(file, 'utf8'), /"my-notes"/)
  })

  test('on Windows, Claude Code starts npx through cmd /c', async () => {
    const home = homeWith({ '.claude.json': CLAUDE_CODE })
    const { out, file } = await init(home, [], 'win32')
    assert.ok(
      out.includes(
        `claude mcp add --scope user toolscript "--" cmd /c npx -y toolscript-mcp --config ${pathWord(file, 'win32')}`,
      ),
      out,
    )
  })

  describe('from a clone', () => {
    const clone: Launch = { kind: 'node', main: '/home/u/my tools/toolscript-mcp/dist/host/main.js' }

    test('every client starts node with the path of main.js, and Windows has no cmd /c', async () => {
      const home = homeWith(CLIENTS)
      const { out, file } = await init(home, [], 'linux', clone)
      assert.ok(!out.includes('npx'), out)
      assert.ok(
        out.includes(
          `claude mcp add --scope user toolscript -- node '/home/u/my tools/toolscript-mcp/dist/host/main.js' --config ${shellWord(file, 'linux')}`,
        ),
        out,
      )
      assert.ok(
        out.includes(
          `"toolscript": {"command":"node","args":["/home/u/my tools/toolscript-mcp/dist/host/main.js","--config",${JSON.stringify(file)}]}`,
        ),
        out,
      )
      const main = 'C:\\Users\\u\\my tools\\toolscript-mcp\\dist\\host\\main.js'
      const win = await init(homeWith(CLIENTS), [], 'win32', { kind: 'node', main })
      assert.ok(!win.out.includes('cmd /c'), win.out)
      assert.ok(
        win.out.includes(
          `claude mcp add --scope user toolscript "--" node "C:/Users/u/my tools/toolscript-mcp/dist/host/main.js" --config`,
        ),
        win.out,
      )
      assert.ok(
        win.out.includes(`"toolscript": {"command":"node","args":[${JSON.stringify(main)},"--config",`),
        'a client config keeps the path as it is',
      )
    })

    test('the OAuth login line names the same start and the config file', () => {
      const out = initReport(
        importServers([
          {
            client: 'claude-code',
            path: '/c/.claude.json',
            kind: 'text',
            text: JSON.stringify({ mcpServers: { jira: { type: 'http', url: 'https://mcp.example.com/mcp' } } }),
          },
        ]),
        '/c/config.json',
        'linux',
        { kind: 'node', main: '/opt/tool/main.js' },
      )
      assert.ok(out.includes('run node /opt/tool/main.js login <server> --config /c/config.json for it.'), out)
    })
  })

  test('--help and -h print the usage and exit 0, and write nothing', async () => {
    for (const flag of ['--help', '-h']) {
      const home = homeWith(CLIENTS)
      const { code, out, file } = await init(home, [flag])
      assert.equal(code, 0, out)
      assert.match(out, /^usage: toolscript-mcp init /)
      assert.ok(!fs.existsSync(file))
    }
  })
})

describe('the login command', () => {
  test('is npx for the package and node with the path for a clone, quoted for the shell', () => {
    assert.equal(loginCommand(NPX_LAUNCH, 'linux', 'jira' as never), 'npx -y toolscript-mcp login jira')
    const clone: Launch = { kind: 'node', main: '/home/u/my tools/main.js' }
    assert.equal(
      loginCommand(clone, 'linux', 'jira' as never, "/home/u/it's.json"),
      `node '/home/u/my tools/main.js' login jira --config '/home/u/it'\\''s.json'`,
    )
    assert.equal(
      loginCommand({ kind: 'node', main: 'C:\\my tools\\main.js' }, 'win32', 'jira' as never, 'C:\\c.json'),
      `node "C:/my tools/main.js" login jira --config C:/c.json`,
    )
  })

  test('make it fail: a key that starts with - comes last, after --', () => {
    assert.equal(loginCommand(NPX_LAUNCH, 'linux', '-x' as never), 'npx -y toolscript-mcp login -- -x')
    assert.equal(
      loginCommand(NPX_LAUNCH, 'win32', '-x' as never, 'C:\\c.json'),
      'npx -y toolscript-mcp login --config C:/c.json "--" -x',
    )
  })

  const hidden = { encoding: 'utf8', windowsHide: true } as const
  const SHELLS: Record<string, (line: string) => ReturnType<typeof spawnSync<string>>> = {
    cmd: line =>
      spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        ...hidden,
        windowsVerbatimArguments: true,
      }),
    powershell: line => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], hidden),
    pwsh: line => spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', line], hidden),
    // Claude Code runs a `!` command in Git Bash on Windows.
    'git bash': line => spawnSync('bash', ['-c', line], hidden),
  }
  const present = (shell: string) =>
    shell === 'git bash'
      ? spawnSync('bash', ['-c', 'uname -o'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() === 'Msys'
      : shell !== 'pwsh' || spawnSync('pwsh.exe', ['-v'], { windowsHide: true }).error === undefined

  for (const shell of Object.keys(SHELLS))
    test(
      `on Windows ${shell} passes each word of the printed command as it is`,
      { skip: process.platform !== 'win32' ? 'not Windows' : !present(shell) && `no ${shell}` },
      () => {
        // A bare path, and a path with characters that each need quotes in one of the shells. cmd.exe keeps a %NAME%
        // that is not set.
        for (const name of ['toolscript-', "toolscript a&b (x86) ^ %ts_unset% !x @+ ’q 'o;,= "]) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), name))
          temps.push(dir)
          const script = path.join(dir, 'main.js')
          // ASCII only, so the code page of the shell cannot change the output.
          fs.writeFileSync(
            script,
            'process.stdout.write(JSON.stringify(process.argv.slice(1)).replace(/[^\\x00-\\x7f]/g, c => `\\\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))\n',
          )
          const config = path.join(dir, 'config.json')
          // A key that starts with - comes after "--", so the CLI does not read it as an option.
          for (const [key, words] of [
            ['x', ['login', 'x', '--config', config]],
            ['-x', ['login', '--config', config, '--', '-x']],
          ] as const) {
            const line = loginCommand({ kind: 'node', main: script }, 'win32', key as never, config)
            const run = SHELLS[shell](line)
            assert.equal(run.status, 0, `${line}\n${run.stdout}${run.stderr}`)
            const [main, ...args] = JSON.parse(run.stdout) as string[]
            const at = args.indexOf('--config') + 1
            assert.deepEqual([main, ...args.with(at, path.resolve(args[at]!))], [script, ...words], line)
          }
        }
      },
    )
})

describe('shellWord', () => {
  test('on Windows a bare word stays bare and a word with a space gets double quotes', () => {
    assert.equal(shellWord('C:\\a\\b.json', 'win32'), 'C:\\a\\b.json')
    assert.equal(shellWord('C:\\a b\\main.js', 'win32'), '"C:\\a b\\main.js"')
    assert.equal(shellWord('--', 'win32'), '"--"')
    assert.equal(shellWord('-a:b', 'win32'), '"-a:b"')
  })

  test('on Windows a word that expands in double quotes gets single quotes, doubled inside', () => {
    assert.equal(shellWord('C:\\a b\\$x\\c.json', 'win32'), `'C:\\a b\\$x\\c.json'`)
    assert.equal(shellWord('$it’s', 'win32'), `'$it’’s'`)
    assert.equal(shellWord("$it's", 'win32'), `'$it''s'`)
    assert.equal(shellWord('C:\\a b\\', 'win32'), `'C:\\a b\\'`)
    assert.equal(shellWord('a “b', 'win32'), `'a “b'`)
  })

  test('on Windows % and ! stay in double quotes, which cmd.exe reads too', () => {
    assert.equal(shellWord('C:\\a b\\%TEMP%\\c.json', 'win32'), '"C:\\a b\\%TEMP%\\c.json"')
    assert.equal(shellWord('a b!', 'win32'), '"a b!"')
    assert.equal(shellWord('C:\\a b\\it’s\\c', 'win32'), '"C:\\a b\\it’s\\c"')
  })

  test('on POSIX a word with a space gets single quotes', () => {
    assert.equal(shellWord('/a b/c', 'linux'), `'/a b/c'`)
    assert.equal(shellWord("/a/it's", 'darwin'), `'/a/it'\\''s'`)
    assert.equal(shellWord('/a/b.json', 'linux'), '/a/b.json')
  })
})

describe('pathWord', () => {
  test('on Windows a path gets forward slashes, and quotes as any word', () => {
    assert.equal(pathWord('C:\\a\\b.json', 'win32'), 'C:/a/b.json')
    assert.equal(pathWord('C:\\a b (x86)\\main.js', 'win32'), '"C:/a b (x86)/main.js"')
    assert.equal(pathWord('\\\\host\\share\\main.js', 'win32'), '//host/share/main.js')
    assert.equal(pathWord('C:\\a b\\', 'win32'), '"C:/a b/"')
    assert.equal(pathWord('C:\\a b\\$x\\c.json', 'win32'), `'C:/a b/$x/c.json'`)
  })

  test('on POSIX a path keeps its backslashes', () => {
    assert.equal(pathWord('/a/b\\c', 'linux'), `'/a/b\\c'`)
  })
})

describe('detectLaunch', () => {
  test('a clone gives node and the absolute path, and an npm install gives npx', () => {
    assert.deepEqual(detectLaunch('main.js'), { kind: 'node', main: path.resolve('main.js') })
    const clone = path.join(os.tmpdir(), 'toolscript-mcp', 'dist', 'host', 'main.js')
    assert.deepEqual(detectLaunch(clone), { kind: 'node', main: clone })
    for (const script of [
      '/home/u/.npm/_npx/ab12/node_modules/toolscript-mcp/dist/host/main.js',
      '/home/u/.npm/_npx/ab12/node_modules/.bin/toolscript-mcp',
      'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\toolscript-mcp\\dist\\host\\main.js',
    ])
      assert.deepEqual(detectLaunch(script), NPX_LAUNCH, script)
  })
})

describe('the printed Claude Code commands', () => {
  // Each one expands in a shell when it is not quoted as a literal.
  const NAME = `x $(echo pwned) \`echo pwned\` $HOME 'q' "d" ’ ; & | -a:b`
  const report = (configFile: string, platform: string) =>
    initReport(
      importServers([
        {
          client: 'claude-code',
          path: '/c/.claude.json',
          kind: 'text',
          text: JSON.stringify({ mcpServers: { [NAME]: { command: 'fake' } } }),
        },
      ]),
      configFile,
      platform,
      NPX_LAUNCH,
    )

  /** The arguments that `claude` gets when a shell runs the printed command lines, one list per line. */
  const argvInShell = (shell: string, define: string, text: string): string[][] => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-shell-'))
    temps.push(dir)
    const script = path.join(dir, 'argv.mjs')
    const out = path.join(dir, 'argv.jsonl')
    fs.writeFileSync(
      script,
      `import fs from 'node:fs'\nfs.appendFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
    )
    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('claude mcp '))
    const args = shell === 'sh' ? ['-c'] : ['-NoProfile', '-NonInteractive', '-Command']
    const run = spawnSync(shell, [...args, [define, ...lines].join('\n')], {
      encoding: 'utf8',
      // Git for Windows sh rewrites /home/... arguments into Windows paths unless told not to.
      env: {
        ...process.env,
        NODE: process.execPath,
        ARGV: script,
        OUT: out,
        MSYS_NO_PATHCONV: '1',
        MSYS2_ARG_CONV_EXCL: '*',
      },
    })
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    return fs
      .readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
  }
  const has = (shell: string) => spawnSync(shell, ['-c', 'exit 0']).error === undefined

  test('a POSIX shell passes the server name and the config path as they are', { skip: !has('sh') && 'no sh' }, () => {
    const config = `/home/u/$HOME/it's $(echo pwned) \`x\`/config.json`
    const argv = argvInShell('sh', 'claude() { "$NODE" "$ARGV" "$@"; }', report(config, 'linux'))
    assert.deepEqual(argv, [
      ['mcp', 'remove', NAME, '--scope', 'user'],
      ['mcp', 'add', '--scope', 'user', 'toolscript', '--', 'npx', '-y', 'toolscript-mcp', '--config', config],
    ])
  })

  // A function, as the npm shim claude.ps1 is a script: PowerShell drops a bare -- before both.
  test('PowerShell passes the server name and the config path as they are', { skip: !has('pwsh') && 'no pwsh' }, () => {
    const config = `C:\\Users\\u\\$env:USERNAME\\it’s $(echo pwned) \`x\\config.json`
    const text = report(config, 'win32')
    const argv = argvInShell('pwsh', 'function claude { & $env:NODE $env:ARGV @args }', text)
    const run = ['-y', 'toolscript-mcp', '--config', config.replaceAll('\\', '/')]
    assert.deepEqual(argv, [
      ['mcp', 'remove', NAME, '--scope', 'user'],
      ['mcp', 'add', '--scope', 'user', 'toolscript', '--', 'cmd', '/c', 'npx', ...run],
    ])
    assert.match(text, /Claude Code, in PowerShell:/)
  })
})

describe('the OAuth login in the report', () => {
  const report = (servers: Record<string, unknown>) =>
    initReport(
      importServers([
        { client: 'claude-code', path: '/c/.claude.json', kind: 'text', text: JSON.stringify({ mcpServers: servers }) },
      ]),
      '/c/config.json',
      'linux',
      NPX_LAUNCH,
    )

  test('names the HTTP servers without headers, which log in with toolscript-mcp login', () => {
    const out = report({
      jira: { type: 'http', url: 'https://mcp.example.com/mcp' },
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      tracker: { type: 'http', url: 'https://t.example.com/mcp', headers: { Authorization: 'Bearer fake' } },
      files: { command: 'fake' },
    })
    assert.ok(
      out.includes(
        'These HTTP servers have no headers: jira, docs. If one asks for an OAuth login, run npx -y toolscript-mcp login <server> --config /c/config.json for it.',
      ),
      out,
    )
  })

  test('says nothing about a login without such a server', () => {
    assert.doesNotMatch(report({ files: { command: 'fake' } }), /login/)
  })

  test('make it fail: each server that names Azure DevOps gets "untrusted": true, and no other server does', () => {
    const ado = {
      npx: { command: 'npx', args: ['-y', '@azure-devops/mcp', 'fake-org'] },
      cmd: { command: 'cmd', args: ['/c', 'npx', '-y', '@azure-devops/mcp@latest', 'fake-org', '-d', 'core'] },
      bin: { command: 'C:\\npm\\mcp-server-azuredevops.cmd', args: ['fake-org'] },
      path: { command: 'node', args: ['C:\\npm\\node_modules\\@azure-devops\\mcp\\dist\\index.js', 'fake-org'] },
      remote: { type: 'http', url: 'https://mcp.dev.azure.com/fake-org' },
      'mcp-remote': { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.dev.azure.com/fake-org'] },
      'url-flag': { command: 'npx', args: ['-y', 'mcp-remote', '--url=https://MCP.DEV.AZURE.COM:443/fake-org'] },
      'cmd-string': { command: 'cmd', args: ['/c', 'npx -y @azure-devops/mcp fake-org'] },
      ps1: { command: 'C:\\npm\\mcp-server-azuredevops.ps1', args: ['fake-org'] },
      'package-flag': { command: 'npx', args: ['-y', '--package=@azure-devops/mcp', 'mcp-server-azuredevops', 'o'] },
      pnpm: { command: 'pnpm', args: ['dlx', '@azure-devops/mcp@next', 'fake-org'] },
      wsl: { command: 'wsl', args: ['npx', '-y', '@azure-devops/mcp', 'fake-org'] },
      clone: { command: 'node', args: ['/src/Azure-DevOps-MCP/dist/index.js', 'fake-org'] },
      community: { command: 'npx', args: ['-y', '@fake/mcp-server-azure-devops'] },
      bridge: { type: 'http', url: 'http://127.0.0.1:60742/mcp/azure-devops' },
      'azure-devops': { type: 'http', url: 'http://127.0.0.1:60742/mcp/one' },
      azure_devops: { command: 'node', args: ['bridge.js'] },
    }
    const others = {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      azure: { command: 'npx', args: ['-y', '@azure/mcp@latest', 'server', 'start'] },
      boards: { type: 'http', url: 'https://dev.azure.com/fake-org' },
    }
    const imp = importServers([
      {
        client: 'claude-code',
        path: '/c/.claude.json',
        kind: 'text',
        text: JSON.stringify({ mcpServers: { ...ado, ...others } }),
      },
    ])
    const parsed = parseConfig(configText(imp.servers, false), {}, '/usr/bin/node', 'linux')
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
    const marked = [...parsed.config.servers].flatMap(([key, e]) => (e.kind !== 'invalid' && e.untrusted ? [key] : []))
    assert.deepEqual(marked, Object.keys(ado))
    const out = initReport(imp, '/c/config.json', 'linux', NPX_LAUNCH)
    assert.ok(
      out.includes(
        `The config sets "untrusted": true on the servers that name Azure DevOps: ${Object.keys(ado).join(', ')}. Each of their results reaches the model as untrusted text.`,
      ),
      out,
    )
    assert.doesNotMatch(report(others), /untrusted/)
  })
})

describe('the client files', () => {
  test('per system, from the home folder and the environment', () => {
    const files = (env: Record<string, string>, platform: string, home: string) =>
      Object.fromEntries(clientFiles(env, platform, home).map(f => [f.client, f.path]))
    assert.deepEqual(files({ APPDATA: 'C:/u/AppData/Roaming' }, 'win32', 'C:/u'), {
      'claude-code': 'C:/u/.claude.json',
      'claude-desktop': 'C:/u/AppData/Roaming/Claude/claude_desktop_config.json',
      cursor: 'C:/u/.cursor/mcp.json',
    })
    assert.deepEqual(files({}, 'darwin', '/Users/u'), {
      'claude-code': '/Users/u/.claude.json',
      'claude-desktop': '/Users/u/Library/Application Support/Claude/claude_desktop_config.json',
      cursor: '/Users/u/.cursor/mcp.json',
    })
    assert.deepEqual(files({ CLAUDE_CONFIG_DIR: '/c' }, 'linux', '/home/u'), {
      'claude-code': '/c/.claude.json',
      'claude-desktop': '/home/u/.config/Claude/claude_desktop_config.json',
      cursor: '/home/u/.cursor/mcp.json',
    })
  })
})
