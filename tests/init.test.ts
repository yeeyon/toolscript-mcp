import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../src/core/config.ts'
import { clientFiles, importServers, initReport, shellWord } from '../src/core/init.ts'
import { runInit } from '../src/host/init.ts'

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

const init = async (home: string, args: string[] = [], platform = 'linux') => {
  let out = ''
  const env = { XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, '.config') }
  const code = await runInit(args, env, platform, home, text => (out += `${text}\n`))
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
    assert.match(out, /my-notes.*"my notes".*cwd/)
    assert.doesNotMatch(out, /project_only/)
    assert.match(out, /"policy"/)
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
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json'])
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
    assert.doesNotMatch(out, /secret/)
    assert.match(out, /"https:\/\/\*\*\*@example\.com\/mcp"/)
    assert.match(out, /"--db=postgres:\/\/\*\*\*@db\.example\.com\/x"/)
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
        `claude mcp add --scope user toolscript '--' cmd /c npx -y toolscript-mcp --config ${shellWord(file, 'win32')}`,
      ),
      out,
    )
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
    const run = ['-y', 'toolscript-mcp', '--config', config]
    assert.deepEqual(argv, [
      ['mcp', 'remove', NAME, '--scope', 'user'],
      ['mcp', 'add', '--scope', 'user', 'toolscript', '--', 'cmd', '/c', 'npx', ...run],
    ])
    assert.match(text, /Claude Code, in PowerShell:/)
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
