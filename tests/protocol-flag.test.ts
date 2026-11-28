// The protocol switch of #154, PR 9: read from the environment only, carried to the link, and keyed into sharing. It changes
// no wire. `TOOLSCRIPT_PROTOCOL` (legacy or auto) is the host value, `TOOLSCRIPT_LEGACY_SERVERS` the servers that stay on legacy.
// No config key holds either: 1.0.5 refuses an unknown key, so a key would break a rollback.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from './sdk.mjs'
import { entryFrame, entryText, parseEntry, type Entry } from '../src/core/broker.ts'
import { parseConfig, protocolOf, unknownLegacyLine, type Env, type ProtocolSwitch } from '../src/core/config.ts'
import { protocolFindings } from '../src/core/doctor.ts'
import { shareText } from '../src/core/share.ts'
import { startBroker } from '../src/host/broker.ts'
import { BrokerTransport, entryOf } from '../src/host/brokerlink.ts'
import { serverEntry, text } from './broker-rig.ts'

const SERVERS = {
  alpha: { command: 'node', args: ['a.js'] },
  beta: { command: 'node', args: ['b.js'] },
  gamma: { command: 'node', args: ['c.js'] },
}
const load = (env: Env, config: object = { mcpServers: SERVERS }) =>
  parseConfig(JSON.stringify(config), env, '/usr/bin/node', 'linux')
const switchOf = (env: Env, config?: object): ProtocolSwitch => {
  const parsed = load(env, config)
  assert.ok(parsed.ok, JSON.stringify(parsed))
  assert.ok(parsed.config.protocol !== undefined)
  return parsed.config.protocol
}
const linkOf = (env: Env) => {
  const p = switchOf(env)
  return Object.fromEntries(['alpha', 'beta', 'gamma', 'workspace', 'other'].map(k => [k, protocolOf(p, k)]))
}

describe('the switch in the environment', () => {
  test('unset and empty are legacy by default, each value is read, and a config with no switch has none', () => {
    for (const env of [{}, { TOOLSCRIPT_PROTOCOL: '' }]) {
      const p = switchOf(env)
      assert.deepEqual([p.value, p.source], ['legacy', 'default'])
    }
    assert.deepEqual(
      [switchOf({ TOOLSCRIPT_PROTOCOL: 'legacy' }).value, switchOf({ TOOLSCRIPT_PROTOCOL: 'legacy' }).source],
      ['legacy', 'env'],
    )
    assert.deepEqual(
      [switchOf({ TOOLSCRIPT_PROTOCOL: 'auto' }).value, switchOf({ TOOLSCRIPT_PROTOCOL: 'auto' }).source],
      ['auto', 'env'],
    )
    // A Config built by hand has no switch: every link is legacy.
    assert.equal(protocolOf(undefined, 'alpha'), 'legacy')
  })

  test('another value is a config error that never repeats the value', () => {
    for (const value of ['modern', 'AUTO', '1', 'auto ', 'sk-secret-123']) {
      const parsed = load({ TOOLSCRIPT_PROTOCOL: value })
      assert.ok(!parsed.ok)
      assert.deepEqual(parsed.errors, ['TOOLSCRIPT_PROTOCOL: must be legacy or auto'])
    }
  })

  test('the list keeps its servers on legacy under auto, and does nothing under legacy', () => {
    const auto = { TOOLSCRIPT_PROTOCOL: 'auto' }
    const rows: [string, Env, Record<string, string>][] = [
      ['no list', auto, { alpha: 'auto', beta: 'auto', gamma: 'auto', other: 'auto' }],
      ['one key', { ...auto, TOOLSCRIPT_LEGACY_SERVERS: 'beta' }, { alpha: 'auto', beta: 'legacy', gamma: 'auto' }],
      [
        'several keys',
        { ...auto, TOOLSCRIPT_LEGACY_SERVERS: 'alpha,gamma' },
        { alpha: 'legacy', beta: 'auto', gamma: 'legacy' },
      ],
      [
        'spaces and empty items',
        { ...auto, TOOLSCRIPT_LEGACY_SERVERS: ' alpha , ,, gamma ,' },
        { alpha: 'legacy', gamma: 'legacy', beta: 'auto' },
      ],
      ['a key twice', { ...auto, TOOLSCRIPT_LEGACY_SERVERS: 'beta,beta' }, { beta: 'legacy', alpha: 'auto' }],
      ['a key that is not a server', { ...auto, TOOLSCRIPT_LEGACY_SERVERS: 'other' }, { alpha: 'auto', other: 'auto' }],
      [
        'the Workspace key',
        { ...auto, TOOLSCRIPT_LEGACY_SERVERS: 'workspace' },
        { workspace: 'legacy', alpha: 'auto' },
      ],
      ['an empty value', { ...auto, TOOLSCRIPT_LEGACY_SERVERS: '' }, { alpha: 'auto' }],
      [
        'legacy host and a list',
        { TOOLSCRIPT_PROTOCOL: 'legacy', TOOLSCRIPT_LEGACY_SERVERS: 'alpha' },
        { alpha: 'legacy', beta: 'legacy' },
      ],
      ['default host and a list', { TOOLSCRIPT_LEGACY_SERVERS: 'alpha' }, { alpha: 'legacy', beta: 'legacy' }],
    ]
    for (const [name, env, want] of rows) assert.deepEqual({ ...linkOf(env), ...want }, linkOf(env), name)
    for (const [name, env, want] of rows)
      for (const [key, value] of Object.entries(want)) assert.equal(linkOf(env)[key], value, `${name}: ${key}`)
  })

  test('an item that names no server is never fatal: key-shaped ones are named, at most 10, the rest are counted', () => {
    const auto = { TOOLSCRIPT_PROTOCOL: 'auto' }
    const line = (list: string) => unknownLegacyLine(switchOf({ ...auto, TOOLSCRIPT_LEGACY_SERVERS: list }))
    assert.equal(line('alpha,beta'), undefined)
    assert.equal(line('nope'), 'TOOLSCRIPT_LEGACY_SERVERS names no server of the config: nope')
    const twelve = Array.from({ length: 12 }, (_, i) => `x${i}`)
    assert.equal(
      line(twelve.join(',')),
      `TOOLSCRIPT_LEGACY_SERVERS names no server of the config: ${twelve.slice(0, 10).join(', ')}, and 2 more`,
    )
    // Text that is not a server key is never printed, only counted.
    assert.equal(
      line('a b,c/d,sk-secret=1 2'),
      'TOOLSCRIPT_LEGACY_SERVERS names no server of the config: 3 items that are not server keys',
    )
    assert.equal(line('nope,a b'), 'TOOLSCRIPT_LEGACY_SERVERS names no server of the config: nope, and 1 more')
    for (const list of ['nope', 'a b,c/d', twelve.join(',')])
      assert.ok(load({ ...auto, TOOLSCRIPT_LEGACY_SERVERS: list }).ok)
    assert.equal(unknownLegacyLine(undefined), undefined)
  })

  test('the config file gains no key: "protocol" at the top or on an entry gets the unknown-key errors of today', () => {
    const top = load({}, { mcpServers: SERVERS, protocol: 'auto' })
    assert.ok(!top.ok)
    assert.match(top.errors.join('\n'), /protocol: unknown key/)
    const entry = load({}, { mcpServers: { alpha: { command: 'node', protocol: 'legacy' } } })
    assert.ok(entry.ok)
    assert.equal(entry.config.servers.get('alpha' as never)?.kind, 'invalid')
    assert.match(JSON.stringify([...entry.config.servers.values()]), /unknown key/)
  })
})

describe('the doctor line', () => {
  const findings = (env: Env) => {
    const parsed = load(env)
    assert.ok(parsed.ok)
    return protocolFindings(parsed.config).map(f => `${f.status}: ${f.detail}`)
  }
  test('a setup that sets neither variable gets no line; the others get fixed words and server keys', () => {
    assert.deepEqual(findings({}), [])
    assert.deepEqual(findings({ TOOLSCRIPT_PROTOCOL: 'auto' }), ['info: host value auto (TOOLSCRIPT_PROTOCOL)'])
    assert.deepEqual(findings({ TOOLSCRIPT_PROTOCOL: 'legacy' }), ['info: host value legacy (TOOLSCRIPT_PROTOCOL)'])
    assert.deepEqual(findings({ TOOLSCRIPT_PROTOCOL: 'auto', TOOLSCRIPT_LEGACY_SERVERS: 'gamma, alpha, nope, a b' }), [
      'info: host value auto (TOOLSCRIPT_PROTOCOL); kept on legacy by TOOLSCRIPT_LEGACY_SERVERS: alpha, gamma',
    ])
    assert.deepEqual(findings({ TOOLSCRIPT_LEGACY_SERVERS: 'beta' }), [
      'info: host value legacy (the default); kept on legacy by TOOLSCRIPT_LEGACY_SERVERS: beta',
    ])
  })
})

describe('the entry and the share key', () => {
  const server = { kind: 'stdio', command: 'cmd', args: ['a'], env: {}, cwd: '/work' } as const
  const keyed = { class: 'folder', rule: 5 } as const
  const at = { home: '/home', folder: '/work' }

  test('the share text and the entry frame of a legacy link are the bytes of 1.0.5', () => {
    // Recorded at base (v1.0.5): the golden of both.
    assert.equal(shareText(keyed, server, { A: '1' }, at), '["toolscript-share","cmd",["a"],[["A","1"]],"/work"]')
    const legacy: Entry = { command: 'cmd', args: ['a'], env: { A: '1' }, folder: '/work' }
    assert.equal(entryFrame(legacy), '{"t":"entry","command":"cmd","args":["a"],"env":{"A":"1"},"folder":"/work"}\n')
    assert.equal(entryText(legacy), '["toolscript-share","cmd",["a"],[["A","1"]],"/work"]')
    // entryOf gives no `protocol` key for legacy, also when it is passed.
    const fromHost = entryOf({ ...server, env: {} }, keyed, at, 'legacy')
    assert.ok(!('protocol' in fromHost))
    assert.deepEqual(Object.keys(fromHost), ['command', 'args', 'env', 'folder'])
    assert.equal(JSON.stringify(entryOf({ ...server, env: {} }, keyed, at)), JSON.stringify(fromHost))
  })

  test('an auto link has another key, and two auto links the same one', () => {
    const legacy: Entry = { command: 'cmd', args: ['a'], env: { A: '1' }, folder: '/work' }
    const auto: Entry = { ...legacy, protocol: 'auto' }
    assert.notEqual(entryText(auto), entryText(legacy))
    assert.equal(entryText(auto), entryText({ ...auto }))
    assert.equal(
      entryFrame(auto),
      '{"t":"entry","command":"cmd","args":["a"],"env":{"A":"1"},"folder":"/work","protocol":"auto"}\n',
    )
    assert.equal(entryOf({ ...server, env: {} }, keyed, at, 'auto').protocol, 'auto')
  })

  test('parseEntry takes an absent protocol and auto, and gives a reason for any other value and no child', () => {
    const frame = { t: 'entry', command: 'c', args: [], env: {}, folder: '/f' }
    assert.deepEqual(parseEntry(frame), { command: 'c', args: [], env: {}, folder: '/f' })
    assert.deepEqual(parseEntry({ ...frame, protocol: 'auto' }), {
      command: 'c',
      args: [],
      env: {},
      folder: '/f',
      protocol: 'auto',
    })
    for (const bad of ['legacy', 'AUTO', '', 2026, null, {}, ['auto']])
      assert.equal(parseEntry({ ...frame, protocol: bad }), 'the entry has a bad protocol')
  })
})

describe('one broker', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-protocol-flag-')))
  const clients: Client[] = []
  const stops: (() => Promise<void>)[] = []
  after(async () => {
    for (const c of clients) await c.close().catch(() => {})
    for (const stop of stops) await stop()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })

  test('a legacy link and an auto link of one command get two children, two auto links get one', async () => {
    const home = fs.mkdtempSync(path.join(root, 'h-'))
    const file = path.join(home, 'broker.js')
    fs.writeFileSync(file, 'build one')
    const broker = await startBroker({ home, idleMs: 600_000, file })
    assert.ok(broker, 'the broker listens')
    stops.push(() => broker.stop())
    const connect = async (entry: Entry): Promise<string> => {
      const client = new Client({ name: 'test', version: '0' })
      clients.push(client)
      await client.connect(new BrokerTransport({ home, brokerFile: file, entry }))
      return text(client, 'pid')
    }
    const legacy = serverEntry(root)
    const auto: Entry = { ...legacy, protocol: 'auto' }
    const [l1, l2, a1, a2] = [await connect(legacy), await connect(legacy), await connect(auto), await connect(auto)]
    assert.equal(l1, l2, 'two legacy links share one child')
    assert.equal(a1, a2, 'two auto links share one child')
    assert.notEqual(l1, a1, 'a legacy link and an auto link never share a child')
  })
})
