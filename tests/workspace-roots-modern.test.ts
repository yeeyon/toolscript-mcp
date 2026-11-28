// The roots round of a 2026-07-28 connection (issue #154, P3-2): the sealed state, the decisions of a call, and gate G6, the same roots
// on a legacy column (the push of roots/list, as the list settles there) and a modern column (the round of the first call), on real temp
// trees. The two columns must give the same session root for every row.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIMITS } from '../src/core/workspace.ts'
import { createRoots } from '../src/host/workspace/roots.ts'
import {
  NO_WORKSPACE_LINE,
  ROOTS_ASKS_MAX,
  createRootsRound,
  declaresRoots,
  urisOf,
} from '../src/host/workspace/rootsround.ts'
import {
  STATES_OPEN_MAX,
  STATE_TTL_MS,
  callHash,
  canonical,
  createRootsState,
  createSealer,
  open as openState,
  seal as sealState,
} from '../src/host/workspace/rootsstate.ts'
import { open, rm, tempDir, write, type Rig } from './workspace-rig.ts'

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url')

describe('seal and open, the pair that a kind is built on', () => {
  test('a state carries its kind and its fields, opens once, and only for its own kind', () => {
    const sealer = createSealer()
    const text = sealer.seal('roots', { c: 'abc', n: 7 })
    assert.equal(JSON.parse(Buffer.from(text.split('.')[0]!, 'base64url').toString()).k, 'roots')
    assert.deepEqual(
      sealer.open('approval', text),
      { ok: false, reason: 'kind' },
      'another kind is refused and the state is used up',
    )
    assert.deepEqual(sealer.open('roots', text), { ok: false, reason: 'used' })
    const again = sealer.seal('approval', { a: 'x' })
    assert.deepEqual(sealer.open('approval', again), { ok: true, fields: { a: 'x' } })
    assert.equal(sealer.count(), 0)
    const fields = sealer.seal('roots', { c: 'abc', n: 7 })
    assert.deepEqual(sealer.open('roots', fields), { ok: true, fields: { c: 'abc', n: 7 } })
  })

  test('the pair of the process works with the key that was made at the start', () => {
    const text = sealState('approval', { c: 'x' })
    assert.deepEqual(openState('approval', text), { ok: true, fields: { c: 'x' } })
    assert.deepEqual(openState('approval', text), { ok: false, reason: 'used' })
    assert.equal(
      createSealer().open('approval', sealState('approval', { c: 'y' })).ok,
      false,
      'another sealer has another key',
    )
  })
})

describe('the sealed state', () => {
  const ARGS = { code: 'return 1' }

  test('a state is taken once, for the call that it was minted for', () => {
    const state = createRootsState()
    const minted = state.mint('run_code', ARGS)
    assert.equal(state.open(), 1)
    assert.equal(state.take(minted, 'run_code', ARGS), 'ok')
    assert.equal(state.open(), 0)
    assert.equal(state.take(minted, 'run_code', ARGS), 'used', 'a replayed retry')
  })

  test('arguments that differ by one byte, or another tool, are refused, and the state is used up', () => {
    const state = createRootsState()
    for (const [tool, args] of [
      ['run_code', { code: 'return 2' }],
      ['search_tools', ARGS],
      ['run_code', { code: 'return 1 ' }],
      ['run_code', {}],
    ] as const) {
      const minted = state.mint('run_code', ARGS)
      assert.equal(state.take(minted, tool, args), 'call')
      assert.equal(state.take(minted, 'run_code', ARGS), 'used', 'a refused state is gone')
    }
    // The key order of the arguments does not matter.
    const a = state.mint('run_code', { x: 1, y: [1, { b: 2, a: 1 }] })
    assert.equal(state.take(a, 'run_code', { y: [1, { a: 1, b: 2 }], x: 1 }), 'ok')
    assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}')
    assert.notEqual(callHash('run_code', ARGS), callHash('search_tools', ARGS))
  })

  test('one flipped character in each part, a missing part, an extra part and a long string are refused', () => {
    const state = createRootsState()
    const minted = state.mint('run_code', ARGS)
    const [body, tag] = minted.split('.') as [string, string]
    const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1)
    for (const bad of [`${flip(body, 10)}.${tag}`, `${body}.${flip(tag, 5)}`, `${body}.${tag.slice(1)}`]) {
      assert.equal(state.take(bad, 'run_code', ARGS), 'mac', bad)
    }
    for (const bad of [body, '', `${body}.${tag}.x`, 'x'.repeat(513)])
      assert.equal(state.take(bad, 'run_code', ARGS), 'malformed', bad)
    assert.equal(state.take(minted, 'run_code', ARGS), 'ok', 'the good state still works after all of that')
  })

  test('a state of another kind, signed with the key, is refused; a state of another process is a bad mac', () => {
    const key = randomBytes(32)
    const state = createRootsState({ key })
    const sign = (payload: unknown): string => {
      const body = b64(JSON.stringify(payload))
      return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`
    }
    const real = JSON.parse(Buffer.from(state.mint('run_code', ARGS).split('.')[0]!, 'base64url').toString())
    assert.equal(state.take(sign({ ...real, k: 'tools' }), 'run_code', ARGS), 'kind')
    assert.equal(state.take(sign({ ...real, v: 2 }), 'run_code', ARGS), 'malformed')
    assert.equal(state.take(sign({ ...real, n: 5 }), 'run_code', ARGS), 'malformed')
    const minted = state.mint('run_code', ARGS)
    assert.equal(createRootsState().take(minted, 'run_code', ARGS), 'mac', 'a restart ends every open state')
  })

  test('a state of 601 s is expired, one of 600 s is not; the table keeps at most 256 and sweeps the expired', () => {
    let now = 1_000_000
    const state = createRootsState({ now: () => now })
    const fresh = state.mint('run_code', ARGS)
    const old = state.mint('run_code', ARGS)
    now += STATE_TTL_MS - 1
    assert.equal(state.take(fresh, 'run_code', ARGS), 'ok')
    now += 2
    assert.equal(state.take(old, 'run_code', ARGS), 'expired')
    assert.equal(state.open(), 0, 'the sweep dropped it')
    const many = Array.from({ length: STATES_OPEN_MAX + 5 }, () => state.mint('run_code', ARGS))
    assert.equal(state.open(), STATES_OPEN_MAX)
    assert.equal(state.take(many[0]!, 'run_code', ARGS), 'used', 'the oldest was dropped')
    assert.equal(state.take(many.at(-1)!, 'run_code', ARGS), 'ok')
  })

  test('the payload holds no program text, no tool name and no path, and the whole state is at most 512 characters', () => {
    const state = createRootsState()
    const minted = state.mint('run_code', { code: 'SECRET-PROGRAM-TEXT /home/secret/path' })
    assert.ok(minted.length <= 512, String(minted.length))
    const text = Buffer.from(minted.split('.')[0]!, 'base64url').toString()
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['e', 'f', 'k', 'n', 'v'])
    assert.ok(!/SECRET|secret|run_code/.test(text))
  })
})

const fakeRoots = () => {
  const calls: string[] = []
  let done = false
  return {
    calls,
    isSettled: () => done,
    answer: (uris: readonly string[]) => {
      if (done) return
      done = true
      calls.push(`answer ${uris.length}`)
    },
    modern: () => {
      if (done) return
      done = true
      calls.push('modern')
    },
  }
}
const CAPS = { roots: { listChanged: true }, elicitation: { form: {} } }
const answer = (uris: string[]) => ({ roots: { roots: uris.map(uri => ({ uri })) } })

describe('what a call does', () => {
  const rig = () => {
    const roots = fakeRoots()
    const lines: string[] = []
    return { roots, lines, round: createRootsRound({ roots, log: l => lines.push(l) }) }
  }
  const ARGS = { code: 'return 1' }

  test('a first call that declares roots is asked; its retry with the state settles the list and goes on', () => {
    const { roots, round, lines } = rig()
    const first = round.round('run_code', ARGS, { capabilities: CAPS })
    assert.equal(first.kind, 'ask')
    const state = (first as { state: string }).state
    assert.equal(roots.isSettled(), false)
    assert.deepEqual(round.round('run_code', ARGS, { requestState: state, inputResponses: answer(['file:///a']) }), {
      kind: 'go',
    })
    assert.deepEqual(roots.calls, ['answer 1'])
    assert.deepEqual(lines, [])
    // Once settled, no call is asked again, whatever its capabilities.
    assert.deepEqual(round.round('run_code', { code: 'x' }, { capabilities: CAPS }), { kind: 'go' })
    assert.deepEqual(round.round('search_tools', {}, {}), { kind: 'go' })
  })

  test('a first call that declares no roots is not asked: no Workspace, the fixed line once, no client text', () => {
    for (const capabilities of [undefined, {}, { roots: null }, { roots: 'x' }, { elicitation: {} }, [], 'roots']) {
      const { roots, round, lines } = rig()
      assert.deepEqual(round.round('run_code', ARGS, { capabilities }), { kind: 'go' })
      assert.deepEqual(round.round('run_code', ARGS, { capabilities }), { kind: 'go' })
      assert.deepEqual(roots.calls, ['modern'])
      assert.deepEqual(lines, [NO_WORKSPACE_LINE])
    }
    assert.equal(declaresRoots({ roots: {} }), true)
    assert.equal(declaresRoots({ roots: { listChanged: true } }), true)
  })

  test('a retry with no roots entry, an error, or a wrong shape: no Workspace for the process', () => {
    const wrong: unknown[] = [
      {},
      { roots: { code: -32601, message: 'no' } },
      { roots: { error: { code: 1 } } },
      { roots: { roots: 'x' } },
      { roots: { roots: { uri: 'file:///a' } } },
      { roots: { roots: [{ uri: 5 }] } },
      { roots: { roots: [{ uri: 'file:///a' }, {}] } },
      { roots: 5 },
      { roots: null },
      { roots: [] },
      { approve: { action: 'accept' } },
    ]
    for (const inputResponses of wrong) {
      const { roots, round, lines } = rig()
      const state = (round.round('run_code', ARGS, { capabilities: CAPS }) as { state: string }).state
      assert.deepEqual(
        round.round('run_code', ARGS, { requestState: state, inputResponses: inputResponses as never }),
        { kind: 'go' },
      )
      assert.deepEqual(roots.calls, ['modern'], JSON.stringify(inputResponses))
      assert.deepEqual(lines, [NO_WORKSPACE_LINE])
    }
    assert.deepEqual(urisOf({ roots: [{ uri: 'file:///a', name: 'x' }] }), ['file:///a'])
    for (const bad of [[{ uri: 5 }], [{}], [null], ['y'], [{ uri: 'file:///a' }, { uri: 5 }], [{ name: 'x' }]]) {
      assert.equal(urisOf({ roots: bad }), undefined, JSON.stringify(bad))
    }
    assert.deepEqual(urisOf({ roots: [] }), [], 'an empty list names no root: the bound root, as on legacy')
  })

  test('two roots requests with no retry: the third call goes on with no Workspace, and a client that never answers loses two calls', () => {
    const { roots, round, lines } = rig()
    assert.equal(ROOTS_ASKS_MAX, 2)
    assert.equal(round.round('run_code', ARGS, { capabilities: CAPS }).kind, 'ask')
    assert.equal(round.round('run_code', ARGS, { capabilities: CAPS }).kind, 'ask')
    assert.deepEqual(round.round('run_code', ARGS, { capabilities: CAPS }), { kind: 'go' })
    assert.deepEqual(roots.calls, ['modern'])
    assert.deepEqual(lines, [NO_WORKSPACE_LINE])
    assert.deepEqual(
      round.round('run_code', ARGS, { capabilities: CAPS }),
      { kind: 'go' },
      'and no call after it is asked',
    )
  })

  test('a good retry resets the count: a client that answers every other call is never cut off', () => {
    const { roots, round } = rig()
    const asked = (n: number) => (round.round('run_code', { n }, { capabilities: CAPS }) as { state: string }).state
    asked(1)
    const second = asked(2)
    assert.equal(
      round.round('run_code', { n: 2 }, { requestState: second, inputResponses: answer(['file:///a']) }).kind,
      'go',
    )
    assert.deepEqual(roots.calls, ['answer 1'])
  })

  test('a state that is replayed, of another call, malformed or unknown is refused, and nothing settles', () => {
    const { roots, round, lines } = rig()
    const state = (round.round('run_code', ARGS, { capabilities: CAPS }) as { state: string }).state
    assert.deepEqual(
      round.round('run_code', { code: 'other' }, { requestState: state, inputResponses: answer(['file:///a']) }),
      { kind: 'refused' },
    )
    assert.deepEqual(
      round.round('run_code', ARGS, { requestState: state, inputResponses: answer(['file:///a']) }),
      { kind: 'refused' },
      'used up by the first refusal',
    )
    assert.deepEqual(round.round('run_code', ARGS, { requestState: 'junk' }), { kind: 'refused' })
    assert.deepEqual(roots.calls, [])
    assert.equal(roots.isSettled(), false)
    assert.deepEqual(lines, [
      'Workspace: a roots state was refused (call)',
      'Workspace: a roots state was refused (used)',
      'Workspace: a roots state was refused (malformed)',
    ])
    // A state that was minted for a call with the retry replayed after the list settled is refused too.
    const second = (round.round('run_code', ARGS, { capabilities: CAPS }) as { state: string }).state
    assert.equal(
      round.round('run_code', ARGS, { requestState: second, inputResponses: answer(['file:///a']) }).kind,
      'go',
    )
    assert.deepEqual(round.round('run_code', ARGS, { requestState: second, inputResponses: answer(['file:///b']) }), {
      kind: 'refused',
    })
    assert.deepEqual(roots.calls, ['answer 1'])
  })

  test('100 roots are cut at 16, and the first answer of the process stays', async () => {
    const roots = createRoots({ log: () => {} })
    const round = createRootsRound({ roots, log: () => {} })
    const first = round.round('run_code', ARGS, { capabilities: CAPS }) as { state: string }
    const uris = Array.from({ length: 100 }, (_, i) => `file:///r${i}`)
    round.round('run_code', ARGS, { requestState: first.state, inputResponses: answer(uris) })
    assert.equal(roots.isSettled(), true)
    const read = await roots.read()
    assert.equal(read.length, LIMITS.roots)
    roots.answer(['file:///later'])
    assert.equal((await roots.read()).length, LIMITS.roots, 'a later answer changes nothing')
  })
})

describe('gate G6: the same roots on a legacy opening and on a modern one', () => {
  const uri = (...parts: string[]): string => pathToFileURL(path.join(...parts)).href
  const rigOf = async (t: TestContext, root: string, options: Parameters<typeof open>[1]): Promise<Rig | undefined> => {
    const opened = await open(root, options)
    if ('unavailable' in opened) {
      if (process.platform === 'darwin') return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
      assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
    }
    t.after(() => opened.rig.close())
    return opened.rig
  }

  /** The list as the modern round settles it: a first call, then its retry with the roots of the answer. */
  const modernRead = (uris: string[]) => {
    const roots = createRoots({ log: () => {} })
    const round = createRootsRound({ roots, log: () => {} })
    const first = round.round('run_code', { code: 'x' }, { capabilities: CAPS }) as { state: string }
    round.round('run_code', { code: 'x' }, { requestState: first.state, inputResponses: answer(uris) })
    return roots.read
  }

  test('each row gives one session root in both columns', async t => {
    const base = fs.realpathSync.native(tempDir())
    t.after(() => rm(base))
    const projects = path.join(base, 'Projects')
    write(projects, { 'top.txt': 'x', 'app/a.txt': 'x', 'app/src/s.txt': 'x', 'lib/l.txt': 'x' })
    fs.mkdirSync(path.join(base, 'elsewhere'))
    fs.mkdirSync(path.join(base, 'Other'))
    const elsewhere = path.join(base, 'elsewhere')
    const rows: [string, string[], string][] = [
      ['one root inside', [uri(projects, 'app')], path.join(projects, 'app')],
      ['equal to the bound root', [uri(projects)], projects],
      ['a parent of it', [uri(base)], projects],
      ['two roots', [uri(projects, 'app'), uri(projects, 'lib')], projects],
      ['two in one folder', [uri(projects, 'app', 'src'), uri(projects, 'app')], path.join(projects, 'app')],
      ['a root outside', [uri(base, 'Other')], projects],
      ['a non-file URI', ['http://example.com/app', 'https://x/y'], projects],
      ['an empty list', [], projects],
      [
        '100 roots, the useful one last',
        [...Array.from({ length: 99 }, (_, i) => uri(projects, `no-${i}`)), uri(projects, 'lib')],
        projects,
      ],
      [
        '100 roots, the useful one first',
        [uri(projects, 'lib'), ...Array.from({ length: 99 }, (_, i) => uri(projects, `no-${i}`))],
        path.join(projects, 'lib'),
      ],
    ]
    if (process.platform === 'win32') {
      rows.push(['a Windows drive URI', [`file:///${projects.replaceAll('\\', '/')}/app`], path.join(projects, 'app')])
      rows.push(['a UNC URI', ['file://server/share/app'], projects])
    }
    for (const [name, uris, expect] of rows) {
      const legacy = await rigOf(t, projects, {
        start: elsewhere,
        clientRoots: async () => uris.slice(0, LIMITS.roots),
      })
      const modern = await rigOf(t, projects, { start: elsewhere, clientRoots: modernRead(uris) })
      if (legacy === undefined || modern === undefined) return
      assert.equal(legacy.bound.root, expect, `${name}: legacy`)
      assert.equal(modern.bound.root, legacy.bound.root, `${name}: modern equals legacy`)
    }
  })

  test('no roots: the bind refuses and the confined file system is never asked, by either way to no Workspace', async t => {
    const base = fs.realpathSync.native(tempDir())
    t.after(() => rm(base))
    const projects = path.join(base, 'Projects')
    write(projects, { 'top.txt': 'x' })
    const CAPS_ROOTS = { roots: { listChanged: true } }
    const ways: [string, (round: ReturnType<typeof createRootsRound>) => void][] = [
      ['no roots declared', round => void round.round('run_code', {}, { capabilities: {} })],
      [
        'two asks and no retry',
        round => {
          for (let i = 0; i < ROOTS_ASKS_MAX + 1; i++) round.round('run_code', {}, { capabilities: CAPS_ROOTS })
        },
      ],
      [
        'a retry with a malformed entry',
        round => {
          const first = round.round('run_code', {}, { capabilities: CAPS_ROOTS }) as { state: string }
          round.round('run_code', {}, { requestState: first.state, inputResponses: { roots: { roots: [{ uri: 5 }] } } })
        },
      ],
    ]
    for (const [name, way] of ways) {
      const roots = createRoots({ log: () => {} })
      way(createRootsRound({ roots, log: () => {} }))
      assert.equal(await roots.read(), 'modern', name)
      let lookups = 0
      const opened = await open(projects, { start: base, clientRoots: roots.read, hook: () => void lookups++ })
      assert.ok('unavailable' in opened, name)
      if ('rig' in opened) await opened.rig.close()
      else assert.match(opened.unavailable, /gives no roots/, name)
      assert.equal(lookups, 0, `${name}: no lookup of the confined file system`)
    }
  })

  test('the counting hook sees a lookup once the roots are answered, and none before the settle', async t => {
    const base = fs.realpathSync.native(tempDir())
    t.after(() => rm(base))
    const projects = path.join(base, 'Projects')
    write(projects, { 'top.txt': 'x' })
    let lookups = 0
    let release!: (uris: string[]) => void
    const gate = new Promise<string[]>(resolve => (release = resolve))
    const opening = open(projects, { start: base, clientRoots: () => gate, hook: () => void lookups++ })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(lookups, 0, 'nothing is looked up before the settle')
    release([uri(projects)])
    const opened = await opening
    if ('unavailable' in opened) {
      if (process.platform === 'darwin') return void t.skip('Workspace is unavailable on macOS')
      assert.fail(opened.unavailable)
    }
    t.after(() => opened.rig.close())
    await opened.rig.call('list', {})
    assert.ok(lookups > 0, 'the hook is on the path of a call')
  })
})
