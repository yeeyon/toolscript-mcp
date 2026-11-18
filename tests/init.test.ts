import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginCommand, NPX_LAUNCH, parseConfig, pathWord, shellWord, type Launch } from '../src/core/config.ts'
import { clientFiles, configText, importServers, initReport, mainCheckoutOf, sameFolder } from '../src/core/init.ts'
import { shownName } from '../src/core/policy.ts'
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
        importServers(
          [
            {
              client: 'claude-code',
              path: '/c/.claude.json',
              kind: 'text',
              text: JSON.stringify({ mcpServers: { jira: { type: 'http', url: 'https://mcp.example.com/mcp' } } }),
            },
          ],
          'linux',
        ),
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
  const NAME = `x $(echo pwned) \`echo pwned\` $HOME 'q' "d" ; & | -a:b`
  // The Windows form passes no " to cmd.exe, and no ' with $ to Git Bash.
  const WINDOWS_NAME = `x $(echo pwned) \`echo pwned\` $HOME ; -a:b`
  // Claude Code reads a name that starts with - as an option, unless it comes after --.
  const DASH = '-dash'
  const report = (configFile: string, platform: string, names: readonly string[]) =>
    initReport(
      importServers(
        [
          {
            client: 'claude-code',
            path: '/c/.claude.json',
            kind: 'text',
            text: JSON.stringify({ mcpServers: Object.fromEntries(names.map(n => [n, { command: 'fake' }])) }),
          },
        ],
        'linux',
      ),
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
    const argv = argvInShell('sh', 'claude() { "$NODE" "$ARGV" "$@"; }', report(config, 'linux', [NAME, DASH]))
    assert.deepEqual(argv, [
      ['mcp', 'remove', NAME, '--scope', 'user'],
      ['mcp', 'remove', '--scope', 'user', '--', DASH],
      ['mcp', 'add', '--scope', 'user', 'toolscript', '--', 'npx', '-y', 'toolscript-mcp', '--config', config],
    ])
  })

  // A function, as the npm shim claude.ps1 is a script: PowerShell drops a bare -- before both.
  test('PowerShell passes the server name and the config path as they are', { skip: !has('pwsh') && 'no pwsh' }, () => {
    const config = `C:\\Users\\u\\$env:USERNAME\\it’s $(echo pwned) \`x\\config.json`
    const text = report(config, 'win32', [WINDOWS_NAME, DASH])
    const argv = argvInShell('pwsh', 'function claude { & $env:NODE $env:ARGV @args }', text)
    const run = ['-y', 'toolscript-mcp', '--config', config.replaceAll('\\', '/')]
    assert.deepEqual(argv, [
      ['mcp', 'remove', WINDOWS_NAME, '--scope', 'user'],
      ['mcp', 'remove', '--scope', 'user', '--', DASH],
      ['mcp', 'add', '--scope', 'user', 'toolscript', '--', 'cmd', '/c', 'npx', ...run],
    ])
    assert.match(text, /Claude Code, in PowerShell:/)
  })

  test('a name that no quoting passes as it is gets no command, and the step says to remove it by hand', () => {
    const steps = (platform: string) =>
      report('/c/config.json', platform, [NAME, 'caf\u00e9'])
        .split('\n')
        .filter(l => l.includes('by hand'))
    assert.deepEqual(steps('linux'), [
      '  "caf\\u00e9": init prints no command, because the name holds a character outside printable ASCII. Remove it from /c/.claude.json by hand.',
    ])
    assert.deepEqual(steps('win32'), [
      `  ${JSON.stringify(NAME)}: init prints no command, because the name holds ", which cmd.exe cannot quote. Remove it from /c/.claude.json by hand.`,
      '  "caf\\u00e9": init prints no command, because the name holds a character outside printable ASCII. Remove it from /c/.claude.json by hand.',
    ])
  })
})

// A name in a cloned repo's .mcp.json reaches the commands of init --list. Each payload writes a file into the cwd of
// the shell, a temp folder, if the shell runs it.
describe('the printed init --add commands', () => {
  const PAYLOADS = [
    '$(touch p1)',
    '`touch p2`',
    'x;touch p3;New-Item p4',
    'x&touch p5&echo>p6',
    'x|touch p7|echo>p8',
    '$(New-Item p9)',
    "%ComSpec% it's",
    'x$(touch${IFS}p10)',
  ]
  // The Windows form cannot pass these as they are in each of cmd.exe, PowerShell and Git Bash.
  const REFUSED_ON_WINDOWS = [
    "it's $(touch p11)",
    'q"x;touch p12',
    '$(touch p13)&echo>p14',
    '/x;touch p15',
    'x=/y;touch p16',
    'a\\b;touch p17',
  ]
  const main = fileURLToPath(new URL('../src/host/main.ts', import.meta.url))
  const hidden = { encoding: 'utf8', windowsHide: true } as const

  /** A project whose .mcp.json has each name, in a temp folder with its own home, and the commands of init --list. */
  const listed = async () => {
    const names = [...PAYLOADS, ...REFUSED_ON_WINDOWS]
    const dir = homeWith({
      'proj/.mcp.json': { mcpServers: Object.fromEntries(names.map(n => [n, { command: 'fake' }])) },
      'home/.claude/settings.json': { enableAllProjectMcpServers: true },
    })
    const [home, project, config] = [path.join(dir, 'home'), path.join(dir, 'proj'), path.join(dir, 'config.json')]
    const env = { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config') }
    let out = ''
    const args = ['--list', '--project', project, '--config', config]
    assert.equal(await runInit(args, env, process.platform, home, t => (out += `${t}\n`), { kind: 'node', main }), 0)
    const lines = new Map(
      names.map(n => [n, out.split('\n').find(l => l.startsWith(`- ${shownName(n)} (claude-code:project`))]),
    )
    const refused = names.filter(n => lines.get(n)?.includes('): no command, because the name '))
    assert.deepEqual(refused, process.platform === 'win32' ? REFUSED_ON_WINDOWS : [], out)
    const commands = names.flatMap(n => (refused.includes(n) ? [] : [lines.get(n)!.replace(/^.*?\): /, '')]))
    // The child reads only the temp home. NODE_OPTIONS lets Node 22.13 run main.ts.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env,
      HOME: home,
      USERPROFILE: home,
      NODE_OPTIONS: '--experimental-strip-types --no-warnings',
    }
    delete childEnv.CLAUDE_CONFIG_DIR
    return { dir, config, names: names.filter(n => !refused.includes(n)), commands, childEnv }
  }

  const SHELLS: Record<string, { present: () => boolean; run: (lines: string[], opts: object) => string }> = {
    sh: {
      present: () => process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).error === undefined,
      run: (lines, opts) => out(spawnSync('sh', ['-c', lines.join('\n')], { ...hidden, ...opts })),
    },
    'git bash': {
      present: () =>
        process.platform === 'win32' && spawnSync('bash', ['-c', 'uname -o'], hidden).stdout?.trim() === 'Msys',
      run: (lines, opts) => out(spawnSync('bash', ['-c', lines.join('\n')], { ...hidden, ...opts })),
    },
    pwsh: {
      present: () => process.platform === 'win32' && spawnSync('pwsh.exe', ['-v'], hidden).error === undefined,
      run: (lines, opts) =>
        out(
          spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')], {
            ...hidden,
            ...opts,
          }),
        ),
    },
  }
  const out = (run: ReturnType<typeof spawnSync<string>>) => `${run.stdout}${run.stderr}`

  for (const [shell, { present, run }] of Object.entries(SHELLS))
    test(
      `${shell} runs no payload, and init adds the server of the exact name`,
      { skip: !present() && `no ${shell}` },
      async () => {
        const { dir, config, names, commands, childEnv } = await listed()
        const text = run(commands, { cwd: dir, env: childEnv })
        assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak', 'home', 'proj'], text)
        for (const name of names)
          assert.match(
            text,
            new RegExp(`^- \\S+, from Claude Code \\(project scope\\) ${escape(shownName(name))}$`, 'm'),
          )
        assert.equal(Object.keys(JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers).length, names.length, text)
      },
    )

  // cmd.exe passes a single-quoted word with its quotes, so init refuses it, but it must run nothing else.
  test('cmd.exe runs no payload', { skip: process.platform !== 'win32' && 'not Windows' }, async () => {
    const { dir, commands, childEnv } = await listed()
    for (const line of commands)
      spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        ...hidden,
        cwd: dir,
        env: childEnv,
        windowsVerbatimArguments: true,
      })
    assert.deepEqual(
      fs.readdirSync(dir).filter(f => /^p\d+$/.test(f)),
      [],
    )
  })
})

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('the OAuth login in the report', () => {
  const report = (servers: Record<string, unknown>) =>
    initReport(
      importServers(
        [
          {
            client: 'claude-code',
            path: '/c/.claude.json',
            kind: 'text',
            text: JSON.stringify({ mcpServers: servers }),
          },
        ],
        'linux',
      ),
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
    const imp = importServers(
      [
        {
          client: 'claude-code',
          path: '/c/.claude.json',
          kind: 'text',
          text: JSON.stringify({ mcpServers: { ...ado, ...others } }),
        },
      ],
      'linux',
    )
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

  test('a Claude Code project key matches its folder, on Windows with either slash and in any case', () => {
    assert.ok(sameFolder('C:/Users/u/proj', 'c:\\users\\U\\proj\\', 'win32'))
    assert.ok(!sameFolder('C:/Users/u/proj', 'C:/Users/u/proj2', 'win32'))
    assert.ok(sameFolder('/home/u/proj/', '/home/u/proj', 'linux'))
    assert.ok(!sameFolder('/home/u/Proj', '/home/u/proj', 'linux'))
  })
})

describe('init --list and --add', () => {
  const LOCAL = {
    gh: { command: '/opt/bin/gh-mcp', args: ['--token', 'fake-secret-arg'], env: { TOKEN: 'fake-secret-env' } },
    notes: {
      type: 'http',
      url: 'https://user:fake-secret-pass@notes.example.com/mcp?key=fake-secret-query',
      headers: { Authorization: 'Bearer fake-secret-header' },
    },
  }
  const PROJECT = {
    shared: { type: 'http', url: 'https://shared.example.com/mcp' },
    'azure-devops': { command: 'npx', args: ['-y', '@azure-devops/mcp', 'fake-org'] },
    events: { type: 'sse', url: 'https://mcp.example.com/sse' },
  }
  const USER = {
    gh: { command: 'npx', args: ['-y', 'fake-gh'], env: { TOKEN: 'fake-secret-env' } },
    toolscript: { command: 'npx', args: ['-y', 'toolscript-mcp'] },
  }
  const OLD = {
    mcpServers: { other: { command: 'fake-other' } },
    policy: [{ match: 'mcp__other__*', action: 'allow' }],
    sandbox: { timeoutSeconds: 60 },
  }

  /** User settings that approve every server of a `.mcp.json` file in Claude Code. */
  const APPROVE_ALL = { '.claude/settings.json': { enableAllProjectMcpServers: true } }

  /**
   * A temp home and project. `key` is the name of the project in `projects` of `.claude.json`. Claude Code trusts the
   * project and approves its servers.
   */
  const setup = (key: (project: string) => string = p => p, config?: unknown) => {
    const project = homeWith({ '.mcp.json': { mcpServers: PROJECT } })
    const home = homeWith({
      '.claude.json': {
        mcpServers: USER,
        projects: {
          [key(project)]: {
            mcpServers: LOCAL,
            hasTrustDialogAccepted: true,
            enabledMcpjsonServers: ['shared', 'azure-devops'],
          },
          '/elsewhere': { mcpServers: { elsewhere: { command: 'x' } } },
        },
      },
      '.config/Claude/claude_desktop_config.json': {
        mcpServers: { 'my notes': { command: 'node', args: ['notes.js'] }, gh: { command: 'desktop-gh' } },
      },
      '.cursor/mcp.json': '{ not json',
      ...(config === undefined ? {} : { '.config/toolscript-mcp/config.json': config }),
    })
    return { home, project }
  }
  const run = (home: string, project: string, args: string[], platform = 'linux', launch: Launch = NPX_LAUNCH) =>
    init(home, [...args, '--project', project], platform, launch)
  const row = (...cells: string[]) =>
    new RegExp(`^${cells.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' +')}(?= |$)`, 'm')
  const unchanged = (file: string, before: string | undefined) => {
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, before)
    assert.ok(!fs.existsSync(`${file}.bak`), 'no .bak')
  }

  test('--list shows each server of each scope and client with its status, writes nothing and shows no secret', async () => {
    const { home, project } = setup()
    const { code, out, file } = await run(home, project, ['--list'])
    assert.equal(code, 0, out)
    assert.ok(!out.includes('fake-secret'), out)
    assert.ok(!fs.existsSync(file), 'no config written')
    assert.match(out, row('name', 'client', 'scope', 'kind', 'status'))
    assert.match(out, row('gh', 'claude-code', 'local', 'stdio gh-mcp', 'not in config'))
    assert.match(out, row('notes', 'claude-code', 'local', 'http https://notes.example.com', 'not in config'))
    assert.match(out, row('shared', 'claude-code', 'project', 'http https://shared.example.com', 'not in config'))
    assert.match(out, row('events', 'claude-code', 'project', '-', 'skipped: type "sse":'), out)
    assert.match(out, row('gh', 'claude-code', 'user', 'stdio npx', 'not in config, hidden by local'))
    assert.match(out, row('toolscript', 'claude-code', 'user', '-', 'toolscript itself'))
    assert.match(out, row('"my notes"', 'claude-desktop', '-', 'stdio node', 'not in config'))
    assert.match(out, row('gh', 'claude-desktop', '-', 'stdio desktop-gh', 'not in config'))
    assert.match(out, /^Cannot read cursor, .*: not valid JSON/m)
    assert.doesNotMatch(out, /elsewhere/)
  })

  test('--list shows only stdio for a command with a space, which can hold arguments and secrets', async () => {
    const home = homeWith({
      '.cursor/mcp.json': {
        mcpServers: {
          tool: { command: 'C:/tools/mytool.exe --tokenfile=abc fakesecretvalue123 fakeshortpw' },
          npx: { command: 'npx -y @acme/mcp ghp_fakefakefakefakefake xoxb-12-fake' },
        },
      },
    })
    const { code, out } = await run(home, home, ['--list'])
    assert.equal(code, 0, out)
    assert.match(out, row('tool', 'cursor', '-', 'stdio', 'not in config'), out)
    assert.match(out, row('npx', 'cursor', '-', 'stdio', 'not in config'), out)
    for (const word of ['mytool', 'abc', 'fakesecretvalue123', 'fakeshortpw', '@acme', 'ghp_', 'xoxb'])
      assert.ok(!out.includes(word), `${word} is shown:\n${out}`)
  })

  test('--list and --add print the names, kinds, reasons and folders of client files as printable text', async () => {
    const top = homeWith({})
    const folder = path.join(top, 'f\u202eo')
    fs.mkdirSync(folder)
    fs.writeFileSync(
      path.join(folder, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'evil\u001b[31m\u202e': { command: 'C:/x/\u009b31mbad\u202e.exe' },
          odd: { type: '\u009b2J' },
          'a  b': { command: 'node', 'x\u001b': 1 },
        },
      }),
    )
    const home = homeWith(APPROVE_ALL)
    const listed = await run(home, folder, ['--list'])
    const added = await run(home, folder, ['--add', 'a  b,evil\u001b[31m\u202e'])
    for (const out of [listed.out, added.out]) assert.doesNotMatch(out, /[^\x20-\x7e\n]/, out)
    assert.match(
      listed.out,
      row('"evil\\u001b[31m\\u202e"', 'claude-code', 'project', 'stdio \\u009b31mbad\\u202e.exe'),
    )
    assert.match(listed.out, row('odd', 'claude-code', 'project', '-', 'skipped: type "\\u009b2J" is not supported'))
    const shown = `${top}${path.sep}f\\u202eo`
    assert.match(listed.out, row('"a  b"', 'claude-code', 'project', 'stdio node', 'not in config', shown))
    assert.equal(added.code, 0, added.out)
    assert.match(added.out, /^- a-b, from Claude Code \(project scope\) "a {2}b"\. Left out: x\\u001b$/m)
  })

  // Claude Code keys the local scope on the root of the main checkout, also from a subfolder or a git worktree
  // (checked with claude mcp add --scope local in a temp CLAUDE_CONFIG_DIR, Claude Code 2.1).
  test('--list from a subfolder or a worktree finds the local scope of the main checkout', async () => {
    const { home, project } = setup()
    fs.mkdirSync(path.join(project, '.git', 'worktrees', 'wt'), { recursive: true })
    const sub = path.join(project, 'src', 'deep')
    fs.mkdirSync(sub, { recursive: true })
    const fromSub = await run(home, sub, ['--list'])
    assert.match(fromSub.out, row('gh', 'claude-code', 'local', 'stdio gh-mcp', 'not in config'), fromSub.out)
    assert.match(fromSub.out, row('shared', 'claude-code', 'project'), fromSub.out)

    const worktree = homeWith({ '.mcp.json': { mcpServers: { wtonly: { command: 'node' } } } })
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${project.replaceAll('\\', '/')}/.git/worktrees/wt\n`)
    const fromWorktree = await run(home, path.join(worktree), ['--list'])
    assert.match(fromWorktree.out, row('gh', 'claude-code', 'local', 'stdio gh-mcp'), fromWorktree.out)
    assert.match(fromWorktree.out, row('wtonly', 'claude-code', 'project'), fromWorktree.out)
    assert.doesNotMatch(fromWorktree.out, /^shared /m)
  })

  // Claude Code 2.1 reads the .mcp.json of the start folder and of each parent, and the closer file wins.
  test('--list and --add read the .mcp.json of each folder up from the project, and the closer file hides the farther', async () => {
    const top = homeWith({
      '.mcp.json': {
        mcpServers: {
          dup: { command: 'node', args: ['far.mjs'] },
          far: { type: 'http', url: 'https://far.example.com/mcp' },
        },
      },
      'near/.mcp.json': { mcpServers: { dup: { command: 'node', args: ['near.mjs'] } } },
    })
    const near = path.join(top, 'near')
    const start = path.join(near, 'deeper')
    fs.mkdirSync(start)
    const home = homeWith(APPROVE_ALL)
    const listed = await run(home, start, ['--list'])
    assert.equal(listed.code, 0, listed.out)
    assert.match(listed.out, row('dup', 'claude-code', 'project', 'stdio node', 'not in config', near), listed.out)
    assert.match(listed.out, row('far', 'claude-code', 'project', 'http https://far.example.com', 'not in config', top))
    assert.match(
      listed.out,
      row('dup', 'claude-code', 'project', 'stdio node', 'not in config, hidden by project', top),
    )

    const added = await run(home, start, ['--add', 'dup,far', '--from', 'claude-code:project'])
    assert.equal(added.code, 0, added.out)
    assert.ok(
      added.out
        .split('\n')
        .includes(
          `  Claude Code (project scope) in ${path.join(top, '.mcp.json')} also has dup, which the project one hides.`,
        ),
      added.out,
    )
    assert.deepEqual(JSON.parse(fs.readFileSync(added.file, 'utf8')).mcpServers, {
      dup: { command: 'node', args: ['near.mjs'], cwd: start },
      far: { type: 'http', url: 'https://far.example.com/mcp' },
    })
    const steps = added.out.split('\n').map(l => l.trim())
    for (const [folder, name] of [
      [near, 'dup'],
      [top, 'far'],
    ]) {
      const at = steps.indexOf(`Claude Code, in the folder ${folder}:`)
      assert.ok(at >= 0 && steps[at + 1] === `claude mcp remove ${name} --scope project`, added.out)
      assert.ok(steps[at + 2]?.startsWith(path.join(folder, '.mcp.json')), added.out)
    }
  })

  test('--list reads only a regular .mcp.json, so a FIFO in a parent folder does not block it', async () => {
    const top = homeWith({
      'dir/.mcp.json/x': '',
      'dir/fifo/start/.mcp.json': { mcpServers: { near: { command: 'node' } } },
    })
    const fifo = path.join(top, 'dir', 'fifo', '.mcp.json')
    const made = process.platform !== 'win32' && spawnSync('mkfifo', [fifo]).status === 0
    const home = homeWith({})
    const { code, out } = await run(home, path.join(top, 'dir', 'fifo', 'start'), ['--list'])
    assert.equal(code, 0, out)
    assert.match(out, row('near', 'claude-code', 'project'), out)
    const problem = (file: string) => `Cannot read claude-code:project, ${file}: cannot read it: not a regular file`
    assert.ok(out.split('\n').includes(problem(path.join(top, 'dir', '.mcp.json'))), out)
    if (made) assert.ok(out.split('\n').includes(problem(fifo)), out)
  })

  test('mainCheckoutOf reads the main checkout of a worktree only', () => {
    assert.equal(mainCheckoutOf('gitdir: C:/r/main/.git/worktrees/wt\n'), 'C:/r/main')
    assert.equal(mainCheckoutOf('gitdir: C:\\r\\main\\.git\\worktrees\\wt\r\n'), 'C:/r/main')
    assert.equal(mainCheckoutOf('gitdir: ../main/.git/worktrees/wt'), '../main')
    assert.equal(mainCheckoutOf('gitdir: /r/main/.git/worktrees/wt/\n'), '/r/main')
    assert.equal(mainCheckoutOf('gitdir: ../.git/modules/sub'), undefined)
    assert.equal(mainCheckoutOf('gitdir: C:/r/main/.git/worktrees/wt/modules/sub\n'), undefined)
    assert.equal(mainCheckoutOf(''), undefined)
  })

  test('--list compares each server with the config', async () => {
    const { home, project } = setup()
    const config = { mcpServers: { gh: { ...LOCAL.gh, cwd: project }, shared: { command: 'fake' } }, policy: [] }
    fs.mkdirSync(path.join(home, '.config', 'toolscript-mcp'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'toolscript-mcp', 'config.json'), JSON.stringify(config))
    const { code, out } = await run(home, project, ['--list'])
    assert.equal(code, 0, out)
    assert.match(out, row('gh', 'claude-code', 'local', 'stdio gh-mcp', 'in config'))
    assert.match(out, row('gh', 'claude-code', 'user', 'stdio npx', 'name taken by a different entry, hidden by local'))
    assert.match(
      out,
      row('shared', 'claude-code', 'project', 'http https://shared.example.com', 'name taken by a different entry'),
    )
  })

  test('--list with no client file prints one line and exits 0', async () => {
    const home = homeWith({})
    const { code, out } = await run(home, home, ['--list'])
    assert.equal(code, 0, out)
    assert.equal(out, 'No MCP server in the client files.\n')
  })

  test('on Windows the local scope matches a project key with / and another case', async () => {
    const key = (p: string) => p.replace(/\\/g, '/').toUpperCase()
    const { home, project } = setup(key)
    assert.match((await run(home, project, ['--list'], 'win32')).out, row('gh', 'claude-code', 'local'))
    const backslash = setup(p => key(p).replace(/\//g, '\\'))
    assert.match(
      (await run(backslash.home, backslash.project, ['--list'], 'win32')).out,
      row('gh', 'claude-code', 'local'),
    )
    assert.doesNotMatch((await run(home, project, ['--list'], 'linux')).out, /local/)
  })

  test('--add copies servers into an existing config, keeps its other keys and policy, and keeps the old file', async () => {
    const { home, project } = setup(undefined, OLD)
    const { code, out, file } = await run(home, project, ['--add', 'notes,shared', '--add', 'azure-devops'])
    assert.equal(code, 0, out)
    assert.ok(!out.includes('fake-secret'), out)
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), OLD)
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(written, {
      ...OLD,
      mcpServers: {
        ...OLD.mcpServers,
        notes: LOCAL.notes,
        shared: PROJECT.shared,
        'azure-devops': { ...PROJECT['azure-devops'], cwd: project, untrusted: true },
      },
    })
    const parsed = parseConfig(fs.readFileSync(file, 'utf8'), {}, process.execPath, process.platform)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
    const lines = out.split('\n').map(l => l.trim())
    for (const line of [
      '- notes, from Claude Code (local scope)',
      '- shared, from Claude Code (project scope)',
      'claude mcp remove notes --scope local',
      'claude mcp remove shared --scope project',
      'claude mcp remove azure-devops --scope project',
    ])
      assert.ok(lines.includes(line), `missing line: ${line}\n\n${out}`)
    assert.match(out, /\.mcp\.json is shared with everyone who uses the project/)
    assert.match(out, /"untrusted": true .*azure-devops/)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  // Claude Code 2.1 starts each stdio server of the local or project scope in the start folder of the session, also a
  // subfolder, and does not read the cwd of the entry (checked with claude mcp list in a temp CLAUDE_CONFIG_DIR).
  // toolscript-mcp starts in the folder of its client, so the entry needs the start folder as its cwd.
  test('--add gives a local or project stdio server the start folder as its cwd, and --list sees it in config', async () => {
    const project = homeWith({
      '.git/HEAD': '',
      '.mcp.json': {
        mcpServers: {
          bare: { command: 'node', args: ['./srv.mjs'] },
          sub: { command: 'node', args: ['./srv.mjs'], cwd: './sub' },
          abs: { command: 'node', cwd: path.join(os.tmpdir(), 'fake-abs') },
          web: { type: 'http', url: 'https://web.example.com/mcp' },
        },
      },
    })
    const start = path.join(project, 'src', 'deep')
    fs.mkdirSync(start, { recursive: true })
    const srv = path.resolve('/srv')
    const home = homeWith({
      ...APPROVE_ALL,
      '.claude.json': {
        mcpServers: { user: { command: 'node', cwd: srv } },
        projects: { [project]: { mcpServers: { local: { command: 'node', args: ['./srv.mjs'], cwd: 'x' } } } },
      },
    })
    const names = 'bare,sub,abs,web,local,user'
    const added = await run(home, start, ['--add', names], process.platform)
    assert.equal(added.code, 0, added.out)
    const text = fs.readFileSync(added.file, 'utf8')
    const { mcpServers } = JSON.parse(text)
    assert.deepEqual(Object.fromEntries(Object.entries(mcpServers).map(([k, v]) => [k, (v as { cwd?: string }).cwd])), {
      bare: start,
      sub: start,
      abs: start,
      web: undefined,
      local: start,
      user: srv,
    })
    for (const name of ['sub', 'abs', 'local'])
      assert.match(added.out, new RegExp(`^- ${name}, from .*\\. Left out: cwd$`, 'm'), added.out)
    assert.match(added.out, /^- bare, from Claude Code \(project scope\)$/m, added.out)
    const parsed = parseConfig(text, {}, process.execPath, process.platform)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))

    const listed = await run(home, start, ['--list'], process.platform)
    for (const name of names.split(',')) assert.match(listed.out, row(name, 'claude-code'), listed.out)
    assert.equal(listed.out.match(/ {2}in config {2}/g)?.length, 6, listed.out)
    const fromRoot = await run(home, project, ['--list'], process.platform)
    assert.match(fromRoot.out, row('bare', 'claude-code', 'project', 'stdio node', 'name taken by a different entry'))
  })

  // Each case as claude mcp list of Claude Code 2.1 showed it in a temp CLAUDE_CONFIG_DIR: Pending approval, a failed
  // health check of a server it ran (approved), or no line (disabled).
  test('--list shows a project server that Claude Code has not approved or has disabled, and --add needs --unapproved', async () => {
    const on = { enabledMcpjsonServers: ['alpha'] }
    const off = { disabledMcpjsonServers: ['alpha'] }
    const all = { enableAllProjectMcpServers: true }
    const none = { enableAllProjectMcpServers: false }
    const trust = { hasTrustDialogAccepted: true }
    type Case = { start?: string; projects?: Record<string, object>; files?: Record<string, object>; user?: object }
    const cases: [string, Case, string][] = [
      ['no choice', {}, 'not approved'],
      ['settings of the start folder, trusted', { projects: { '.': trust }, files: { '.': on } }, 'approved'],
      [
        'shared settings of the start folder, trusted',
        { projects: { '.': trust }, files: { '.:shared': on } },
        'approved',
      ],
      ['settings of the start folder, not trusted', { files: { '.': on } }, 'not approved'],
      [
        'settings of the root, start in a subfolder',
        { start: 'sub/deep', projects: { '.': trust }, files: { '.': on } },
        'not approved',
      ],
      [
        'settings of a subfolder start',
        { start: 'sub/deep', projects: { '.': trust }, files: { 'sub/deep': on } },
        'approved',
      ],
      [
        'trust on a folder between',
        { start: 'sub/deep', projects: { sub: trust }, files: { 'sub/deep': on } },
        'approved',
      ],
      ['trust above the project root', { projects: { '..': trust }, files: { '.': on } }, 'not approved'],
      ['list in .claude.json, trusted', { start: 'sub/deep', projects: { '.': { ...trust, ...on } } }, 'approved'],
      ['enable all in .claude.json, trusted', { projects: { '.': { ...trust, ...all } } }, 'approved'],
      [
        'list in .claude.json of the start folder',
        { start: 'sub/deep', projects: { 'sub/deep': { ...trust, ...on } } },
        'not approved',
      ],
      ['user settings', { user: on }, 'approved'],
      ['user settings, disabled in .claude.json', { user: all, projects: { '.': off } }, 'disabled'],
      ['user settings, disabled in the start folder', { user: on, files: { '.': off } }, 'disabled'],
      ['user settings, disabled in the shared settings', { user: all, files: { '.:shared': off } }, 'disabled'],
      [
        'enable all in .claude.json, disabled in the user settings',
        { user: off, projects: { '.': { ...trust, ...all } } },
        'disabled',
      ],
      // enableAllProjectMcpServers: the last file that sets it wins, in the order user, shared, local.
      ['user all, local none, trusted', { user: all, projects: { '.': trust }, files: { '.': none } }, 'not approved'],
      [
        'user all, shared none, trusted',
        { user: all, projects: { '.': trust }, files: { '.:shared': none } },
        'not approved',
      ],
      ['user none, local all, trusted', { user: none, projects: { '.': trust }, files: { '.': all } }, 'approved'],
      [
        'shared all, local none, trusted',
        { projects: { '.': trust }, files: { '.:shared': all, '.': none } },
        'not approved',
      ],
      [
        'shared none, local all, trusted',
        { projects: { '.': trust }, files: { '.:shared': none, '.': all } },
        'approved',
      ],
      ['user all, local none, not trusted', { user: all, files: { '.': none } }, 'approved'],
      ['user list, local none, trusted', { user: on, projects: { '.': trust }, files: { '.': none } }, 'approved'],
      // Claude Code moves true of the .claude.json entry into the local settings of the start folder, if they lack it.
      ['user all, none in .claude.json, trusted', { user: all, projects: { '.': { ...trust, ...none } } }, 'approved'],
      ['user none, all in .claude.json, trusted', { user: none, projects: { '.': { ...trust, ...all } } }, 'approved'],
      ['user none, all in .claude.json, not trusted', { user: none, projects: { '.': all } }, 'not approved'],
      [
        'all in .claude.json, local none',
        { projects: { '.': { ...trust, ...all } }, files: { '.': none } },
        'not approved',
      ],
      [
        'all in .claude.json, shared none',
        { projects: { '.': { ...trust, ...all } }, files: { '.:shared': none } },
        'approved',
      ],
      [
        'all in .claude.json, shared none of a subfolder start',
        { start: 'sub/deep', projects: { '.': { ...trust, ...all } }, files: { 'sub/deep:shared': none } },
        'approved',
      ],
      [
        'all in .claude.json, local none of a subfolder start',
        { start: 'sub/deep', projects: { '.': { ...trust, ...all } }, files: { 'sub/deep': none } },
        'not approved',
      ],
      [
        'user all, local none of the root, start in a subfolder',
        { start: 'sub/deep', user: all, projects: { '.': trust }, files: { '.': none } },
        'approved',
      ],
    ]
    for (const [label, c, approval] of cases) {
      const project = homeWith({ '.git/HEAD': '', '.mcp.json': { mcpServers: { alpha: { command: 'node' } } } })
      const at = (rel: string) => (rel === '..' ? path.dirname(project) : path.join(project, rel))
      for (const [where, settings] of Object.entries(c.files ?? {})) {
        const [rel = '.', shared] = where.split(':')
        const file = path.join(at(rel), '.claude', shared ? 'settings.json' : 'settings.local.json')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(settings))
      }
      const projects = Object.fromEntries(Object.entries(c.projects ?? {}).map(([rel, v]) => [at(rel), v]))
      const home = homeWith({
        '.claude.json': { projects },
        ...(c.user && { '.claude/settings.json': c.user }),
      })
      const start = at(c.start ?? '.')
      fs.mkdirSync(start, { recursive: true })
      const listed = await run(home, start, ['--list'], process.platform)
      const status = approval === 'approved' ? 'not in config' : `not in config, ${approval} in Claude Code`
      assert.match(listed.out, row('alpha', 'claude-code', 'project', 'stdio node', status), `${label}:\n${listed.out}`)

      const added = await run(home, start, ['--add', 'alpha'], process.platform)
      if (approval === 'approved') {
        assert.equal(added.code, 0, `${label}: ${added.out}`)
        continue
      }
      assert.equal(added.code, 1, `${label}: ${added.out}`)
      const mcpJson = path.join(project, '.mcp.json')
      assert.ok(
        added.out
          .split('\n')
          .includes(
            `alpha of ${mcpJson} is ${approval} in Claude Code for this folder. To add it anyway, add --unapproved.`,
          ),
        `${label}: ${added.out}`,
      )
      assert.ok(!fs.existsSync(added.file), label)
      const forced = await run(home, start, ['--add', 'alpha', '--unapproved'], process.platform)
      assert.equal(forced.code, 0, `${label}: ${forced.out}`)
    }
  })

  test('--add makes the config when there is none', async () => {
    const { home, project } = setup()
    const { code, out, file } = await run(home, project, ['--add', 'my notes'])
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      mcpServers: { 'my-notes': { command: 'node', args: ['notes.js'] } },
      policy: [],
    })
    assert.ok(!fs.existsSync(`${file}.bak`))
    assert.match(out, /Remove from "mcpServers": "my notes"/)
  })

  // Claude Code runs a name of several of its scopes from the first of local, project and user.
  test('--add takes a name of several Claude Code scopes from the scope that Claude Code runs, and says so', async () => {
    const project = homeWith({
      '.mcp.json': { mcpServers: { all: { command: 'all-project' }, pu: { command: 'pu-project' } } },
    })
    const home = homeWith({
      ...APPROVE_ALL,
      '.claude.json': {
        mcpServers: { all: { command: 'all-user' }, pu: { command: 'pu-user' }, lu: { command: 'lu-user' } },
        projects: { [project]: { mcpServers: { all: { command: 'all-local' }, lu: { command: 'lu-local' } } } },
      },
    })
    const listed = await run(home, project, ['--list'])
    for (const [name, scope, status] of [
      ['all', 'local', 'not in config'],
      ['all', 'project', 'not in config, hidden by local'],
      ['all', 'user', 'not in config, hidden by local'],
      ['pu', 'project', 'not in config'],
      ['pu', 'user', 'not in config, hidden by project'],
      ['lu', 'user', 'not in config, hidden by local'],
    ] as const)
      assert.match(listed.out, row(name, 'claude-code', scope, `stdio ${name}-${scope}`, status), listed.out)

    const { code, out, file } = await run(home, project, ['--add', 'all,pu,lu'])
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, {
      all: { command: 'all-local', cwd: project },
      pu: { command: 'pu-project', cwd: project },
      lu: { command: 'lu-local', cwd: project },
    })
    const lines = out.split('\n')
    for (const line of [
      '- all, from Claude Code (local scope)',
      `  Claude Code (project scope) in ${path.join(project, '.mcp.json')} also has all, which the local one hides.`,
      '  Claude Code (user scope) also has all, which the local one hides.',
      '- pu, from Claude Code (project scope)',
      '  Claude Code (user scope) also has pu, which the project one hides.',
      '- lu, from Claude Code (local scope)',
      '  Claude Code (user scope) also has lu, which the local one hides.',
    ])
      assert.ok(lines.includes(line), `missing line: ${line}\n\n${out}`)
    assert.ok(!lines.includes('  claude mcp remove all --scope user'), out)
  })

  // Each case as claude mcp get dup of Claude Code 2.1 showed it in a temp CLAUDE_CONFIG_DIR: it runs the user server
  // when the project one is not approved or disabled, and the local server in every case.
  test('a project server that is not approved hides no other scope, and --add takes the server that Claude Code runs', async () => {
    const skipped = (approval: string, runs: string) =>
      `not in config, ${approval} in Claude Code, Claude Code runs the ${runs} one`
    type Case = { choice?: object; local?: true; user?: true; far?: true }
    // The status of the server in each file, and the file that --add dup copies, or undefined when it refuses.
    const cases: [string, Case, Record<string, string>, string | undefined][] = [
      [
        'not approved, and a user server',
        { user: true },
        { project: skipped('not approved', 'user'), user: 'not in config' },
        'user',
      ],
      [
        'disabled, and a user server',
        { user: true, choice: { disabledMcpjsonServers: ['dup'] } },
        { project: skipped('disabled', 'user'), user: 'not in config' },
        'user',
      ],
      [
        'approved, and a user server',
        { user: true, choice: { enabledMcpjsonServers: ['dup'] } },
        { project: 'not in config', user: 'not in config, hidden by project' },
        'project',
      ],
      [
        'not approved, and a local and a user server',
        { local: true, user: true },
        { local: 'not in config', project: skipped('not approved', 'local'), user: 'not in config, hidden by local' },
        'local',
      ],
      [
        'approved, and a local server',
        { local: true, choice: { enabledMcpjsonServers: ['dup'] } },
        { local: 'not in config', project: 'not in config, hidden by local' },
        'local',
      ],
      [
        'not approved in two files, and a user server',
        { user: true, far: true },
        { project: skipped('not approved', 'user'), far: skipped('not approved', 'user'), user: 'not in config' },
        'user',
      ],
      [
        'not approved in two files',
        { far: true },
        {
          project: 'not in config, not approved in Claude Code',
          far: 'not in config, not approved in Claude Code, hidden by project',
        },
        undefined,
      ],
    ]
    for (const [label, c, statuses, added] of cases) {
      const top = homeWith({
        'proj/.git/HEAD': '',
        'proj/.mcp.json': { mcpServers: { dup: { command: 'dup-project' } } },
        ...(c.far && { '.mcp.json': { mcpServers: { dup: { command: 'dup-far' } } } }),
      })
      const project = path.join(top, 'proj')
      const home = homeWith({
        '.claude.json': {
          mcpServers: c.user ? { dup: { command: 'dup-user' } } : {},
          projects: {
            [project]: {
              hasTrustDialogAccepted: true,
              ...c.choice,
              ...(c.local && { mcpServers: { dup: { command: 'dup-local' } } }),
            },
          },
        },
      })
      const listed = await run(home, project, ['--list'], process.platform)
      const rows = listed.out.split('\n').filter(l => l.startsWith('dup '))
      assert.equal(rows.length, Object.keys(statuses).length, `${label}:\n${listed.out}`)
      for (const [file, status] of Object.entries(statuses)) {
        const scope = file === 'far' ? 'project' : file
        assert.match(
          listed.out,
          row('dup', 'claude-code', scope, `stdio dup-${file}`, status),
          `${label}:\n${listed.out}`,
        )
      }

      const entry = (from: string) => ({ command: `dup-${from}`, ...(from === 'user' ? {} : { cwd: project }) })
      for (const args of [
        ['--add', 'dup'],
        ['--add', 'dup', '--unapproved'],
      ]) {
        const result = await run(home, project, args, process.platform)
        if (added === undefined) {
          assert.equal(result.code, args.length === 2 ? 1 : 0, `${label}, ${args.join(' ')}: ${result.out}`)
          if (result.code === 0)
            assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')).mcpServers.dup, entry('project'))
        } else {
          assert.equal(result.code, 0, `${label}, ${args.join(' ')}: ${result.out}`)
          assert.deepEqual(JSON.parse(fs.readFileSync(result.file, 'utf8')).mcpServers.dup, entry(added), label)
        }
        fs.rmSync(result.file, { force: true })
      }
    }
  })

  test('--add of a project server that Claude Code skips for the user one copies the user one, unless --from picks it', async () => {
    const project = homeWith({ '.git/HEAD': '', '.mcp.json': { mcpServers: { dup: { command: 'dup-project' } } } })
    const home = homeWith({
      '.claude.json': {
        mcpServers: { dup: { command: 'dup-user' } },
        projects: { [project]: { hasTrustDialogAccepted: true } },
      },
    })
    const mcpJson = path.join(project, '.mcp.json')
    const added = await run(home, project, ['--add', 'dup'], process.platform)
    assert.equal(added.code, 0, added.out)
    const lines = added.out.split('\n')
    for (const line of [
      '- dup, from Claude Code (user scope)',
      `  Claude Code (project scope) in ${mcpJson} also has dup, which is not approved in Claude Code.`,
      '  claude mcp remove dup --scope user',
    ])
      assert.ok(lines.includes(line), `missing line: ${line}\n\n${added.out}`)
    assert.ok(!added.out.includes('--scope project'), added.out)
    fs.rmSync(added.file)

    const picked = ['--add', 'dup', '--from', 'claude-code:project']
    const refused = await run(home, project, picked, process.platform)
    assert.equal(refused.code, 1, refused.out)
    assert.ok(
      refused.out
        .split('\n')
        .includes(
          `dup of ${mcpJson} is not approved in Claude Code for this folder. To add it anyway, add --unapproved.`,
        ),
      refused.out,
    )
    const forced = await run(home, project, [...picked, '--unapproved'], process.platform)
    assert.equal(forced.code, 0, forced.out)
    assert.deepEqual(JSON.parse(fs.readFileSync(forced.file, 'utf8')).mcpServers, {
      dup: { command: 'dup-project', cwd: project },
    })
  })

  test('--from picks one of the different entries of a name', async () => {
    const { home, project } = setup()
    const { code, out, file } = await run(home, project, ['--add', 'gh', '--from', 'claude-code:user'])
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, { gh: { ...USER.gh } })
    assert.ok(
      out
        .split('\n')
        .map(l => l.trim())
        .includes('claude mcp remove gh --scope user'),
      out,
    )
  })

  test('--add=<name> adds a name that starts with a dash, which --add <name> reads as an option', async () => {
    const home = homeWith({ '.cursor/mcp.json': { mcpServers: { '-dash': { command: 'node' } } } })
    const split = await run(home, home, ['--add', '-dash'])
    assert.equal(split.code, 2, split.out)
    assert.match(split.out, /use '--add=-XYZ'/)
    unchanged(split.file, undefined)
    const joined = await run(home, home, ['--add=-dash'])
    assert.equal(joined.code, 0, joined.out)
    assert.deepEqual(JSON.parse(fs.readFileSync(joined.file, 'utf8')).mcpServers, { '-dash': { command: 'node' } })
  })

  test('--list ends with the command that adds each server that --add can take', async () => {
    const { home, project } = setup()
    const { code, out, file } = await run(home, project, ['--list'])
    assert.equal(code, 0, out)
    const [p, c] = [pathWord(project, 'linux'), pathWord(file, 'linux')]
    const npx = 'npx -y toolscript-mcp init'
    assert.deepEqual(out.split('\n').slice(out.split('\n').indexOf('Commands that add a server:')), [
      'Commands that add a server:',
      `- gh (claude-code:local): ${npx} --add=gh --from claude-code:local --project ${p} --config ${c}`,
      `- notes (claude-code:local): ${npx} --add=notes --project ${p} --config ${c}`,
      `- shared (claude-code:project): ${npx} --add=shared --project ${p} --config ${c}`,
      `- azure-devops (claude-code:project): ${npx} --add=azure-devops --project ${p} --config ${c}`,
      `- gh (claude-code:user): ${npx} --add=gh --from claude-code:user --project ${p} --config ${c}`,
      `- "my notes" (claude-desktop): ${npx} '--add=my notes' --config ${c}`,
      `- gh (claude-desktop): ${npx} --add=gh --from claude-desktop --project ${p} --config ${c}`,
      '',
    ])
  })

  test('--list marks a command with --unapproved to ask first, and says why a server gets no command', async () => {
    const top = homeWith({
      '.git/HEAD': '',
      '.mcp.json': { mcpServers: { dup: { command: 'far' } } },
      'near/.mcp.json': {
        mcpServers: {
          alpha: { command: 'node' },
          beta: { command: 'node' },
          'co,ma': { command: 'node' },
          dup: { command: 'near' },
        },
      },
    })
    const near = path.join(top, 'near')
    const home = homeWith({ '.claude/settings.json': { disabledMcpjsonServers: ['beta'] } })
    const { code, out, file } = await run(home, near, ['--list'], 'win32', { kind: 'node', main: 'C:\\t s\\main.js' })
    assert.equal(code, 0, out)
    const tail = `--project ${pathWord(near, 'win32')} --config ${pathWord(file, 'win32')}`
    const clone = 'node "C:/t s/main.js" init'
    assert.deepEqual(out.split('\n').slice(out.split('\n').indexOf('Commands that add a server:')), [
      'Commands that add a server:',
      `- alpha (claude-code:project, ask first: not approved in Claude Code): ${clone} --add=alpha --unapproved ${tail}`,
      `- beta (claude-code:project, ask first: disabled in Claude Code): ${clone} --add=beta --unapproved ${tail}`,
      '- co,ma (claude-code:project): no command, because --add splits a name at a comma and drops the spaces at its ends.',
      `- dup (claude-code:project, ask first: not approved in Claude Code): ${clone} --add=dup --unapproved ${tail}`,
      '- dup (claude-code:project): no command, because --add takes another copy of this name.',
      '',
    ])
  })

  test('--add refuses, exits 1 and writes nothing', async () => {
    const cases: [string, string[], unknown, RegExp][] = [
      [
        'a name in the config',
        ['--add', 'notes'],
        { ...OLD, mcpServers: { notes: { command: 'x' } } },
        /^notes is in the config already/m,
      ],
      ['a name in no client file', ['--add', 'nope'], OLD, /^nope is in no client file/m],
      [
        'a name with different entries in two clients',
        ['--add', 'gh'],
        OLD,
        /^gh has different entries in claude-code:local, claude-desktop\. Pick one with --from/m,
      ],
      [
        'a name not in the --from client',
        ['--add', 'gh', '--from', 'cursor'],
        OLD,
        /^gh is in no client file of cursor/m,
      ],
      [
        'toolscript itself',
        ['--add', 'toolscript'],
        OLD,
        /^toolscript cannot be added: claude-code:user: toolscript itself/m,
      ],
      [
        'a config that is not valid',
        ['--add', 'shared'],
        '{ "mcpServers": [] }',
        /is not a valid config: "mcpServers" is not an object/,
      ],
      ['a config that is not JSON', ['--add', 'shared'], '{ nope', /is not a valid config: not valid JSON/],
    ]
    for (const [label, args, config, error] of cases) {
      const { home, project } = setup(undefined, config)
      const file = path.join(home, '.config', 'toolscript-mcp', 'config.json')
      const before = fs.readFileSync(file, 'utf8')
      const { code, out } = await run(home, project, args)
      assert.equal(code, 1, `${label}: ${out}`)
      assert.match(out, error, label)
      unchanged(file, before)
    }
  })

  test('--list and --add refuse the options of an import', async () => {
    const { home, project } = setup()
    for (const args of [
      ['--list', '--force'],
      ['--add', 'gh', '--dry-run'],
      ['--list', '--add', 'gh'],
      ['--list', '--from', 'cursor'],
      ['--list', '--unapproved'],
      ['--add', 'gh', '--from', 'vscode'],
    ]) {
      const { code, out, file } = await run(home, project, args)
      assert.equal(code, 2, `${args.join(' ')}: ${out}`)
      assert.match(out, /usage: toolscript-mcp init/)
      unchanged(file, undefined)
    }
    const { code } = await init(home, ['--project', project])
    assert.equal(code, 2)
  })
})
