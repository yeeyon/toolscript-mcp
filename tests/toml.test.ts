import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCodexToml, TOML_MAX, UNREADABLE_ENTRY } from '../src/core/toml.ts'

const fixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-0.172.0', 'config.toml'),
  'utf8',
)

const servers = (text: string) => {
  const read = readCodexToml(text)
  assert.ok(read.ok, read.ok ? '' : read.why)
  return read.servers
}
const fields = (text: string, name: string) => {
  const found = servers(text).find(s => s.name === name)
  assert.ok(found && 'fields' in found, JSON.stringify(found))
  return found.fields
}
const skipped = (text: string, name: string) => {
  const found = servers(text).find(s => s.name === name)
  assert.ok(found && 'skip' in found, JSON.stringify(found))
  return found.skip
}
const refused = (text: string) => {
  const read = readCodexToml(text)
  assert.ok(!read.ok, 'it read the file')
  return read.why
}

describe('the strict reader of config.toml: the forms it reads', () => {
  test('the config.toml of Codex 0.172.0 with a fake home', () => {
    const all = servers(fixture)
    assert.deepEqual(
      all.map(s => s.name),
      ['files', 'docs', 'hdr', 'oauthy', 'off', 'with space'],
    )
    assert.deepEqual(fields(fixture, 'files'), {
      command: 'npx',
      args: ['-y', '@example/files-server', '--root', '/tmp/x'],
      env_vars: ['HOME_TOKEN'],
      cwd: '/tmp',
      env: { API_KEY: 'literal-secret-value', MODE: 'fast' },
    })
    assert.deepEqual(fields(fixture, 'hdr'), {
      url: 'https://example.com/hdr',
      http_headers: { 'X-Api-Key': 'literal-header-secret' },
      env_http_headers: { 'X-Org': 'ORG_VAR' },
      disabled_tools: ['danger'],
    })
    assert.equal(fields(fixture, 'off').enabled, false)
  })

  test('basic and literal strings with escapes, booleans, integers, a float, lists, inline tables, comments', () => {
    const text = [
      '# a comment',
      '[mcp_servers.a] # after a header',
      'command = "C:\\\\tools\\\\a.exe" # after a value',
      'args = [\'raw\\path\', "tab\\there", "\\u00e9\\U0001F600"]',
      'enabled = true',
      'startup_timeout_sec = 1_000',
      'tool_timeout_sec = 2.5',
      'env = { A = "1", "B C" = \'2\' }',
      'env_vars = [',
      '  "ONE", # first',
      '  "TWO",',
      ']',
    ].join('\n')
    assert.deepEqual(fields(text, 'a'), {
      command: 'C:\\tools\\a.exe',
      args: ['raw\\path', 'tab\there', 'é\u{1F600}'],
      enabled: true,
      startup_timeout_sec: 1000,
      tool_timeout_sec: 2.5,
      env: { A: '1', 'B C': '2' },
      env_vars: ['ONE', 'TWO'],
    })
  })

  test('sub-tables, quoted names, CRLF line ends, a byte order mark, and other tables that it skips over', () => {
    const text =
      '\ufeff' +
      [
        'model = "x"',
        '[profiles.p]',
        'note = """',
        '[mcp_servers.fake]',
        '"""',
        '[[skills.config]]',
        'path = "x"',
        '[mcp_servers."a.b"]',
        'command = "c"',
        '[mcp_servers."a.b".env]',
        'K = "v"',
        '[mcp_servers.b.http_headers]',
        'X = "y"',
        '[mcp_servers.b]',
        'url = "https://example.com/b"',
        '[projects."/x/y"]',
        'trust_level = "trusted"',
      ].join('\r\n')
    assert.deepEqual(
      servers(text).map(s => s.name),
      ['a.b', 'b'],
    )
    assert.deepEqual(fields(text, 'a.b'), { command: 'c', env: { K: 'v' } })
    assert.deepEqual(fields(text, 'b'), { http_headers: { X: 'y' }, url: 'https://example.com/b' })
  })

  test('a file with no mcp_servers table gives no server', () => {
    assert.deepEqual(servers('model = "x"\n[tui]\ntheme = "dark"\n'), [])
    assert.deepEqual(servers(''), [])
  })
})

describe('the strict reader of config.toml: the forms it refuses', () => {
  const entry = (line: string) => '[mcp_servers.s]\ncommand = "c"\n' + line + '\n'
  test('a server table with a form that it does not read is skipped, and the others are read', () => {
    const forms = [
      'a = """multi\nline"""',
      "a = '''multi\nline'''",
      'a = 0x10',
      'a = 1e3',
      'a = inf',
      'a = 1979-05-27',
      'a = [1, 2]',
      'a = [["x"]]',
      'a = [{ k = "v" }]',
      'a = { k = 1 }',
      'a = { k = { j = "v" } }',
      'a = { k.j = "v" }',
      'a.b = "x"',
      'a = 99999999999999999999',
    ]
    for (const form of forms) {
      const text = entry(form) + '[mcp_servers.t]\ncommand = "ok"\n'
      assert.equal(skipped(text, 's'), UNREADABLE_ENTRY, form)
      assert.deepEqual(fields(text, 't'), { command: 'ok' }, form)
    }
  })

  test('an array of tables, a deep sub-table, and a key that is also a sub-table skip the server', () => {
    const forms = [
      '[[mcp_servers.s.x]]\nk = "v"\n',
      '[mcp_servers.s.tools.t]\napproval_mode = "approve"\n',
      '[mcp_servers.s.env]\nA = "1"\n[mcp_servers.s.env.B]\nC = "2"\n',
      '[mcp_servers.s.x]\nk = 1\n',
    ]
    for (const form of forms) {
      const text = '[mcp_servers.s]\ncommand = "c"\n' + form + '[mcp_servers.t]\ncommand = "ok"\n'
      assert.equal(skipped(text, 's'), UNREADABLE_ENTRY, form)
      assert.deepEqual(fields(text, 't'), { command: 'ok' }, form)
    }
  })

  test('a key defined twice makes the file invalid TOML', () => {
    assert.match(refused('[mcp_servers.s]\ncommand = "a"\ncommand = "b"\n'), /^a key defined twice at line 4$/)
  })

  test('a table that is not valid TOML, or that holds mcp_servers in another form, gives no server at all', () => {
    const files = [
      '[mcp_servers.a]\ncommand = "x" junk\n',
      '[mcp_servers.a\ncommand = "x"\n',
      '[mcp_servers.a]\ncommand = "unterminated\n',
      '[mcp_servers.a]\ncommand = "bad \\q escape"\n',
      '[mcp_servers.a]\ncommand\n',
      '[mcp_servers.a]\n[mcp_servers.a]\n',
      '[mcp_servers]\na = { command = "x" }\n',
      'mcp_servers.a.command = "x"\n',
      'mcp_servers = { a = { command = "x" } }\n',
      '[[mcp_servers]]\ncommand = "x"\n',
      '[mcp_servers.a]\nenv = { A = "1"\n',
      '[mcp_servers.a]\nargs = ["x"\n',
      '[mcp_servers.a]\nx = "\\ud800"\n',
      '[mcp_servers.a]\nx = ]\n',
      '= "x"\n',
      '[]\n',
    ]
    for (const text of files) assert.ok(!readCodexToml(text).ok, JSON.stringify(text))
  })

  test('a reason holds no text of the file', () => {
    const why = refused('[mcp_servers.a]\ncommand = "x" fake-secret-value\n')
    assert.ok(!why.includes('fake-secret-value'), why)
    assert.match(why, /line 2$/)
  })
})

describe('the strict reader of config.toml: hostile input', () => {
  const quick = (text: string) => {
    const start = Date.now()
    const read = readCodexToml(text)
    assert.ok(Date.now() - start < 3000, 'it took too long')
    return read
  }

  test('a file over 1 MB gives no server, and does not read it', () => {
    const read = quick('[mcp_servers.a]\ncommand = "' + 'x'.repeat(TOML_MAX) + '"\n')
    assert.deepEqual(read, { ok: false, why: 'the file is larger than 1 MB' })
  })

  test('values nested 100,000 deep are refused without a stack overflow', () => {
    for (const [open, close] of [
      ['[', ']'],
      ['{ a = ', ' }'],
    ] as const) {
      const read = quick('[mcp_servers.a]\nx = ' + open.repeat(100_000) + close.repeat(100_000) + '\n')
      assert.ok(!read.ok, open)
    }
  })

  test('many tables, a line of 900,000 characters, binary bytes and a lone surrogate end in an answer', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => '[mcp_servers.s' + i + ']\ncommand = "c"\n').join('')
    const read = quick(many)
    assert.ok(read.ok && read.servers.length === 20_000)
    assert.ok(quick('[mcp_servers.a]\nx = "' + 'y'.repeat(900_000) + '"\n').ok)
    assert.ok(!quick('\u0000\u0001\u0002 = ???\n').ok)
    assert.ok(!quick('[' + '['.repeat(50_000) + '\n').ok)
  })

  test('a server name that is a prototype key is a plain name', () => {
    const text = '[mcp_servers.__proto__]\ncommand = "c"\n[mcp_servers.constructor]\ncommand = "d"\n'
    assert.deepEqual(
      servers(text).map(s => s.name),
      ['__proto__', 'constructor'],
    )
    assert.equal(({} as Record<string, unknown>).command, undefined)
  })
})
