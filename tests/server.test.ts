import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEPTH_VAR,
  childEnv,
  configPath,
  hideArgSecrets,
  hideClientSecret,
  hideUrlSecrets,
  nestedStart,
  parseConfig,
  policyOf,
  redact,
  serverKey,
  type Config,
  type ServerKey,
  type StdioServer,
} from '../src/core/config.ts'
import { argsText, catalogOf, searchResult, toolName, type ServerState } from '../src/core/catalog.ts'
import { splitToolName } from '../src/core/protocol.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { connectAll } from '../src/host/downstream.ts'
import { createServer } from '../src/host/server.ts'

const NODE = '/usr/bin/node'
const ok = (value: unknown, env: Record<string, string> = {}, platform = 'linux'): Config => {
  const parsed = parseConfig(JSON.stringify(value), env, NODE, platform)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
  return parsed.config
}
const errors = (text: string, env: Record<string, string> = {}, platform = 'linux'): string[] => {
  const parsed = parseConfig(text, env, NODE, platform)
  assert.equal(parsed.ok, false)
  return parsed.ok ? [] : parsed.errors
}
const key = (k: string) => serverKey(k)!

describe('the config', () => {
  test('reads stdio and http servers in the mcpServers shape', () => {
    const config = ok({
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'server-files'], env: { ROOT: '/data' } },
        bare: { type: 'stdio', command: 'fake' },
        web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'a' } },
      },
    })
    assert.deepEqual(Object.fromEntries(config.servers), {
      files: { kind: 'stdio', command: 'npx', args: ['-y', 'server-files'], env: { ROOT: '/data' } },
      bare: { kind: 'stdio', command: 'fake', args: [], env: {} },
      web: { kind: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'a' } },
    })
    assert.equal(config.sandbox.node, NODE)
  })

  test('sandbox.node overrides the Node of the sandbox', () => {
    assert.equal(ok({ mcpServers: {}, sandbox: { node: '/opt/node22/bin/node' } }).sandbox.node, '/opt/node22/bin/node')
  })

  test('expands ${VAR} in args, env, url and headers, but not in command', () => {
    const env = { TOKEN: 'fake-token', HOST: 'mcp.example.com', DIR: '/data' }
    const config = ok(
      {
        mcpServers: {
          s: { command: '${DIR}/bin', args: ['--root=${DIR}'], env: { T: 'Bearer ${TOKEN}' } },
          h: { type: 'http', url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
        },
      },
      env,
    )
    assert.deepEqual(config.servers.get(key('s')), {
      kind: 'stdio',
      command: '${DIR}/bin',
      args: ['--root=/data'],
      env: { T: 'Bearer fake-token' },
    })
    assert.deepEqual(config.servers.get(key('h')), {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer fake-token' },
    })
  })

  test('a stdio entry takes an absolute cwd, with ${VAR} expanded', () => {
    const linux = ok(
      { mcpServers: { a: { command: 'x', cwd: '/srv/my app' }, b: { command: 'x', cwd: '${WORK}/app' } } },
      { WORK: '/work' },
    )
    assert.deepEqual(linux.servers.get(key('a')), {
      kind: 'stdio',
      command: 'x',
      args: [],
      env: {},
      cwd: '/srv/my app',
    })
    assert.equal((linux.servers.get(key('b')) as StdioServer).cwd, '/work/app')
    const windows = ok(
      {
        mcpServers: {
          a: { command: 'x', cwd: 'C:\\work\\my app' },
          b: { command: 'x', cwd: 'c:/work' },
          c: { command: 'x', cwd: '\\\\server\\share\\app' },
        },
      },
      {},
      'win32',
    )
    assert.deepEqual(
      [...windows.servers.values()].map(s => (s as StdioServer).cwd),
      ['C:\\work\\my app', 'c:/work', '\\\\server\\share\\app'],
    )
  })

  test('a cwd that is not an absolute path fails only its entry', () => {
    const invalid = (...errors: string[]) => ({ kind: 'invalid', errors })
    const linux = ok({
      mcpServers: {
        rel: { command: 'x', cwd: 'app' },
        home: { command: 'x', cwd: '~/app' },
        drive: { command: 'x', cwd: 'C:/work' },
        empty: { command: 'x', cwd: '' },
        num: { command: 'x', cwd: 1 },
        unset: { command: 'x', cwd: '${NOPE}/app' },
        good: { command: 'x' },
      },
    })
    const posix = (name: string, value: string) =>
      invalid(`mcpServers.${name}.cwd: must be an absolute path, such as "/home/me/app", not ${JSON.stringify(value)}`)
    assert.deepEqual(Object.fromEntries(linux.servers), {
      rel: posix('rel', 'app'),
      home: posix('home', '~/app'),
      drive: posix('drive', 'C:/work'),
      empty: invalid('mcpServers.empty.cwd: must be a non-empty string'),
      num: invalid('mcpServers.num.cwd: must be a non-empty string'),
      unset: invalid('mcpServers.unset.cwd: the environment variable NOPE is not set'),
      good: { kind: 'stdio', command: 'x', args: [], env: {} },
    })
    const windows = ok(
      {
        mcpServers: {
          root: { command: 'x', cwd: '/srv' },
          drive: { command: 'x', cwd: 'C:work' },
          rel: { command: 'x', cwd: 'work\\app' },
        },
      },
      {},
      'win32',
    )
    const win = (name: string, value: string) =>
      invalid(
        `mcpServers.${name}.cwd: must be an absolute path with a drive letter or a share, such as "C:/work/app", not ${JSON.stringify(value)}`,
      )
    assert.deepEqual(Object.fromEntries(windows.servers), {
      root: win('root', '/srv'),
      drive: win('drive', 'C:work'),
      rel: win('rel', 'work\\app'),
    })
  })

  test('a variable that is not set is an error that names the variable and the key, never a value', () => {
    const config = ok(
      { mcpServers: { gh: { command: 'gh-mcp', env: { TOKEN: '${GITHUB_TOKEN}', OTHER: '${SET_ONE}' } } } },
      { SET_ONE: 'fake-secret-value' },
    )
    const gh = config.servers.get(key('gh'))
    assert.deepEqual(gh, {
      kind: 'invalid',
      errors: ['mcpServers.gh.env.TOKEN: the environment variable GITHUB_TOKEN is not set'],
    })
    assert.ok(!JSON.stringify(gh).includes('fake-secret-value'))
  })

  test('only ${NAME} expands: no inherited names, and other ${...} forms are errors', () => {
    const config = ok({
      mcpServers: { s: { command: 'x', args: ['${constructor}', '${TOKEN:-none}', '${}', '$HOME'] } },
    })
    assert.deepEqual(config.servers.get(key('s')), {
      kind: 'invalid',
      errors: [
        'mcpServers.s.args[0]: the environment variable constructor is not set',
        'mcpServers.s.args[1]: ${TOKEN:-none} is not a variable: write ${NAME} with letters, digits and underscores',
        'mcpServers.s.args[2]: ${} is not a variable: write ${NAME} with letters, digits and underscores',
      ],
    })
  })

  test('an env key named __proto__ stays a plain key', () => {
    const config = ok({ mcpServers: { s: { command: 'x', env: JSON.parse('{"__proto__": "v", "A": "b"}') } } })
    const server = config.servers.get(key('s')) as StdioServer
    assert.deepEqual(Object.keys(server.env), ['__proto__', 'A'])
  })

  test('invalid JSON names where, not the text near it', () => {
    const [error] = errors('{"mcpServers": {"s": {"command": "x", "env": {"T": fake-secret}}}}')
    assert.match(error!, /^the config is not valid JSON/)
    assert.ok(!error!.includes('fake-secret'), error)
  })

  test('a bad server entry fails alone, with errors that point to the bad key', () => {
    const config = ok({
      mcpServers: {
        a: { command: '', args: 'x' },
        good: { command: 'fake' },
        b: { type: 'sse', url: 'https://x' },
        c: { type: 'http', url: 'ftp://x', header: {} },
        d: { command: 'x', args: [1], env: { N: 2 } },
        e: 'npx server',
      },
    })
    const invalid = (...errors: string[]) => ({ kind: 'invalid', errors })
    assert.deepEqual(Object.fromEntries(config.servers), {
      a: invalid('mcpServers.a.command: must be a non-empty string', 'mcpServers.a.args: must be an array of strings'),
      good: { kind: 'stdio', command: 'fake', args: [], env: {} },
      b: invalid('mcpServers.b.type: must be "stdio" or "http", not "sse"'),
      c: invalid(
        'mcpServers.c.header: unknown key (known: type, url, headers, oauth, sigv4, untrusted)',
        'mcpServers.c.url: must start with http:// or https://',
      ),
      d: invalid('mcpServers.d.args[0]: must be a string', 'mcpServers.d.env.N: must be a string'),
      e: invalid('mcpServers.e: must be an object'),
    })
  })

  test('"untrusted": true marks a stdio or http server, false is the default, and another value fails the entry', () => {
    const config = ok({
      mcpServers: {
        ado: { command: 'npx', args: ['-y', '@azure-devops/mcp', 'fake'], untrusted: true },
        web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'a' }, untrusted: true },
        plain: { command: 'fake', untrusted: false },
        bad: { command: 'fake', untrusted: 'yes' },
      },
    })
    assert.deepEqual(Object.fromEntries(config.servers), {
      ado: { kind: 'stdio', command: 'npx', args: ['-y', '@azure-devops/mcp', 'fake'], env: {}, untrusted: true },
      web: { kind: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'a' }, untrusted: true },
      plain: { kind: 'stdio', command: 'fake', args: [], env: {} },
      bad: { kind: 'invalid', errors: ['mcpServers.bad.untrusted: must be true or false'] },
    })
  })

  test('a url that does not parse is an error that names the key, never the value', () => {
    const config = ok(
      {
        mcpServers: {
          a: { type: 'http', url: 'http://' },
          b: { type: 'http', url: '${BAD_URL}' },
          c: { type: 'http', url: 'https://${UNSET}/mcp' },
        },
      },
      { BAD_URL: 'https://[fake-secret-value]/mcp' },
    )
    assert.deepEqual(Object.fromEntries(config.servers), {
      a: { kind: 'invalid', errors: ['mcpServers.a.url: must be a valid URL'] },
      b: { kind: 'invalid', errors: ['mcpServers.b.url: must be a valid URL'] },
      c: { kind: 'invalid', errors: ['mcpServers.c.url: the environment variable UNSET is not set'] },
    })
    assert.ok(!JSON.stringify(Object.fromEntries(config.servers)).includes('fake-secret-value'))
  })

  test('an error outside the server entries stops the start, and names the bad key', () => {
    const text = JSON.stringify({ mcpServers: { a: { command: '' } }, sandbox: { node: 3 }, extra: true })
    assert.deepEqual(errors(text), [
      'config.extra: unknown key (known: $schema, mcpServers, sandbox, policy, log, share, workspace)',
      'sandbox.node: must be a non-empty string',
    ])
    assert.match(errors('{"mcpServers": ')[0]!, /^the config is not valid JSON/)
    assert.deepEqual(errors('[]'), ['the config must be a JSON object with an mcpServers object'])
    assert.deepEqual(errors('{}'), ['mcpServers: must be an object'])
  })

  test('an http server without headers logs in with OAuth, and "oauth" sets the client, scopes and port', () => {
    const config = ok(
      {
        mcpServers: {
          bare: { type: 'http', url: 'https://mcp.example.com/mcp' },
          off: { type: 'http', url: 'https://mcp.example.com/mcp', oauth: false },
          token: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
          team: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'a' }, oauth: true },
          google: {
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            oauth: {
              clientId: 'fake-id.example.com',
              clientSecret: '${SECRET}',
              scopes: ['openid', 'email'],
              callbackPort: 8765,
            },
          },
        },
      },
      { SECRET: 'fake-client-secret-1' },
    )
    const url = 'https://mcp.example.com/mcp'
    assert.deepEqual(Object.fromEntries(config.servers), {
      bare: { kind: 'http', url, headers: {}, oauth: { scopes: [] } },
      off: { kind: 'http', url, headers: {} },
      token: { kind: 'http', url, headers: { Authorization: 'Bearer x' } },
      team: { kind: 'http', url, headers: { 'X-Team': 'a' }, oauth: { scopes: [] } },
      google: {
        kind: 'http',
        url,
        headers: {},
        oauth: {
          client: { id: 'fake-id.example.com', secret: 'fake-client-secret-1' },
          scopes: ['openid', 'email'],
          callbackPort: 8765,
        },
      },
    })
  })

  test('a bad oauth entry fails that server alone, and names the key', () => {
    const url = 'https://mcp.example.com/mcp'
    const config = ok({
      mcpServers: {
        a: { type: 'http', url, oauth: 'yes' },
        b: { type: 'http', url, oauth: { clientSecret: 'fake-secret-value', scopes: 'x', callbackPort: 70000 } },
        c: { type: 'http', url, oauth: { clientId: '', extra: 1, scopes: ['a b'], callbackPort: 1.5 } },
        d: { type: 'http', url, headers: { authorization: 'Bearer x' }, oauth: true },
        e: { type: 'http', url, oauth: { clientId: 'x', clientSecret: '${UNSET}' } },
        f: { type: 'http', url, oauth: { clientId: 'x', clientSecret: '' } },
        good: { type: 'http', url, oauth: {} },
      },
    })
    const invalid = (...errors: string[]) => ({ kind: 'invalid', errors })
    assert.deepEqual(Object.fromEntries(config.servers), {
      a: invalid('mcpServers.a.oauth: must be true, false or an object'),
      b: invalid(
        'mcpServers.b.oauth.clientSecret: needs clientId',
        'mcpServers.b.oauth.scopes: must be an array of scope names without spaces',
        'mcpServers.b.oauth.callbackPort: must be a whole number from 1 to 65535',
      ),
      c: invalid(
        'mcpServers.c.oauth.extra: unknown key (known: clientId, clientSecret, scopes, callbackPort)',
        'mcpServers.c.oauth.clientId: must be a non-empty string',
        'mcpServers.c.oauth.scopes: must be an array of scope names without spaces',
        'mcpServers.c.oauth.callbackPort: must be a whole number from 1 to 65535',
      ),
      d: invalid('mcpServers.d.oauth: an entry with an Authorization header does not log in: remove one of them'),
      e: invalid('mcpServers.e.oauth.clientSecret: the environment variable UNSET is not set'),
      f: invalid('mcpServers.f.oauth.clientSecret: must be a non-empty string'),
      good: { kind: 'http', url, headers: {}, oauth: { scopes: [] } },
    })
    const empty = ok(
      { mcpServers: { g: { type: 'http', url, oauth: { clientId: 'x', clientSecret: '${E}' } } } },
      { E: '' },
    )
    assert.deepEqual(
      empty.servers.get('g' as ServerKey),
      invalid('mcpServers.g.oauth.clientSecret: must be a non-empty string'),
    )
    assert.ok(!JSON.stringify(Object.fromEntries(config.servers)).includes('fake-secret-value'))
  })

  test('a server key that breaks mcp__<key>__<tool> is refused at parse', () => {
    const bad = ['a__b', 'a_', '_a', '', 'my server', 'claude.ai', 'a/b']
    const found = errors(JSON.stringify({ mcpServers: Object.fromEntries(bad.map(k => [k, { command: 'x' }])) }))
    assert.equal(found.length, bad.length)
    assert.match(found[0]!, /^mcpServers\["a__b"\]: a server key must be letters, digits and hyphens/)
    assert.match(found[4]!, /^mcpServers\["my server"\]: /)
  })
})

describe('the share keys', () => {
  const stdio = (extra: object) => ({ mcpServers: { a: { command: 'fake', ...extra } } })
  const entry = (config: Config) => config.servers.get(key('a'))

  test('a stdio entry takes true, false and "folder" as written, and nothing else', () => {
    for (const share of [true, false, 'folder'] as const)
      assert.deepEqual(entry(ok(stdio({ share }))), { kind: 'stdio', command: 'fake', args: [], env: {}, share })
    assert.equal((entry(ok(stdio({}))) as StdioServer).share, undefined)
    for (const share of ['yes', 'shared', 1, null, [], {}])
      assert.deepEqual(entry(ok(stdio({ share }))), {
        kind: 'invalid',
        errors: ['mcpServers.a.share: must be true, false or "folder"'],
      })
  })

  test('a bad entry share makes only that entry invalid', () => {
    const config = ok({ mcpServers: { a: { command: 'x', share: 'no' }, b: { command: 'y', share: true } } })
    assert.equal(config.servers.get(key('a'))!.kind, 'invalid')
    assert.equal(config.servers.get(key('b'))!.kind, 'stdio')
  })

  test('a bridge takes false, and refuses true and "folder", for its own entry only', () => {
    const bridge = (share?: unknown) => ({
      command: 'claude',
      args: ['mcp', 'serve'],
      ...(share !== undefined && { share }),
    })
    const config = ok({
      mcpServers: {
        'claude-code': bridge(true),
        other: bridge('folder'),
        third: bridge(false),
        fourth: bridge(),
        fine: { command: 'x' },
      },
    })
    const refusal = (k: string) => ({
      kind: 'invalid',
      errors: [`mcpServers.${k}.share: a Claude Code bridge is never shared: remove "share" or set it to false`],
    })
    assert.deepEqual(config.servers.get(key('claude-code')), refusal('claude-code'))
    assert.deepEqual(config.servers.get(key('other')), refusal('other'))
    assert.equal(config.servers.get(key('third'))!.kind, 'stdio')
    assert.equal(config.servers.get(key('fourth'))!.kind, 'stdio')
    assert.equal(config.servers.get(key('fine'))!.kind, 'stdio')
    assert.ok(config.bridges.has(key('claude-code')) && config.bridges.has(key('other')))
  })

  test('an HTTP entry keeps share as an unknown key', () => {
    const config = ok({ mcpServers: { a: { type: 'http', url: 'https://mcp.example.com/mcp', share: true } } })
    assert.deepEqual(entry(config), {
      kind: 'invalid',
      errors: ['mcpServers.a.share: unknown key (known: type, url, headers, oauth, sigv4, untrusted)'],
    })
  })

  test('the top-level key takes true and false, else the start stops', () => {
    assert.equal(ok({ mcpServers: {}, share: true }).share.on, true)
    assert.equal(ok({ mcpServers: {}, share: false }).share.on, false)
    for (const share of ['true', 1, null, {}])
      assert.deepEqual(errors(JSON.stringify({ mcpServers: {}, share })), ['share: must be true or false'])
  })

  test('the switch is TOOLSCRIPT_SHARE, else the top-level key, else off', () => {
    const sw = (value: unknown, env: Record<string, string> = {}) => ok({ mcpServers: {}, share: value }, env).share
    assert.deepEqual(sw(undefined), { on: false, source: 'default' })
    assert.deepEqual(sw(true), { on: true, source: 'config' })
    assert.deepEqual(sw(false), { on: false, source: 'config' })
    assert.deepEqual(sw(false, { TOOLSCRIPT_SHARE: '1' }), { on: true, source: 'env' })
    assert.deepEqual(sw(true, { TOOLSCRIPT_SHARE: '0' }), { on: false, source: 'env' })
    assert.deepEqual(sw(undefined, { TOOLSCRIPT_SHARE: '1' }), { on: true, source: 'env' })
    assert.deepEqual(sw(true, { TOOLSCRIPT_SHARE: '' }), { on: true, source: 'config' })
  })

  test('a bad TOOLSCRIPT_SHARE stops the start and its text never repeats the value', () => {
    for (const bad of ['2', 'true', 'fake-secret-value', ' 1'])
      assert.deepEqual(errors('{"mcpServers": {}}', { TOOLSCRIPT_SHARE: bad }), ['TOOLSCRIPT_SHARE: must be 0 or 1'])
  })

  test('the keys change nothing else: no share key, no change in the entries', () => {
    const config = ok({ mcpServers: { a: { command: 'fake' } } })
    assert.deepEqual(Object.fromEntries(config.servers), { a: { kind: 'stdio', command: 'fake', args: [], env: {} } })
  })
})

describe('tool names', () => {
  test('every key the config accepts splits back out of mcp__<key>__<tool>', () => {
    const candidates = ['bench', 'my-server', 'a_b', 'a_b_c', 'A1', '1', 'a__b', 'a_', '_a', 'a-_b', 'x y', '']
    for (const k of candidates) {
      const sk = serverKey(k)
      if (sk === undefined) continue
      for (const tool of ['list', 'get_issue', 'a__b', '_x'])
        assert.deepEqual(splitToolName(toolName(sk, tool)), { server: k, name: tool }, `${k} / ${tool}`)
    }
    assert.deepEqual(
      candidates.filter(k => serverKey(k) !== undefined),
      ['bench', 'my-server', 'a_b', 'a_b_c', 'A1', '1', 'a-_b'],
    )
  })
})

describe('the self-loop guard', () => {
  const server: StdioServer = { kind: 'stdio', command: 'x', args: [], env: { [DEPTH_VAR]: '', A: 'b' } }

  test('a stdio child gets the marker, and the config cannot unset it in any letter case', () => {
    assert.deepEqual(childEnv(server), { A: 'b', [DEPTH_VAR]: '1' })
    const lower = { ...server, env: { toolscript_mcp_depth: '', A: 'b' } }
    assert.deepEqual(childEnv(lower), { A: 'b', [DEPTH_VAR]: '1' })
  })

  test('a start with the marker is refused, a start without it is not', () => {
    assert.match(nestedStart(childEnv(server)) ?? '', /refused to start, because TOOLSCRIPT_MCP_DEPTH is set/)
    assert.equal(nestedStart({}), undefined)
    assert.equal(nestedStart({ [DEPTH_VAR]: '' }), undefined)
  })
})

describe('redact', () => {
  test('hides the env and header values of a server, and the long words in them', () => {
    const stdio: StdioServer = { kind: 'stdio', command: 'x', args: [], env: { T: 'fake-token-123', N: '1' } }
    assert.equal(redact('auth failed for fake-token-123 at 1', stdio), 'auth failed for *** at 1')
    const http = { kind: 'http', url: 'https://x', headers: { Authorization: 'Bearer fake-token-456' } } as const
    assert.equal(redact('bad token fake-token-456', http), 'bad token ***')
    assert.equal(redact('got Bearer fake-token-456', http), 'got ***')
    const meta = {
      kind: 'http',
      url: 'https://x',
      headers: {},
      sigv4: { profile: 'p', region: 'us-east-1', service: 's', metadata: { X_TOKEN: 'fake-meta-789' } },
    } as const
    assert.equal(redact('echo fake-meta-789 refused', meta), 'echo *** refused')
  })

  test('hides the secrets in the args and the URL of a server, and keeps the other args', () => {
    const args = [
      '--api-key',
      'fake-arg-secret-1',
      '--token=fake-arg-secret-2',
      'https://h.example.com/s/fakeArgSecretPath0123/mcp?k=fake-arg-secret-3#fake-arg-secret-4',
      '--header',
      'Authorization: Bearer fake-arg-secret-5',
      '/srv/data/notes',
    ]
    const stdio: StdioServer = { kind: 'stdio', command: 'x', args, env: {} }
    assert.equal(
      redact(
        'bad key fake-arg-secret-1, fake-arg-secret-2, fakeArgSecretPath0123, fake-arg-secret-3, fake-arg-secret-4, fake-arg-secret-5 in /srv/data/notes',
        stdio,
      ),
      'bad key ***, ***, ***, ***, ***, *** in /srv/data/notes',
    )
    const http = { kind: 'http', url: 'https://h.example.com/s/fakeUrlSecretPath0123/mcp', headers: {} } as const
    assert.equal(redact('404 for /s/fakeUrlSecretPath0123/mcp', http), '404 for /s/***/mcp')
  })

  test('hides a secret flag value that starts with a hyphen, and keeps the next flag', () => {
    assert.deepEqual(hideArgSecrets(['--password', '-fake-pass-1', '--no-auth', '--port', '8080']).args, [
      '--password',
      '***',
      '--no-auth',
      '--port',
      '8080',
    ])
    const stdio: StdioServer = { kind: 'stdio', command: 'x', args: ['--password', '-fake-pass-1'], env: {} }
    assert.equal(redact('denied: -fake-pass-1', stdio), 'denied: ***')
  })

  test('hides the OAuth client secret of a server', () => {
    const http = {
      kind: 'http',
      url: 'https://x',
      headers: {},
      oauth: { client: { id: 'fake-id', secret: 'fake-client-secret-2' }, scopes: [] },
    } as const
    assert.equal(redact('invalid_client: fake-client-secret-2', http), 'invalid_client: ***')
  })

  test('hides a client secret that an error echoes in lowercase percent-encoding or inside a JSON string', () => {
    const http = {
      kind: 'http',
      url: 'https://x',
      headers: {},
      oauth: { client: { id: 'fake-id', secret: '/fake"se\\cret+==' }, scopes: [] },
    } as const
    assert.equal(redact('bad client_secret=%2ffake%22se%5ccret%2b%3d%3d', http), 'bad client_secret=***')
    assert.equal(redact('{"client_secret":"/fake\\"se\\\\cret+=="}', http), '{"client_secret":"***"}')
  })

  test('hideClientSecret hides a short client secret only where it stands as the secret', () => {
    for (const registered of [false, true]) {
      const client = { id: 'fake-id', secret: 'login', registered }
      const basic = btoa('fake-id:login')
      assert.equal(
        hideClientSecret(
          `login failed: client_secret=login&a=1, {"client_secret": "lo\\"gin"}, Basic ${basic}`,
          client,
        ),
        'login failed: client_secret=***&a=1, {"client_secret": "***"}, Basic ***',
        `registered ${registered}`,
      )
    }
    const config = { id: 'fake-id', secret: 'login', registered: false }
    assert.equal(hideClientSecret('login failed for fake-id:login', config), 'login failed for fake-id:***')
    const registered = { id: 'fake-id', secret: 'fake-sec', registered: true }
    assert.equal(hideClientSecret('login failed for fake-id:fake-sec', registered), 'login failed for fake-id:***')
    assert.equal(hideClientSecret('client_secret=12 and 12', undefined), 'client_secret=*** and 12')
  })

  test('a secret from a server hides none of its forms under 8 characters, so the server cannot blank a word', () => {
    const http = { kind: 'http', url: 'https://x', headers: {} } as const
    const text = 'the OAuth login to https://as.example.com failed: invalid login'
    for (const secret of ['login', '%6c%6f%67%69%6e', '%20to%20', '%4fAuth%20']) {
      assert.equal(redact(text, http, [secret]), text, secret)
    }
    assert.equal(redact('bad token fake-token-7 or %66ake-token-7', http, ['%66ake-token-7']), 'bad token *** or ***')
  })

  test('a secret from a server under 8 characters hides none of its longer encoded forms either', () => {
    const http = { kind: 'http', url: 'https://x', headers: {} } as const
    const text = 'invalid redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback for a%20%20%20b'
    for (const secret of ['://', '   ', '/:/']) {
      assert.equal(redact(text, http, [secret]), text, JSON.stringify(secret))
    }
  })

  test('a secret or client with a lone surrogate hides like any other and throws nothing', () => {
    const http = { kind: 'http', url: 'https://x', headers: {} } as const
    assert.equal(redact('bad token \ud800fake-token', http, ['\ud800fake-token']), 'bad token ***')
    assert.equal(redact('the login failed', http, ['\ud800']), 'the login failed')
    const client = { id: 'fake-id', secret: '\ud800abcd', registered: false }
    assert.equal(hideClientSecret('bad pair fake-id:\ud800abcd', client), 'bad pair fake-id:***')
  })

  test('hideClientSecret prints a client id with a $ pattern as it is', () => {
    for (const id of ['a$&b', "a$'b", 'a$`b']) {
      const text = `bad credentials ${id}:pass1 here`
      const client = { id, secret: 'pass1', registered: false }
      assert.equal(hideClientSecret(text, client), `bad credentials ${id}:*** here`, id)
    }
  })

  test('hideClientSecret blanks no text with an id:secret pair that a common text can hold', () => {
    const text =
      'the OAuth login to https://as.example.com failed: error: invalid login, redirect http://127.0.0.1:5000'
    for (const client of [
      { id: 'https', secret: '//', registered: false },
      { id: 'https', secret: '//////', registered: false },
      { id: 'error', secret: ' ', registered: false },
      { id: 'failed', secret: ' er', registered: false },
      { id: '', secret: ' error', registered: false },
      // A server that registers the client picks both the id and the secret.
      { id: 'failed', secret: ' error', registered: true },
      { id: 'https', secret: '//as.', registered: true },
      { id: 'http', secret: '//127', registered: true },
    ]) {
      assert.equal(hideClientSecret(text, client), text, JSON.stringify(client))
    }
  })

  test('hideClientSecret hides a form secret with a space, and the encoded pairs and their Basic values', () => {
    const client = { id: 'fake id', secret: 'ab+c d', registered: false }
    assert.equal(hideClientSecret('echo client_secret=ab+c d&x=1', client), 'echo client_secret=***&x=1')
    const pair = `${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`
    assert.equal(hideClientSecret(`echo ${pair} / Basic ${btoa(pair)}`, client), 'echo fake%20id:*** / Basic ***')
    const form = 'fake+id:ab%2Bc+d'
    assert.equal(hideClientSecret(`echo ${form} / Basic ${btoa(form)}`, client), 'echo fake+id:*** / Basic ***')
  })

  test('hides the password of a URL also when it shows without the user', () => {
    const http = { kind: 'http', url: 'https://fake-user:fake-password-2@example.com/mcp', headers: {} } as const
    assert.equal(redact('authentication failed: fake-password-2', http), 'authentication failed: ***')
  })
})

describe('the secrets of a server', () => {
  const stdio = (args: string[], env: Record<string, string> = {}): StdioServer => ({
    kind: 'stdio',
    command: 'x',
    args,
    env,
  })
  const http = (url: string, headers: Record<string, string> = {}) => ({ kind: 'http', url, headers }) as const
  const fetchError = async (url: string): Promise<string> => {
    try {
      await fetch(new URL(url))
      return ''
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  test('a URL password with a space, or with characters that the URL encodes, is hidden', async () => {
    for (const password of ['fake pass w0rd', 'fa^ke|pass{1}']) {
      const url = `https://fake-user:${password}@h.example/mcp`
      assert.equal(hideUrlSecrets(url).url, 'https://***@h.example/mcp')
      // Node fetch refuses a URL with credentials and names the URL, encoded.
      const reason = await fetchError(url)
      assert.match(reason, /includes credentials/)
      assert.equal(
        redact(reason, http(url)),
        'Request cannot be constructed from a URL that includes credentials: https://***@h.example/mcp',
      )
      assert.equal(redact(`denied: ${password}`, http(url)), 'denied: ***')
    }
  })

  test('the user and password of any URL in a reason are hidden', () => {
    const reason = 'GET https://fake-other:fake-other-pw@h.example/x failed, and ws://a@b.example/ too'
    assert.equal(
      redact(reason, http('https://h.example/mcp')),
      'GET https://***@h.example/x failed, and ws://***@b.example/ too',
    )
  })

  test('a secret inside an argument of several words is hidden, and the other words stay', () => {
    const token = `ghp_fake${'0'.repeat(32)}`
    const script = ['-c', `export GITHUB_TOKEN=${token}; npx fake-server --api-key sk-fake-12345`]
    assert.deepEqual(hideArgSecrets(script).args, ['-c', 'export GITHUB_TOKEN=***; npx fake-server --api-key ***'])
    const echoed = `fake-server exited: ${script.join(' ')}`
    assert.equal(
      redact(echoed, stdio(script)),
      'fake-server exited: -c export GITHUB_TOKEN=***; npx fake-server --api-key ***',
    )
    assert.deepEqual(hideArgSecrets(['run --url "postgres://u:fake-db-pw@db.example/x" -H "X-Api-Key: fk1"']).args, [
      'run --url "postgres://***@db.example/x" -H "X-Api-Key: ***"',
    ])
  })

  test('the word after Bearer or Basic is hidden when the scheme ends a longer word', () => {
    const args = ['run X-Custom:Bearer fake-short-123', 'note=Basic fakeb64', 'Xbasic keep', 'no-bearer keep']
    assert.deepEqual(hideArgSecrets(args).args, [
      'run X-Custom:Bearer ***',
      'note=Basic ***',
      'Xbasic keep',
      'no-bearer keep',
    ])
    assert.equal(redact('failed: run X-Custom:Bearer fake-short-123', stdio(args)), 'failed: run X-Custom:Bearer ***')
  })

  test('JWTs, base64 keys and bot tokens are secret words', () => {
    const words = [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fakeSig0123456789abcDEF',
      'fakeAwsSecret0/K7MDENG+bPxRfiCYFAKEKEY=',
      '123456789:AAfakeTelegramToken0123456789xyz',
      'fake%2Fencoded%2BToken0123456789',
      'fake~Token.With~Tilde0123456789',
    ]
    assert.deepEqual(
      hideArgSecrets(words).args,
      words.map(() => '***'),
    )
  })

  test('the values of pwd, pat, cookie, session, sig, dsn and sas are hidden', () => {
    assert.deepEqual(
      hideArgSecrets([
        'DB_PWD=fakepw1',
        '--pat',
        'fakepat1',
        'COOKIE=fake1',
        '--session',
        'fake-session-1',
        '--sig=fakesig1',
        'SENTRY_DSN=https://fakekey@o0.ingest.example/1',
        'AZURE_SAS=sv=2020&fakesas',
        'X-Sig: fakesig2',
      ]).args,
      [
        'DB_PWD=***',
        '--pat',
        '***',
        'COOKIE=***',
        '--session',
        '***',
        '--sig=***',
        'SENTRY_DSN=***',
        'AZURE_SAS=***',
        'X-Sig: ***',
      ],
    )
  })

  test('a query part without = is hidden', () => {
    assert.deepEqual(
      hideArgSecrets(['https://h.example/mcp?fakeBareToken1', 'https://h.example/mcp?a=1&fakeBareToken2#x']).args,
      ['https://h.example/mcp?***', 'https://h.example/mcp?a=***&***#***'],
    )
    assert.equal(hideUrlSecrets('https://h.example/mcp?fakeBareToken3').url, 'https://h.example/mcp?***')
  })

  test('the value after -t, -p and -H is hidden, and a number, a scoped package or a plain header stays', () => {
    assert.deepEqual(
      hideArgSecrets([
        '-t',
        'fake-token-x',
        '-p',
        'Fake2pw',
        '-H',
        'X-Api-Key: fake-key-1',
        '-H',
        'X-Custom: fakeHeaderSecret0123456789',
        '-H',
        'Accept: application/json',
        '-p',
        '8080',
        '-p',
        '@fake-scope/fake-pkg',
        '-t',
        '30',
      ]).args,
      [
        '-t',
        '***',
        '-p',
        '***',
        '-H',
        'X-Api-Key: ***',
        '-H',
        'X-Custom: ***',
        '-H',
        'Accept: application/json',
        '-p',
        '8080',
        '-p',
        '@fake-scope/fake-pkg',
        '-t',
        '30',
      ],
    )
  })

  test('the secret values of a connection string are hidden', () => {
    assert.deepEqual(
      hideArgSecrets([
        'Server=db;Password=Hunter2pw;',
        'host=db.example,user=fake,password=fakepw2',
        '--conn',
        'Data Source=db;User Id=fake;Pwd=fake pw3;Encrypt=true',
      ]).args,
      [
        'Server=db;Password=***;',
        'host=db.example,user=fake,password=***',
        '--conn',
        'Data Source=db;User Id=fake;Pwd=***;Encrypt=true',
      ],
    )
  })

  test('a JSON argument hides the value of each secret key and the secrets in other strings', () => {
    const args = [
      '{"token":"fakeJsonToken0123456789abcd"}',
      '--config',
      '{"apiKey": "fakepw1", "url": "postgres://u:fakepw2@db.example/x", "port": 8080, "auth": {"password": "fakepw3", "user": "fake"}, "headers": [{"name": "Accept", "value": "json"}], "secrets": ["fakepw4"]}',
    ]
    assert.deepEqual(hideArgSecrets(args).args, [
      '{"token":"***"}',
      '--config',
      '{"apiKey":"***","url":"postgres://***@db.example/x","port":8080,"auth":{"password":"***","user":"fake"},"headers":[{"name":"Accept","value":"***"}],"secrets":["***"]}',
    ])
    assert.equal(
      redact(`bad config ${args.join(' ')}`, stdio(args)),
      'bad config {"token":"***"} --config {"apiKey": "***", "url": "postgres://***@db.example/x", "port": 8080, "auth": {"password": "***", "user": "fake"}, "headers": [{"name": "Accept", "value": "***"}], "secrets": ["***"]}',
    )
  })

  test('make it fail: a JSON secret with an escaped quote or backslash is hidden in the raw text that a server echoes', () => {
    const args = ['{"apiKey":"fake\\"secret123","token":"fake\\\\back456"}']
    assert.deepEqual(hideArgSecrets(args).args, ['{"apiKey":"***","token":"***"}'])
    const echoed = redact(`bad config ${args[0]}`, stdio(args))
    assert.ok(!echoed.includes('secret123') && !echoed.includes('back456'), echoed)
  })

  test('the password of user:password after -u or --user is hidden, also in a script', () => {
    const args = [
      '-u',
      'fake-admin:fakepw5',
      '--user',
      'fake-admin:fakepw6',
      '--user=fake-admin:fakepw7',
      '-c',
      'curl -u fake-admin:fakepw8 https://h.example/x',
    ]
    assert.deepEqual(hideArgSecrets(args).args, [
      '-u',
      'fake-admin:***',
      '--user',
      'fake-admin:***',
      '--user=fake-admin:***',
      '-c',
      'curl -u fake-admin:*** https://h.example/x',
    ])
    assert.equal(redact('401 for fake-admin:fakepw8', stdio(args)), '401 for fake-admin:***')
  })

  test('make it fail: an empty or unusual user before the password, and --proxy-user, are hidden', () => {
    const args = [
      '-u',
      ':fakepat12',
      '-u',
      'bob@example.com:fakepw13',
      '-u',
      'CORP\\bob:fakepw14',
      '--proxy-user',
      'bob:fakepw15',
    ]
    assert.deepEqual(hideArgSecrets(args).args, [
      '-u',
      ':***',
      '-u',
      'bob@example.com:***',
      '-u',
      'CORP\\bob:***',
      '--proxy-user',
      'bob:***',
    ])
  })

  test('make it fail: every value inside a JSON object or array under a secret key is hidden', () => {
    const args = [
      '{"auth":{"user":"fake-bob","value":"fakepw16"},"secrets":[{"name":"db","value":"fakepw17"}],"port":8080}',
    ]
    assert.deepEqual(hideArgSecrets(args).args, [
      '{"auth":{"user":"fake-bob","value":"***"},"secrets":[{"name":"db","value":"***"}],"port":8080}',
    ])
    assert.equal(redact('tok fakepw16 and fakepw17', stdio(args)), 'tok *** and ***')
  })

  test('make it fail: a JSON argument nested too deep for the stack is hidden whole, and nothing throws', () => {
    const deep = `${'['.repeat(5000)}"fakepw18"${']'.repeat(5000)}`
    assert.deepEqual(hideArgSecrets(['--config', deep]).args, ['--config', '***'])
    assert.equal(redact(`bad ${deep}`, stdio(['--config', deep])), 'bad ***')
    assert.doesNotThrow(() => redact('bad', { kind: 'stdio', command: 'x', args: [], env: { J: deep } }))
  })

  test('the value after an empty --name= with a secret name, the value of pw, and URL path parameters are hidden', () => {
    assert.deepEqual(
      hideArgSecrets([
        '--password=',
        'fakepw9',
        '--pw',
        'fakepw10',
        'DB_PW=fakepw11',
        'https://h.example/app;jsessionid=fakeSession1;v=2/x?q=1',
      ]).args,
      ['--password=', '***', '--pw', '***', 'DB_PW=***', 'https://h.example/app;jsessionid=***;v=***/x?q=***'],
    )
    assert.equal(hideUrlSecrets('https://h.example/;jsessionid=fakeSession2').url, 'https://h.example/;jsessionid=***')
  })

  test('normal arguments stay readable', () => {
    const args = [
      '-y',
      '@fake-scope/fake-server@1.2.3',
      'fake-server',
      '/srv/data/notes',
      'C:\\data\\notes2024\\server.js',
      '/home/fake/projects/app2024/server-v2/dist/index.js',
      'packages/server-v2/dist/index.js',
      'node_modules/.bin/fake-server2',
      '--port',
      '8080',
      '--path',
      '/srv/x',
      'PATH=/usr/bin',
      '--log-level=debug',
      '--transport',
      'stdio',
      'https://mcp.example.com/api/v1/mcp',
      'sub2.mcp.example.com',
      '--allowed-hosts=a.example,b.example',
      'run --port 3000 --host localhost',
      'run',
      '-i',
      '-t',
      '-p',
      '127.0.0.1:8080:80',
      '-e',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'ghcr.io/fake/fake-mcp-server:1.2.3',
      '-u',
      '1000:1000',
      '--user',
      'node:node',
      '-u',
      '1000:docker',
      '-u',
      'fake-user',
      'python',
      '-u',
      'C:\\srv\\server.py',
      '-u',
      'https://h.example/x',
      '--config',
      '{"port":8080,"host":"localhost","tools":["a","b"],"maxItems":5}',
      'https://h.example/a;b',
    ]
    assert.deepEqual(hideArgSecrets(args).args, args)
  })

  test('a common word or number in env is not replaced, a token is', () => {
    const env = { LOG_LEVEL: 'error', HOST: 'localhost', PORT: '3000', MODE: 'Error' }
    const reason = 'connect ECONNREFUSED localhost:3000: Error'
    assert.equal(redact(reason, stdio([], env)), reason)
    const headers = { 'X-Region': 'europe', Accept: 'json' }
    assert.equal(redact('europe json', http('https://h.example/mcp', headers)), 'europe json')

    const secret = stdio([], { REGION: 'fakeTok3n0abc', API_KEY: 'fk3y', PASSWORD: 'letmein', SESSION_TTL: '3000' })
    assert.equal(
      redact('bad fakeTok3n0abc, fk3y, letmein, letmein123, letmeinside at localhost:3000', secret),
      'bad ***, ***, ***, ***123, letmeinside at localhost:3000',
    )
    assert.equal(redact('bad x9fake0token', stdio([], { X: 'x9fake0token' })), 'bad ***')
  })
})

describe('the config location', () => {
  const home = '/home/u'
  test('--config, then TOOLSCRIPT_CONFIG, then the per-user default', () => {
    assert.equal(configPath('a.json', { TOOLSCRIPT_CONFIG: 'b.json' }, 'linux', home), 'a.json')
    assert.equal(configPath(undefined, { TOOLSCRIPT_CONFIG: 'b.json' }, 'linux', home), 'b.json')
    assert.equal(configPath(undefined, {}, 'linux', home), '/home/u/.config/toolscript-mcp/config.json')
    assert.equal(configPath(undefined, { XDG_CONFIG_HOME: '/x' }, 'darwin', home), '/x/toolscript-mcp/config.json')
    assert.equal(
      configPath(undefined, { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'),
      'C:\\Users\\u\\AppData\\Roaming/toolscript-mcp/config.json',
    )
  })
})

describe('the policy read again at each run', () => {
  test('reads only the policy: a bad server entry or sandbox waits for the next start', () => {
    const text = JSON.stringify({
      mcpServers: { a: { command: '' } },
      sandbox: { node: 3 },
      policy: [{ match: 'mcp__a__*', action: 'allow' }],
    })
    assert.deepEqual(policyOf(text), { ok: true, policy: [{ match: 'mcp__a__*', action: 'allow', index: 0 }] })
    assert.deepEqual(policyOf('{"mcpServers": {}}'), { ok: true, policy: [] })
  })

  test('a broken file or policy gives the errors, never the text near them', () => {
    const json = policyOf('{"policy": [{"match": "mcp__a__*", "action": fake-secret}]}')
    assert.equal(json.ok, false)
    assert.ok(!json.ok && /^the config is not valid JSON/.test(json.errors[0]!), JSON.stringify(json))
    assert.ok(!JSON.stringify(json).includes('fake-secret'))
    assert.deepEqual(policyOf('{"policy": [{"match": "x", "action": "allow"}]}'), {
      ok: false,
      errors: ['policy[0].match: must be a glob over mcp__<server>__<tool>, such as "mcp__github__*"'],
    })
  })

  test('make it fail: a policy error names the place, and no text of the file', () => {
    // A program can write the config through a tool, and the note of the next run shows the errors.
    const said = 'IGNORE_ALL_PREVIOUS_RULES'
    const read = policyOf(
      JSON.stringify({ policy: [{ match: `x ${said}`, action: said, [said]: 1, [`${said}2`]: 2 }, { match: 7 }] }),
    )
    assert.deepEqual(read, {
      ok: false,
      errors: [
        'policy[0]: 2 unknown keys (known: match, action)',
        'policy[0].match: must be a glob over mcp__<server>__<tool>, such as "mcp__github__*"',
        'policy[0].action: must be "allow", "deny" or "ask"',
        'policy[1].match: must be a glob over mcp__<server>__<tool>, such as "mcp__github__*"',
        'policy[1].action: must be "allow", "deny" or "ask"',
      ],
    })
  })
})

describe('the catalog', () => {
  const states: ServerState[] = [
    {
      key: key('bench'),
      status: 'connected',
      tools: [
        {
          name: 'list_issues',
          description: 'List all issues of a project.\nMore text.',
          inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
        },
        { name: 'get_deploys', description: 'List all deploys of one day.', inputSchema: { type: 'object' } },
      ],
    },
    { key: key('other'), status: 'connected', tools: [{ name: 'ping' }] },
    { key: key('slack'), status: 'failed', reason: 'spawn slack-mcp ENOENT' },
  ]

  test('names each tool mcp__<server>__<tool>, from connected servers only', () => {
    assert.deepEqual(
      catalogOf(states).map(t => t.name),
      ['mcp__bench__list_issues', 'mcp__bench__get_deploys', 'mcp__other__ping'],
    )
  })

  test('keeps the mark anthropic/requiresUserInteraction only when its value is the JSON true', () => {
    const marked = (meta: unknown) =>
      catalogOf([{ key: key('x'), status: 'connected', tools: [{ name: 't', _meta: meta }] }])[0]!
        .requiresUserInteraction
    assert.equal(marked({ 'anthropic/requiresUserInteraction': true }), true)
    for (const other of [
      undefined,
      null,
      [true],
      {},
      { 'anthropic/requiresUserInteraction': 'true' },
      { 'anthropic/requiresUserInteraction': 1 },
      { requiresUserInteraction: true },
    ])
      assert.equal(marked(other), false, JSON.stringify(other))
  })

  test('argsText shows argument names and types, with ? for optional ones', () => {
    assert.equal(
      argsText({
        type: 'object',
        properties: {
          id: { type: 'string' },
          n: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
          mode: { enum: ['a', 'b'] },
          x: { type: ['string', 'null'] },
          y: {},
        },
        required: ['id'],
      }),
      '{ id: string; n?: number; tags?: string[]; mode?: "a" | "b"; x?: string | null; y?: unknown }',
    )
    assert.equal(argsText({ type: 'object' }), '{}')
    assert.equal(argsText(undefined), '{}')
  })

  test('argsText shows the numeric bounds of a number, and only finite ones', () => {
    const shown = (schema: unknown): string => argsText({ type: 'object', properties: { n: schema } })
    assert.equal(shown({ type: 'integer', maximum: 100 }), '{ n?: number (max 100) }')
    assert.equal(shown({ type: 'number', minimum: 1, maximum: 100 }), '{ n?: number (1-100) }')
    assert.equal(shown({ type: 'number', minimum: 0.5 }), '{ n?: number (min 0.5) }')
    assert.equal(shown({ type: 'number', minimum: -5, maximum: 5 }), '{ n?: number (min -5, max 5) }')
    assert.equal(shown({ type: ['number', 'string'], maximum: 9 }), '{ n?: number (max 9) | string }')
    assert.equal(shown({ type: 'array', items: { type: 'integer', minimum: 1 } }), '{ n?: (number (min 1))[] }')
    // Server text and non-finite values never reach the output. An exclusive bound is not shown.
    for (const bad of ['100', null, true, Infinity, NaN, { a: 1 }, ['x\n### forged']])
      assert.equal(shown({ type: 'number', minimum: bad, maximum: bad }), '{ n?: number }', String(bad))
    assert.equal(shown({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 9 }), '{ n?: number }')
    assert.equal(shown({ type: 'string', maximum: 3 }), '{ n?: string }')
    // The MCP SDK with zod v4 gives every integer the safe-integer range, and z.int32() the int32 range: no limit
    // that a program meets, so neither shows. A large bound under the int32 range still shows.
    const safe = Number.MAX_SAFE_INTEGER
    assert.equal(shown({ type: 'integer', minimum: -safe, maximum: safe }), '{ n?: number }')
    assert.equal(shown({ type: 'integer', exclusiveMinimum: 0, maximum: safe }), '{ n?: number }')
    assert.equal(shown({ type: 'integer', minimum: -2147483648, maximum: 2147483647 }), '{ n?: number }')
    assert.equal(shown({ type: 'integer', minimum: 1, maximum: safe }), '{ n?: number (min 1) }')
    assert.equal(shown({ type: 'integer', maximum: 1000000000 }), '{ n?: number (max 1000000000) }')
    // In draft-04 and OpenAPI 3.0, `exclusiveMinimum: true` makes `minimum` exclusive, so that bound does not show.
    const draft4 = { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: true }
    assert.equal(shown(draft4), '{ n?: number }')
    assert.equal(shown({ ...draft4, exclusiveMaximum: false }), '{ n?: number (max 10) }')
    // A numeric exclusive bound as tight as the inclusive one or tighter hides it. A looser one leaves it.
    assert.equal(shown({ type: 'integer', minimum: 0, exclusiveMinimum: 0 }), '{ n?: number }')
    assert.equal(shown({ type: 'integer', minimum: 1, maximum: 10, exclusiveMaximum: 3 }), '{ n?: number (min 1) }')
    assert.equal(shown({ type: 'integer', minimum: 5, exclusiveMinimum: 0 }), '{ n?: number (min 5) }')
    assert.equal(shown({ type: 'integer', maximum: 100, exclusiveMaximum: 1000 }), '{ n?: number (max 100) }')
    // Nested arrays read as the detail view does, with one pair of parentheses around a union.
    const deep = { type: 'array', items: { type: 'array', items: { enum: ['a', 'b'] } } }
    assert.equal(shown(deep), '{ n?: ("a" | "b")[][] }')
    assert.equal(shown({ type: 'array', items: { enum: ['a | b'] } }), '{ n?: "a | b"[] }')
    // An array of a union holds the whole union in parentheses, so a bound never reads as a bound on the array.
    assert.equal(
      shown({ type: 'array', items: { type: ['null', 'integer'], minimum: 1 } }),
      '{ n?: (null | number (min 1))[] }',
    )
    // The dash form holds two whole numbers in order only, so it never reads as a subtraction.
    assert.equal(shown({ type: 'number', minimum: 1e-7, maximum: 1 }), '{ n?: number (min 1e-7, max 1) }')
    assert.equal(shown({ type: 'number', minimum: 0.5, maximum: 2 }), '{ n?: number (min 0.5, max 2) }')
    assert.equal(shown({ type: 'number', minimum: 10, maximum: 1 }), '{ n?: number (min 10, max 1) }')
  })

  test('argsText gives the real type of a union, a const and a ref', () => {
    const shown = (schema: unknown): string => argsText({ type: 'object', properties: { n: schema } })
    assert.equal(shown({ anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }), '{ n?: number (min 1) | null }')
    assert.equal(shown({ oneOf: [{ type: 'string' }, { type: 'number' }] }), '{ n?: string | number }')
    assert.equal(shown({ const: 'open' }), '{ n?: "open" }')
    assert.equal(shown({ allOf: [{ type: 'string' }, { minLength: 1 }] }), '{ n?: string }')
    assert.equal(
      shown({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }),
      '{ n?: (string | null)[] }',
    )
    assert.equal(
      shown({ type: 'array', items: { anyOf: [{ type: 'array', items: { const: 1 } }, { type: 'null' }] } }),
      '{ n?: (1[] | null)[] }',
    )
    // A $ref is followed as in the detail view. A loop or a miss is unknown.
    const root = {
      type: 'object',
      $defs: { Id: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, Loop: { anyOf: [{ $ref: '#/$defs/Loop' }] } },
      properties: { a: { $ref: '#/$defs/Id' }, b: { $ref: '#/$defs/Loop' }, c: { $ref: '#/$defs/Nope' } },
    }
    assert.equal(argsText(root), '{ a?: number | null; b?: unknown; c?: unknown }')
    // A value that is too long is replaced by its type, so text from the server stays bounded.
    assert.equal(shown({ const: 'x'.repeat(600) }), '{ n?: string /* long value left out */ }')
    // A union that branches wide and deep is cut, not walked in full.
    const wide = { anyOf: Array.from({ length: 50 }, () => ({ $ref: '#/$defs/W' })) }
    const huge = { type: 'object', $defs: { W: wide }, properties: { n: { $ref: '#/$defs/W' } } }
    assert.equal(argsText(huge), '{ n?: unknown }')
  })

  test('argsText keeps each type of the old text and reads only a schema with no type', () => {
    const shown = (schema: unknown): string => argsText({ type: 'object', properties: { n: schema } })
    // A type list shows each of its types, also next to a union that names the type of the items.
    assert.equal(
      shown({ type: ['string', 'array'], oneOf: [{ type: 'string' }, { items: { type: 'string' } }] }),
      '{ n?: string | unknown[] }',
    )
    assert.equal(shown({ type: ['file', 'array'] }), '{ n?: file | unknown[] }')
    assert.equal(shown({ type: [['string']] }), '{ n?: string }')
    assert.equal(
      shown({ type: ['array', 'null'], items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }),
      '{ n?: (string | number)[] | null }',
    )
    // A value that a union repeats counts once, and a union of untyped parts next to properties is an object.
    assert.equal(shown({ anyOf: Array.from({ length: 30 }, () => ({ const: 'a' })) }), '{ n?: "a" }')
    assert.equal(shown({ properties: { a: {} }, anyOf: [{ required: ['a'] }] }), '{ n?: object }')
  })

  test('argsText keeps the text of each argument that shows no unknown', () => {
    const list = {
      type: 'object',
      required: ['owner', 'repo'],
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        sort: { type: 'string', enum: ['created', 'updated', 'comments'] },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        labels: { type: 'array', items: { type: 'string' } },
        since: { type: ['string', 'null'] },
        milestone: { type: ['string', 'number', 'null'] },
        page: { type: 'integer', minimum: 1 },
        perPage: { type: 'integer', minimum: 1, maximum: 100 },
        includePullRequests: { type: 'boolean' },
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [`aLongArgumentNameForTesting${i}`, { type: 'string' }]),
        ),
      },
    }
    assert.equal(
      argsText(list),
      '{ owner: string; repo: string; state?: "open" | "closed" | "all"; sort?: "created" | "updated" | "comments"; ' +
        'direction?: "asc" | "desc"; labels?: string[]; since?: string | null; milestone?: string | number | null; ' +
        'page?: number (min 1); perPage?: number (1-100); includePullRequests?: boolean; ' +
        'aLongArgumentNameForTesting0?: string; aLongArgumentNameForTesting1?: string; ' +
        'aLongArgumentNameForTesting2?: string; aLongArgumentNameForTesting3?: string; … 8 more arguments }',
    )
    // An enum stays whole, also past 25 values. A union, a const or a $ref next to a type leaves the type.
    const values = Array.from({ length: 30 }, (_, i) => `v${i}`)
    const required = ['e', 'q', 'when', 'sha', 'c']
    const typed = {
      type: 'object',
      required,
      $defs: { Sha: { pattern: '^[0-9a-f]{40}$' } },
      properties: {
        e: { enum: values },
        q: { type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }] },
        when: { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] },
        sha: { type: 'string', $ref: '#/$defs/Sha' },
        c: { type: 'string', anyOf: [{ const: 'a' }, { const: 'b' }] },
      },
    }
    assert.equal(
      argsText(typed),
      `{ e: ${values.map(v => `"${v}"`).join(' | ')}; q: object; when: string; sha: string; c: string }`,
    )
  })

  test('argsText shows a union in place of unknown only when the list keeps its arguments', () => {
    // A union too long to fit with the arguments after it stays unknown.
    const values = Array.from({ length: 20 }, (_, i) => `pull_request_review_${i}`)
    const tool = (event: unknown): unknown => ({
      type: 'object',
      required: ['event', 'repo'],
      properties: { event, repo: { type: 'string' } },
    })
    const union = (n: number): unknown => ({ anyOf: values.slice(0, n).map(v => ({ type: 'string', const: v })) })
    assert.equal(argsText(tool(union(20))), '{ event: unknown; repo: string }')
    assert.equal(
      argsText(tool(union(3))),
      '{ event: "pull_request_review_0" | "pull_request_review_1" | "pull_request_review_2"; repo: string }',
    )
    const long = Array.from({ length: 30 }, (_, i) => ({ const: `pull_request_review_comment_${i}` }))
    const kind = { enum: Array.from({ length: 6 }, (_, i) => `k${i}`) }
    assert.equal(
      argsText({
        type: 'object',
        required: ['kind', 'owner', 'events', 'repo'],
        properties: { kind, owner: { type: 'string' }, events: { type: 'array', items: { anyOf: long } }, repo: {} },
      }),
      '{ kind: "k0" | "k1" | "k2" | "k3" | "k4" | "k5"; owner: string; events: unknown[]; repo: unknown }',
    )
    const choices = Array.from({ length: 25 }, (_, i) => ({ const: `an_optional_field_name_choice_${i}` }))
    assert.equal(
      argsText({
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string' }, field: { anyOf: choices }, page: { type: 'integer' } },
      }),
      '{ q: string; field?: unknown; page?: number }',
    )
    // The pydantic form of an optional Literal: the short one shows, the long list of fields does not fit.
    const sort = Array.from({ length: 8 }, (_, i) => `sort_by_${i}`)
    const fields = Array.from({ length: 40 }, (_, i) => `a_field_name_${i}`)
    assert.equal(
      argsText({
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          sort: { anyOf: [{ enum: sort }, { type: 'null' }] },
          fields: { anyOf: [{ type: 'array', items: { enum: fields } }, { type: 'null' }] },
          page: { type: 'integer' },
        },
      }),
      `{ query: string; sort?: ${sort.map(s => `"${s}"`).join(' | ')} | null; fields?: unknown; page?: number }`,
    )
  })

  test('both views stay fast on a large schema behind many refs and on a type list that repeats array', () => {
    const many = Array.from({ length: 500000 }, (_, i) => i)
    const keys = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`k${i}`, 1]))
    const refs = { anyOf: Array.from({ length: 2000 }, () => ({ $ref: '#/$defs/E' })) }
    const large = [
      { enum: many },
      { anyOf: many.map(i => ({ const: i })) },
      { const: 'x'.repeat(400000) },
      { const: { a: 'x'.repeat(400000) } },
      { $ref: `#/x${'/y'.repeat(50000)}` },
      { type: ['string', 'null'], ...keys },
      { type: 'string', $ref: '#/$defs/S', ...keys },
      { type: 'string', allOf: [{ minLength: 1 }], ...keys },
    ]
    for (const E of large) {
      const inputSchema = { type: 'object', $defs: { E, S: { type: 'string' } }, properties: { a: refs } }
      const start = performance.now()
      const text = argsText(inputSchema)
      const detail = searchResult(
        [{ key: serverKey('x'), status: 'connected', tools: [{ name: 't', description: 'd', inputSchema }] }],
        'mcp__x__t',
        15,
      )
      assert.ok(performance.now() - start < 1000, `${performance.now() - start} ms`)
      assert.ok(text.length <= 500 && detail.length <= 5000, `${text.length} and ${detail.length} characters`)
    }
    // A type list that repeats array at each level shows each type once.
    let nested: unknown = { type: 'string' }
    for (let i = 0; i < 12; i++) nested = { type: Array(10).fill('array'), items: nested }
    const start = performance.now()
    assert.equal(argsText({ type: 'object', properties: { a: nested } }), `{ a?: string${'[]'.repeat(12)} }`)
    assert.ok(performance.now() - start < 1000, `${performance.now() - start} ms`)
  })

  test('argsText cuts only the values of a long union, and counts them', () => {
    const shown = (schema: unknown): string => argsText({ type: 'object', properties: { n: schema } })
    const consts = Array.from({ length: 30 }, (_, i) => ({ const: `v${i}` }))
    const first = Array.from({ length: 25 }, (_, i) => `"v${i}"`).join(' | ')
    const types = [
      { type: 'array', items: { const: 'x' } },
      { type: 'array', items: { const: 1 } },
      { allOf: [{ const: 'q' }, { type: 'string' }] },
    ]
    assert.equal(shown({ anyOf: [...consts, ...types] }), `{ n?: ${first} | "x"[] | 1[] | "q" & string | … }`)
    const strings = Array.from({ length: 25 }, () => ({ type: 'string' }))
    assert.equal(shown({ anyOf: [...strings, { const: 'x' }, { const: null }] }), '{ n?: string | "x" | null }')
  })

  test('argsText reads a plain argument after a wide one spent the steps', () => {
    const wide = { anyOf: Array.from({ length: 50 }, () => ({ $ref: '#/$defs/W' })) }
    const root = { type: 'object', required: ['a', 'b'], $defs: { W: wide } }
    const properties = { a: { $ref: '#/$defs/W' }, b: { type: 'string' } }
    assert.equal(argsText({ ...root, properties }), '{ a: unknown; b: string }')
  })

  test('argsText shows each member of a union once', () => {
    const shown = (schema: unknown): string => argsText({ type: 'object', properties: { n: schema } })
    const variants = Array.from({ length: 12 }, (_, i) => ({ type: 'object', properties: { kind: { const: i } } }))
    assert.equal(shown({ oneOf: variants }), '{ n?: object }')
    assert.equal(shown({ anyOf: [{ type: 'string' }, { type: 'string', format: 'date' }] }), '{ n?: string }')
    // Properties without a type are an object, and a type name in a union that is not a JSON type is unknown.
    assert.equal(shown({ properties: { x: { type: 'string' } } }), '{ n?: object }')
    assert.equal(shown({ anyOf: [{ type: 'any' }, { type: 'null' }] }), '{ n?: unknown | null }')
  })

  test('argsText reads a wide schema with many arguments fast and stays short', () => {
    // Each argument refers to a union of 50 refs to itself. The arguments share one budget of steps, and each one past
    // it gets a few steps of its own.
    const wide = { anyOf: Array.from({ length: 50 }, () => ({ $ref: '#/$defs/W' })) }
    const properties = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${i}`, { $ref: '#/$defs/W' }]))
    const start = performance.now()
    const text = argsText({ type: 'object', $defs: { W: wide }, properties })
    assert.ok(performance.now() - start < 1000, `${performance.now() - start} ms`)
    assert.ok(text.length <= 500, `${text.length} characters`)
    const parts = text.slice(2, -2).split('; ')
    assert.match(parts.pop()!, /^… \d+ more arguments$/)
    parts.forEach((p, i) => assert.equal(p, `p${i}?: unknown`))
  })

  test('a spec with bounded arguments still cuts at whole arguments', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`bounded_argument_${i}`, { type: 'integer', minimum: 1, maximum: 100 }]),
    )
    const text = argsText({ type: 'object', properties, required: ['bounded_argument_59'] })
    assert.ok(text.length <= 500, `${text.length} characters`)
    const parts = text.slice(2, -2).split('; ')
    assert.match(parts.pop()!, /^… \d+ more arguments$/)
    assert.equal(parts[0], 'bounded_argument_59: number (1-100)')
    for (const p of parts.slice(1)) assert.match(p, /^bounded_argument_\d+\?: number \(1-100\)$/)
  })

  test('an empty query lists the servers, a key lists one server, a query ranks name hits first, and failed servers come last', () => {
    assert.equal(
      searchResult(states, '', 15),
      '3 MCP tools on 2 servers. A server key as the query lists all the tool names of that server.\nbench: 2 tools: get_deploys, list_issues\nother: 1 tool: ping\n\n## Not connected\n- slack: spawn slack-mcp ENOENT',
    )
    assert.match(
      searchResult(states, 'bench', 15),
      /^bench: 2 tools, this server only\. Add a word to search all servers\.\n\n### mcp__bench__get_deploys\n[^]*### mcp__bench__list_issues\n/,
    )
    const issues = searchResult(states, 'issues', 15)
    assert.equal(
      issues,
      '1 of 3 MCP tools.\n\n### mcp__bench__list_issues\nList all issues of a project. More text.\ncall("mcp__bench__list_issues", {\n  project: string\n})\n\n## Not connected\n- slack: spawn slack-mcp ENOENT',
    )
    assert.match(
      searchResult(states, 'list', 15),
      /^2 of 3 MCP tools\.\n\n### mcp__bench__list_issues\n[^]*### mcp__bench__get_deploys\n/,
    )
  })

  test('a tool with no usable name is left out, and downstream text stays on one line', () => {
    const odd: ServerState[] = [
      {
        key: key('x'),
        status: 'connected',
        tools: [
          { name: '' },
          { name: 'a\n### mcp__x__forged' },
          {
            name: 'ok',
            description: 'Fine\r### forged',
            inputSchema: { properties: { 'p\n### y': { type: 'string' } } },
          },
        ],
      },
      { key: key('y'), status: 'failed', reason: 'line one\n### mcp__y__forged' },
      { key: key('z'), status: 'connecting' },
    ]
    const text = searchResult(odd, 'mcp__x__ok', 15)
    assert.equal(
      text,
      '1 of 1 MCP tools.\n\n### mcp__x__ok\nFine ### forged\ncall("mcp__x__ok", {\n  "p\\n### y"?: string\n})\n\n## Not connected\n- y: line one ### mcp__y__forged\n- z: still connecting. Search again in a moment.',
    )
    const listed = searchResult(odd, 'x', 15)
    assert.match(listed, /^x: 1 tool, this server only\. [^\n]*\n\n### mcp__x__ok\nFine ### forged\ncall\(/)
    assert.ok(searchResult(odd, '', 15).startsWith('1 MCP tool on 1 server. '))
    assert.deepEqual(
      listed.split('\n').filter(line => line.startsWith('#')),
      ['### mcp__x__ok', '## Not connected'],
    )
  })

  test('no match says how many tools are connected, and which servers failed', () => {
    assert.equal(
      searchResult(states, 'calendar', 15),
      'No MCP tool matches "calendar". 3 MCP tools are connected.\nmcp__bench__: get_deploys, list_issues\nmcp__other__: ping\n\n## Not connected\n- slack: spawn slack-mcp ENOENT',
    )
  })

  test('the names of a search with no match never start a line or a heading', () => {
    const odd: ServerState[] = [
      {
        key: key('x'),
        status: 'connected',
        tools: [{ name: 'a\n### mcp__x__forged' }, { name: 'ok' }],
      },
      { key: key('y'), status: 'failed', reason: 'line one\n### mcp__y__forged' },
    ]
    const text = searchResult(odd, 'zzzqq', 15)
    assert.equal(
      text,
      'No MCP tool matches "zzzqq". 1 MCP tools are connected.\nmcp__x__: ok\n\n## Not connected\n- y: line one ### mcp__y__forged',
    )
    assert.deepEqual(
      text.split('\n').filter(line => line.startsWith('#')),
      ['## Not connected'],
    )
  })
})

describe('the workspace section', () => {
  const section = { roots: [{ path: '/work/app' }] }

  test('no section: no workspace entry, the key stays free for a server and gets no default allow', () => {
    const none = ok({ mcpServers: { a: { command: 'x' } } })
    assert.equal(none.workspace, undefined)
    assert.equal(none.guards.workspace, false)
    assert.equal(none.servers.has(key('workspace')), false)
    const own = ok({ mcpServers: { workspace: { command: 'fake-server' } } })
    assert.equal(own.servers.get(key('workspace'))?.kind, 'stdio')
    assert.equal(own.guards.workspace, false)
  })

  test('a valid section adds an untrusted entry of its own kind, and the defaults of the ADR', () => {
    const config = ok({ mcpServers: { a: { command: 'x' } }, workspace: section })
    assert.deepEqual(config.servers.get(key('workspace')), { kind: 'workspace', untrusted: true })
    assert.deepEqual(config.workspace, {
      roots: [{ path: '/work/app', write: false }],
      exclude: [],
      skip: ['node_modules', 'dist', 'build', 'target', 'vendor', 'coverage', '.venv', 'venv', '__pycache__'],
    })
    assert.equal(config.guards.workspace, true)
    assert.deepEqual([...config.servers.keys()], ['a', 'workspace'])
  })

  test('reads every key, expands ${VAR} in a root and accepts a Windows drive path on Windows only', () => {
    const config = ok(
      {
        mcpServers: {},
        workspace: {
          roots: [{ path: '${ROOT}/app', write: true }, { path: '/b' }],
          exclude: ['*.sqlite', 'fixtures/**'],
          skip: ['out'],
        },
      },
      { ROOT: '/work' },
    )
    assert.deepEqual(config.workspace, {
      roots: [
        { path: '/work/app', write: true },
        { path: '/b', write: false },
      ],
      exclude: ['*.sqlite', 'fixtures/**'],
      skip: ['out'],
    })
    const win = ok({ mcpServers: {}, workspace: { roots: [{ path: 'C:/Users/me/app' }] } }, {}, 'win32')
    assert.equal(win.workspace?.roots[0]?.path, 'C:/Users/me/app')
    const bad = ok({ mcpServers: {}, workspace: { roots: [{ path: 'C:/Users/me/app' }] } })
    assert.equal(bad.servers.get(key('workspace'))?.kind, 'invalid')
  })

  test('gitignore is true by default and false only when the section says false', () => {
    assert.equal(ok({ mcpServers: {}, workspace: section }).workspace?.gitignore, undefined)
    assert.equal(ok({ mcpServers: {}, workspace: { ...section, gitignore: true } }).workspace?.gitignore, undefined)
    assert.equal(ok({ mcpServers: {}, workspace: { ...section, gitignore: false } }).workspace?.gitignore, false)
  })

  test('an error in the section makes only workspace invalid, and each error names its key and no value', () => {
    const cases: [unknown, string][] = [
      [{}, 'workspace.roots: must be an array of 1 to 16 entries'],
      [{ roots: [] }, 'workspace.roots: must be an array of 1 to 16 entries'],
      [{ roots: [{ path: 'relative/dir' }] }, 'workspace.roots[0].path: must be an absolute path'],
      [{ roots: [{ path: '' }] }, 'workspace.roots[0].path: must be a non-empty string'],
      [{ roots: [{ path: '/a', write: 'yes' }] }, 'workspace.roots[0].write: must be true or false'],
      [{ roots: [{ path: '/a', shell: {} }] }, 'workspace.roots[0].shell: unknown key (known: path, write, tasks)'],
      [{ roots: [5] }, 'workspace.roots[0]: must be an object with "path"'],
      [{ roots: [{ path: '/a' }], extra: 1 }, 'workspace.extra: unknown key (known: roots, exclude, skip, gitignore)'],
      [{ roots: [{ path: '/a' }], gitignore: 'no' }, 'workspace.gitignore: must be true or false'],
      [{ roots: [{ path: '/a' }], gitignore: null }, 'workspace.gitignore: must be true or false'],
      [{ roots: [{ path: '/a' }], exclude: ['/abs'] }, 'workspace.exclude[0]: must use / between parts'],
      [{ roots: [{ path: '/a' }], exclude: 'x' }, 'workspace.exclude: must be an array of at most 64 strings'],
      [{ roots: [{ path: '/a' }], skip: ['a/b'] }, 'workspace.skip[0]: must be a folder name'],
      [{ roots: [{ path: '/${NOPE}' }] }, 'workspace.roots[0].path: the environment variable NOPE is not set'],
      [5, 'workspace: must be an object with "roots"'],
    ]
    for (const [value, error] of cases) {
      const config = ok({ mcpServers: { a: { command: 'x' } }, workspace: value })
      const entry = config.servers.get(key('workspace'))
      assert.equal(entry?.kind, 'invalid', JSON.stringify(value))
      const reasons = entry?.kind === 'invalid' ? entry.errors : []
      assert.ok(
        reasons.some(r => r.startsWith(error)),
        `${error} in ${JSON.stringify(reasons)}`,
      )
      assert.equal(config.servers.get(key('a'))?.kind, 'stdio', 'the other servers still start')
      assert.equal(config.guards.workspace, false)
      assert.equal(config.workspace, undefined)
    }
    const secretRoot = ok({ mcpServers: {}, workspace: { roots: [{ path: 'hunter2-not-absolute' }] } })
    assert.ok(!JSON.stringify([...secretRoot.servers]).includes('hunter2'))
  })

  test('a section and an mcpServers entry with the key workspace make only workspace invalid, and the reason names both', () => {
    const config = ok({ mcpServers: { workspace: { command: 'x' }, a: { command: 'y' } }, workspace: section })
    const entry = config.servers.get(key('workspace'))
    assert.equal(entry?.kind, 'invalid')
    assert.match(
      entry?.kind === 'invalid' ? entry.errors.join(' ') : '',
      /"workspace" section and an mcpServers entry with the key "workspace"/,
    )
    assert.equal(config.servers.get(key('a'))?.kind, 'stdio')
    assert.equal(config.guards.workspace, false, 'a clash gives no default allow to the server')
    assert.equal(config.workspace, undefined)
  })

  test('the policy read again at a run never reads the section', () => {
    const next = policyOf(JSON.stringify({ mcpServers: {}, workspace: { roots: [{ path: 'relative' }] }, policy: [] }))
    assert.deepEqual(next, { ok: true, policy: [] })
  })
})

describe('the tasks of the workspace section', () => {
  const withTasks = (tasks: unknown, extra: Record<string, unknown> = {}) => ({
    mcpServers: { a: { command: 'x' } },
    ...extra,
    workspace: { roots: [{ path: '/work/app', tasks }] },
  })
  const task = { command: 'node', args: ['--test'], cwd: '.', timeoutSeconds: 30, env: { CI: '1' } }

  test('a task reads every key, and the defaults are no args, the entry as folder and one second under the call limit', () => {
    const config = ok(withTasks({ test: task, build: { command: 'tsc' }, 'a_b-1': { command: '/usr/bin/make' } }))
    assert.deepEqual(config.workspace?.roots[0]?.tasks, [
      { name: 'test', command: 'node', args: ['--test'], cwd: [], timeoutSeconds: 30, env: { CI: '1' } },
      { name: 'build', command: 'tsc', args: [], cwd: [], timeoutSeconds: 59, env: {} },
      { name: 'a_b-1', command: '/usr/bin/make', args: [], cwd: [], timeoutSeconds: 59, env: {} },
    ])
    assert.equal(config.guards.workspace, true)
    const folder = ok(withTasks({ t: { command: 'node', cwd: 'packages/app' } }))
    assert.deepEqual(folder.workspace?.roots[0]?.tasks?.[0]?.cwd, ['packages', 'app'])
    assert.equal(ok({ mcpServers: {}, workspace: { roots: [{ path: '/a' }] } }).workspace?.roots[0]?.tasks, undefined)
  })

  test('the default time is 59 seconds, and a time at or over the call limit is kept one second under it', () => {
    const lower = ok(withTasks({ t: { command: 'node' } }, { sandbox: { callTimeoutSeconds: 20 } }))
    assert.equal(lower.workspace?.roots[0]?.tasks?.[0]?.timeoutSeconds, 19)
    const high = ok(
      withTasks(
        { t: { command: 'node', timeoutSeconds: 300 } },
        { sandbox: { timeoutSeconds: 400, callTimeoutSeconds: 300 } },
      ),
    )
    assert.equal(high.workspace?.roots[0]?.tasks?.[0]?.timeoutSeconds, 299)
  })

  test('expands ${VAR} in the command, the arguments and the variables, and an unset one is an error that names it', () => {
    const config = ok(withTasks({ t: { command: '${TOOLS}/run', args: ['--k=${KEY}'], env: { TOKEN: '${KEY}' } } }), {
      TOOLS: '/opt/tools',
      KEY: 'v1',
    })
    const [t] = config.workspace?.roots[0]?.tasks ?? []
    assert.deepEqual([t?.command, t?.args, t?.env], ['/opt/tools/run', ['--k=v1'], { TOKEN: 'v1' }])
    const bad = ok(withTasks({ t: { command: 'node', args: ['${NOPE}'] } }))
    assert.equal(bad.servers.get(key('workspace'))?.kind, 'invalid')
  })

  test('each error names its key, holds no value of the file, and makes only workspace invalid', () => {
    const T = 'workspace.roots[0].tasks'
    const cases: [unknown, string][] = [
      ['x', `${T}: must be an object of tasks`],
      [{ 'Bad Name': { command: 'x' } }, `${T}["Bad Name"]: a task name has 1 to 32 characters`],
      [{ ['a'.repeat(33)]: { command: 'x' } }, `${T}.${'a'.repeat(33)}: a task name has 1 to 32 characters`],
      [{ t: 5 }, `${T}.t: must be an object with "command"`],
      [{ t: {} }, `${T}.t.command: must be a non-empty string`],
      [
        { t: { command: 'x', shell: true } },
        `${T}.t.shell: unknown key (known: command, args, cwd, timeoutSeconds, env)`,
      ],
      [{ t: { command: './run.sh' } }, `${T}.t.command: must be an absolute path, or a bare command name`],
      [{ t: { command: 'bin/run' } }, `${T}.t.command: must be an absolute path, or a bare command name`],
      [{ t: { command: 'a\u0000b' } }, `${T}.t.command: must hold no control character`],
      [{ t: { command: 'x', args: 'a' } }, `${T}.t.args: must be an array of at most 64 strings`],
      [{ t: { command: 'x', args: [1] } }, `${T}.t.args[0]: must be a string`],
      [{ t: { command: 'x', args: ['a\u0000b'] } }, `${T}.t.args[0]: must hold at most 4096 characters and no NUL`],
      [{ t: { command: 'x', cwd: '../up' } }, `${T}.t.cwd: must be a folder inside the root entry`],
      [{ t: { command: 'x', cwd: '/abs' } }, `${T}.t.cwd: must be a folder inside the root entry`],
      [{ t: { command: 'x', cwd: 'a/../b' } }, `${T}.t.cwd: must be a folder inside the root entry`],
      [{ t: { command: 'x', cwd: 'a\\b' } }, `${T}.t.cwd: must be a folder inside the root entry`],
      [{ t: { command: 'x', cwd: 7 } }, `${T}.t.cwd: must be a string`],
      [
        { t: { command: 'x', timeoutSeconds: 61 } },
        `${T}.t.timeoutSeconds: must be a whole number of seconds from 1 to 59, one second under sandbox.callTimeoutSeconds`,
      ],
      [
        { t: { command: 'x', timeoutSeconds: 0 } },
        `${T}.t.timeoutSeconds: must be a whole number of seconds from 1 to 59, one second under sandbox.callTimeoutSeconds`,
      ],
      [{ t: { command: 'x', timeoutSeconds: 1.5 } }, `${T}.t.timeoutSeconds: must be a whole number of seconds`],
      [
        { t: { command: 'x', env: { 'A=B': '1' } } },
        `${T}.t.env["A=B"]: the name must have letters, digits and underscores`,
      ],
      [{ t: { command: 'x', env: { A: 1 } } }, `${T}.t.env.A: must be a string`],
      [
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`t${i}`, { command: 'x' }])),
        `${T}: must have at most 32 tasks`,
      ],
    ]
    for (const [tasks, error] of cases) {
      const config = ok(withTasks(tasks))
      const entry = config.servers.get(key('workspace'))
      assert.equal(entry?.kind, 'invalid', error)
      const reasons = entry?.kind === 'invalid' ? entry.errors : []
      assert.ok(
        reasons.some(r => r.startsWith(error)),
        `${error} in ${JSON.stringify(reasons)}`,
      )
      assert.equal(config.servers.get(key('a'))?.kind, 'stdio', 'the other servers still start')
      assert.equal(config.guards.workspace, false)
    }
    const secret = ok(withTasks({ t: { command: 'hunter2/run', args: [1], cwd: 'hunter2/../x' } }))
    assert.ok(!JSON.stringify([...secret.servers]).includes('hunter2'), 'an error shows no value')
  })

  test('a Windows drive path is an absolute command on Windows only, and a drive-relative one is refused', () => {
    const at = (tasks: unknown) => ({ mcpServers: {}, workspace: { roots: [{ path: 'C:/work', tasks }] } })
    const win = ok(at({ t: { command: 'C:/Program Files/nodejs/node.exe' } }), {}, 'win32')
    assert.equal(win.workspace?.roots[0]?.tasks?.[0]?.command, 'C:/Program Files/nodejs/node.exe')
    assert.equal(ok(at({ t: { command: 'C:node.exe' } }), {}, 'win32').servers.get(key('workspace'))?.kind, 'invalid')
    assert.equal(ok(withTasks({ t: { command: 'C:/x/node.exe' } })).servers.get(key('workspace'))?.kind, 'invalid')
    const colon = ok(at({ t: { command: 'x', cwd: 'a:b' } }), {}, 'win32')
    assert.equal(
      colon.servers.get(key('workspace'))?.kind,
      'invalid',
      'a colon in a folder name is a stream on Windows',
    )
  })
})

describe('the instructions of a session whose Workspace config could not bind (issue #163)', () => {
  const instructionsOf = async (down: boolean): Promise<string> => {
    const config = ok({ mcpServers: {}, workspace: { roots: [{ path: '/work/a' }, { path: '/work/b' }] } })
    const downstream = connectAll(config.servers, '0', () => {}, {})
    const served = createServer(downstream, config, '/c.json', '0', () => {}, undefined, down)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([served.server.connect(a), client.connect(b)])
    const text = client.getInstructions() ?? ''
    await client.close()
    await served.stopRuns()
    await downstream.close()
    return text
  }

  test('a failed step gives the sentence and no workspace in the names, and a good one the text of main', async () => {
    const down = await instructionsOf(true)
    assert.match(
      down,
      /^toolscript connects to other MCP servers\. The built-in workspace server is not available in this session: search_tools says why\. /,
    )
    assert.doesNotMatch(down, /MCP servers:[^.]*workspace/)
    assert.match(await instructionsOf(false), /^toolscript connects to these MCP servers: workspace\. Find their tools/)
  })
})
