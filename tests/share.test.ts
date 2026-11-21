// The class and the share key of a stdio server (src/core/share.ts): the rules, the rows of realistic entries on both
// platforms, and the properties of the key. Every name and value is fake.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, serverKey, type ServerEntry, type StdioServer } from '../src/core/config.ts'
import { classify, shareText, type Class, type Keyed } from '../src/core/share.ts'

const PLATFORMS = [
  ['linux', '/work/app'],
  ['win32', 'C:/work/app'],
] as const

/** The class of each entry of a config, as `parseConfig` reads it on a platform. */
const classes = (servers: Record<string, object>, platform: string): Record<string, Class | undefined> => {
  const parsed = parseConfig(JSON.stringify({ mcpServers: servers }), {}, '/usr/bin/node', platform)
  assert.ok(parsed.ok)
  const { config } = parsed
  return Object.fromEntries([...config.servers].map(([k, s]) => [k, classify(k, s, config.bridges)]))
}
const one = (key: string, entry: object, platform = 'linux') => classes({ [key]: entry }, platform)[key]
const label = (c: Class | undefined) => (c === undefined ? 'none' : `${c.class}:${c.rule}`)

describe('the class of a server', () => {
  for (const [platform, cwd] of PLATFORMS) {
    test(`the rows of realistic entries (${platform})`, () => {
      const docker = ['run', '-i', '--rm', '-e', 'GRAFANA_URL', '-e', 'GRAFANA_API_KEY', 'mcp/grafana', '-t', 'stdio']
      const rows: [string, string, object, string][] = [
        [
          'grafana',
          'docker',
          { command: 'docker', args: docker, env: { GRAFANA_URL: 'https://a.example.com' } },
          'folder:5',
        ],
        ['grafana', 'node', { command: 'node', args: [cwd + '/index.js'] }, 'folder:5'],
        ['grafana', 'share true', { command: 'docker', args: docker, share: true }, 'shared:2'],
        [
          'azure',
          'cmd npx',
          { command: 'cmd', args: ['/c', 'npx', '-y', '@azure-devops/mcp', 'fake-org'], env: { A: '1' } },
          'folder:5',
        ],
        ['azure', 'node + true', { command: 'node', args: ['x.js'], share: true }, 'shared:2'],
        [
          'github',
          'docker',
          { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'] },
          'folder:5',
        ],
        ['github', 'cwd', { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'], cwd }, 'shared:4'],
        ['claude-code', 'key', { command: 'claude', args: ['mcp', 'serve'] }, 'session:1'],
        ['claude-code', 'key, share false', { command: 'x', share: false }, 'session:1'],
        ['other', 'claude mcp serve', { command: 'claude', args: ['mcp', 'serve'] }, 'session:1'],
        [
          'other',
          'claude mcp serve, share false',
          { command: 'claude', args: ['mcp', 'serve'], share: false },
          'session:1',
        ],
        ['files', 'dot', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, 'folder:5'],
        [
          'files',
          './docs',
          { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './docs'] },
          'folder:5',
        ],
        [
          'files',
          'absolute',
          { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work/docs'] },
          'folder:5',
        ],
        ['files', 'no path', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }, 'folder:5'],
        ['pw', 'playwright', { command: 'npx', args: ['@playwright/mcp@latest'] }, 'session:3'],
        ['pw', 'playwright + true', { command: 'npx', args: ['@playwright/mcp@latest'], share: true }, 'shared:2'],
        ['browser', 'key', { command: 'node', args: ['x.js'] }, 'session:3'],
        ['desktop-commander', 'key', { command: 'node', args: ['x.js'] }, 'session:3'],
        ['desktop-commander', 'key + true', { command: 'node', args: ['x.js'], share: true }, 'shared:2'],
        ['git', 'uvx', { command: 'uvx', args: ['mcp-server-git'] }, 'folder:5'],
        ['git', 'repository', { command: 'uvx', args: ['mcp-server-git', '--repository', 'C:/repo'] }, 'folder:5'],
        ['git', 'cwd', { command: 'uvx', args: ['mcp-server-git'], cwd }, 'shared:4'],
        ['atlassian', 'http', { type: 'http', url: 'https://mcp.example.com/mcp' }, 'none'],
      ]
      for (const [key, name, entry, want] of rows)
        assert.equal(label(one(key, entry, platform)), want, `${key}: ${name}`)
    })
  }

  test('the first rule that matches wins', () => {
    const state = { command: 'npx', args: ['@playwright/mcp'] }
    assert.equal(label(one('x', { ...state, share: 'folder' })), 'folder:2')
    assert.equal(label(one('x', { ...state, share: false })), 'session:2')
    assert.equal(label(one('x', { ...state, cwd: '/work/app' })), 'session:3', 'a state word beats cwd')
    assert.equal(label(one('x', { command: 'node', cwd: '/work/app', share: 'folder' })), 'folder:2')
    assert.equal(label(one('x', { command: 'node', cwd: '/work/app', share: false })), 'session:2')
  })

  test('a state word names itself and its reason, in the key, the command or an argument', () => {
    const find = (c: Class | undefined) => (c?.class === 'session' && c.rule === 3 ? c.word : undefined)
    assert.equal(find(one('playwright', { command: 'node' })), 'playwright')
    assert.equal(find(one('x', { command: '/opt/selenium/run' })), 'selenium')
    assert.equal(find(one('x', { command: 'node', args: ['a', 'Chrome-DevTools-MCP'] })), 'chrome-devtools')
    assert.equal(find(one('x', { command: 'npx', args: ['@browsermcp/mcp'] })), 'browsermcp')
    assert.equal(find(one('x', { command: 'npx', args: ['@x/browser-tools'] })), 'browser')
    assert.equal(find(one('x', { command: 'npx', args: ['puppeteer-mcp'] })), 'puppeteer')
    const reason = one('x', { command: 'node', args: ['shell-server'] })
    assert.ok(reason?.class === 'session' && reason.rule === 3 && reason.reason.length > 0)
  })

  test('a word counts between non-letters only, with an s allowed at its end', () => {
    const state = (name: string) => label(one('x', { command: 'node', args: [name] })) === 'session:3'
    for (const name of [
      'shell',
      'SHELL',
      'my_shell_server',
      'shells',
      'a-terminal',
      'terminals',
      'run-shell2',
      '@x/browsers',
      'PlayWright',
    ])
      assert.equal(state(name), true, name)
    for (const name of [
      'fnm_multishells',
      'shellcheck-docs',
      'bashell',
      'terminalx',
      'xbrowser',
      'shellshock',
      'browsermc',
    ])
      assert.equal(state(name), false, name)
    assert.equal(label(one('fnm_multishells', { command: 'node' })), 'folder:5')
    assert.equal(label(one('shellcheck-docs', { command: 'node' })), 'folder:5')
  })

  test('no match is folder, and a hostile long argument ends quickly', () => {
    const start = performance.now()
    assert.equal(label(one('x', { command: 'node', args: ['a'.repeat(200_000), 'shell'.repeat(40_000)] })), 'folder:5')
    assert.ok(performance.now() - start < 1000)
  })

  test('an invalid entry has no class', () => {
    const invalid: ServerEntry = { kind: 'invalid', errors: ['x'] }
    assert.equal(classify(serverKey('x')!, invalid, new Set()), undefined)
  })

  test('a session class holds no key: only a keyed class goes to shareText', () => {
    const c = one('claude-code', { command: 'claude', args: ['mcp', 'serve'] })!
    assert.ok(!('key' in c))
    // @ts-expect-error a session class is not a Keyed class
    const bad: Keyed = c
    assert.ok(bad)
  })
})

describe('the share key text', () => {
  const server = (extra: Partial<StdioServer> = {}): StdioServer => ({
    kind: 'stdio',
    command: 'docker',
    args: ['run', '-i', 'mcp/fake'],
    env: {},
    ...extra,
  })
  const ENV = { PATH: '/usr/bin', A: '1', B: '2' }
  const home = { home: '/home/me', folder: '/work/one' }
  const folder: Keyed = { class: 'folder', rule: 5 }
  const shared: Keyed = { class: 'shared', rule: 2 }
  const text = (c: Keyed, s = server(), env: Record<string, string> = ENV, at = home) => shareText(c, s, env, at)

  test('is the same for another order of env keys, another server key and another share or untrusted', () => {
    const base = text(folder)
    assert.equal(text(folder, server(), { B: '2', A: '1', PATH: '/usr/bin' }), base)
    assert.equal(text(folder, server({ untrusted: true })), base)
    assert.equal(text({ class: 'folder', rule: 2 }, server({ share: 'folder' })), base)
  })

  test('differs for a changed command, argument, argument order, env value, env name, PATH or folder', () => {
    const base = text(folder)
    const others = [
      text(folder, server({ command: 'podman' })),
      text(folder, server({ args: ['run', '-i', 'mcp/other'] })),
      text(folder, server({ args: ['-i', 'run', 'mcp/fake'] })),
      text(folder, server({ args: ['run', '-i'] })),
      text(folder, server(), { ...ENV, A: '9' }),
      text(folder, server(), { ...ENV, C: '1' }),
      text(folder, server(), { ...ENV, A: undefined as never }),
      text(folder, server(), { ...ENV, PATH: '/usr/local/bin' }),
      text(folder, server(), { A: '1', B: '2' }),
      text(folder, server(), ENV, { ...home, folder: '/work/two' }),
      text(folder, server({ cwd: '/work/x' })),
    ]
    assert.equal(new Set([base, ...others]).size, others.length + 1)
  })

  test('holds each part apart: no two different inputs give one text', () => {
    const pairs: [StdioServer, Record<string, string>][] = [
      [server({ args: ['a b'] }), { PATH: 'x' }],
      [server({ args: ['a', 'b'] }), { PATH: 'x' }],
      [server({ args: ['a,b'] }), { PATH: 'x' }],
      [server({ command: 'docker run', args: [] }), { PATH: 'x' }],
      [server({ command: 'docker', args: ['run'] }), { PATH: 'x' }],
      [server({ args: [] }), { 'A=1': '', PATH: 'x' }],
      [server({ args: [] }), { A: '1=', PATH: 'x' }],
      [server({ args: [] }), { A: '1', PATH: 'x' }],
      [server({ args: ['"'] }), { PATH: 'x' }],
      [server({ args: ['","'] }), { PATH: 'x' }],
    ]
    const texts = pairs.map(([s, env]) => text(folder, s, env))
    assert.equal(new Set(texts).size, pairs.length)
  })

  test('sessions in two folders get two keys for a folder entry and one key for a shared entry', () => {
    const one = { home: '/home/me', folder: '/work/one' }
    const two = { home: '/home/me', folder: '/work/two' }
    assert.notEqual(text(folder, server(), ENV, one), text(folder, server(), ENV, two))
    assert.equal(text(shared, server(), ENV, one), text(shared, server(), ENV, two))
    const cwd = server({ cwd: '/fixed' })
    assert.equal(text({ class: 'shared', rule: 4 }, cwd, ENV, one), text({ class: 'shared', rule: 4 }, cwd, ENV, two))
    assert.equal(text({ class: 'folder', rule: 2 }, cwd, ENV, one), text({ class: 'folder', rule: 2 }, cwd, ENV, two))
  })

  test('a shared entry without cwd runs in the home folder, a folder entry in the folder of the host', () => {
    const at = { home: '/home/me', folder: '/work/one' }
    assert.ok(text(shared, server(), ENV, at).includes('/home/me'))
    assert.ok(!text(shared, server(), ENV, at).includes('/work/one'))
    assert.ok(text(folder, server(), ENV, at).includes('/work/one'))
  })

  test('three entries of one command with another env value each give three keys, and one with another key order the same', () => {
    const entry = (token: string, order: boolean) => {
      const env = order ? { GRAFANA_URL: 'u', GRAFANA_API_KEY: token } : { GRAFANA_API_KEY: token, GRAFANA_URL: 'u' }
      return text(shared, server({ env }), { ...ENV, ...env })
    }
    assert.equal(new Set([entry('t1', true), entry('t2', true), entry('t3', true)]).size, 3)
    assert.equal(entry('t1', true), entry('t1', false))
  })
})
