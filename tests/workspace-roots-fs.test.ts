// MCP client roots and the Workspace (issue #150), on real temp trees. The roots only narrow the bound root. The tests
// check what a call lists and what the log says, with fake client answers for `bindWorkspace` and a real SDK client and
// server pair for `createRoots`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { LIMITS, RESTART_SENTENCE } from '../src/core/workspace.ts'
import { bindStep } from '../src/host/workspace/bind.ts'
import { createRoots } from '../src/host/workspace/roots.ts'
import { marker, open, rm, tempDir, trySymlink, write, type Rig, type RigOptions } from './workspace-rig.ts'

const folders = (t: TestContext) => {
  const dirs: string[] = []
  t.after(() => dirs.forEach(rm))
  return (): string => {
    const dir = tempDir()
    dirs.push(dir)
    return dir
  }
}

const uri = (...parts: string[]): string => pathToFileURL(path.join(...parts)).href

const rigOf = async (t: TestContext, root: string, options: RigOptions = {}): Promise<Rig | undefined> => {
  const opened = await open(root, options)
  if ('unavailable' in opened) {
    if (process.platform === 'darwin') return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const listed = async (rig: Rig): Promise<string[]> =>
  ((await rig.call('list', { depth: 8 })).entries as { path: string }[]).map(e => e.path)

/** A tree `Projects` with `app/src`, `app/tests`, `lib`, and a file in each. The client starts in `elsewhere`. */
const tree = (t: TestContext) => {
  const base = folders(t)()
  const projects = path.join(base, 'Projects')
  write(projects, {
    'top.txt': 'x',
    'app/a.txt': 'x',
    'app/src/s.txt': 'x',
    'app/tests/t.txt': 'x',
    'lib/l.txt': 'x',
  })
  fs.mkdirSync(path.join(base, 'elsewhere'))
  fs.mkdirSync(path.join(base, 'Other'))
  return { base, projects, elsewhere: path.join(base, 'elsewhere'), other: path.join(base, 'Other') }
}

describe('client roots narrow the bound root', () => {
  test('one entry, a client started elsewhere: each case of the bar, from the client roots', async t => {
    const { base, projects, elsewhere, other } = tree(t)
    const cases: { name: string; roots: string[]; expect: string }[] = [
      { name: 'one root inside', roots: [uri(projects, 'app')], expect: 'app' },
      { name: 'two siblings', roots: [uri(projects, 'app'), uri(projects, 'lib')], expect: '' },
      { name: 'two in one folder', roots: [uri(projects, 'app', 'src'), uri(projects, 'app', 'tests')], expect: 'app' },
      { name: 'equal', roots: [uri(projects)], expect: '' },
      { name: 'the parent', roots: [uri(base)], expect: '' },
      { name: 'another folder only', roots: [uri(other)], expect: '' },
      { name: 'none', roots: [], expect: '' },
      { name: 'one outside, one inside', roots: [uri(other), uri(projects, 'lib')], expect: 'lib' },
    ]
    // The order of the list is covered by the pure table of narrowRoot: here the list is in the order of the case.
    for (const { name, roots, expect } of cases) {
      const rig = await rigOf(t, projects, { start: elsewhere, clientRoots: async () => roots })
      if (rig === undefined) return
      const root = expect === '' ? projects : path.join(projects, expect)
      assert.equal(rig.bound.root, root, name)
      const names = await listed(rig)
      assert.deepEqual(
        names.filter(n => !n.includes('/')),
        fs.readdirSync(root).sort(),
        name,
      )
      await rig.close()
    }
  })

  test('the entry, write and the exclusions stay: a narrowed root is only a smaller folder', async t => {
    const { projects, elsewhere } = tree(t)
    write(projects, { 'app/.env': 'x' })
    const rig = await rigOf(t, projects, {
      start: elsewhere,
      write: true,
      clientRoots: async () => [uri(projects, 'app')],
    })
    if (rig === undefined) return
    assert.equal(rig.bound.write, true)
    assert.deepEqual(await listed(rig), ['a.txt', 'src', 'src/s.txt', 'tests', 'tests/t.txt'])
    assert.match(await rig.fail('read', { path: '.env' }), /^excluded/)
    assert.match(await rig.fail('read', { path: '../top.txt' }), /^bad-path/)
    assert.match(await rig.fail('read', { path: 'top.txt' }), /^not-found/)
    await rig.call('write', { path: 'new.txt', content: 'hi' })
    assert.equal(fs.readFileSync(path.join(projects, 'app', 'new.txt'), 'utf8'), 'hi')
  })

  test('the start folder inside an entry stays: a client root beside it narrows nothing', async t => {
    const { projects } = tree(t)
    const app = path.join(projects, 'app')
    const beside = await rigOf(t, projects, { start: app, clientRoots: async () => [uri(projects, 'lib')] })
    const inside = await rigOf(t, projects, { start: app, clientRoots: async () => [uri(app, 'src')] })
    if (beside === undefined || inside === undefined) return
    assert.equal(beside.bound.root, app)
    assert.equal(inside.bound.root, path.join(app, 'src'))
  })

  test('a root that is a link out of the grant, a file, .git, or no folder is dropped', async t => {
    const { projects, elsewhere, other } = tree(t)
    write(projects, { '.git/HEAD': 'x' })
    const hops: string[] = []
    if (trySymlink(other, path.join(projects, 'hop'), 'junction')) hops.push(uri(projects, 'hop'))
    const lines: string[] = []
    const rig = await rigOf(t, projects, {
      start: elsewhere,
      lines,
      clientRoots: async () => [
        ...hops,
        uri(projects, 'top.txt'),
        uri(projects, '.git'),
        uri(projects, 'missing'),
        'http://example.com/app',
        'file://server/share/app',
        `${uri(projects, 'app')}?x=1`,
        7 as never,
        null as never,
        uri(projects, 'lib'),
      ],
    })
    if (rig === undefined) return
    assert.equal(rig.bound.root, path.join(projects, 'lib'))
    const dropped = lines.filter(l => l.includes('client roots were dropped'))
    assert.equal(dropped.length, 1)
    assert.match(dropped[0]!, /^Workspace: \d+ of \d+ client roots were dropped$/)
    assert.equal(lines.filter(l => l.includes('narrowed the root')).length, 1)
    assert.ok(!lines.join('\n').includes('example.com'))
    assert.ok(!lines.join('\n').includes('server'))
  })

  test('at most 16 entries are read', async t => {
    const { projects, elsewhere } = tree(t)
    const filler = Array.from({ length: LIMITS.roots }, (_, i) => uri(projects, `no-${i}`))
    const late = await rigOf(t, projects, {
      start: elsewhere,
      clientRoots: async () => [...filler, uri(projects, 'lib')],
    })
    const many = await rigOf(t, projects, {
      start: elsewhere,
      clientRoots: async () => [
        uri(projects, 'lib'),
        ...Array.from({ length: 1000 }, (_, i) => uri(projects, `n${i}`)),
      ],
    })
    if (late === undefined || many === undefined) return
    assert.equal(late.bound.root, projects, 'the 17th entry is never read')
    assert.equal(many.bound.root, path.join(projects, 'lib'))
  })

  test('an answer that rejects gives the bound root, and no URI reaches the log', async t => {
    const { projects, elsewhere } = tree(t)
    const lines: string[] = []
    const rig = await rigOf(t, projects, {
      start: elsewhere,
      lines,
      clientRoots: () => Promise.reject(new Error(marker())),
    })
    if (rig === undefined) return
    assert.equal(rig.bound.root, projects)
    assert.ok(!lines.join('\n').includes('SECRET'))
  })

  test('no call runs before the roots settle, and the first call sees only the narrowed root', async t => {
    const { projects, elsewhere } = tree(t)
    let release!: (uris: string[]) => void
    const gate = new Promise<string[]>(resolve => (release = resolve))
    let done = false
    const opening = rigOf(t, projects, { start: elsewhere, clientRoots: () => gate })
    void opening.then(() => (done = true))
    await sleep(200)
    assert.equal(done, false, 'the provider is not there before the settle')
    release([uri(projects, 'app')])
    const rig = await opening
    if (rig === undefined) return
    assert.deepEqual(await listed(rig), ['a.txt', 'src', 'src/s.txt', 'tests', 'tests/t.txt'])
    assert.match(await rig.fail('read', { path: 'top.txt' }), /^not-found/)
  })

  test('with no clientRoots the root is the bound root, as before', async t => {
    const { projects, elsewhere } = tree(t)
    const rig = await rigOf(t, projects, { start: elsewhere })
    if (rig === undefined) return
    assert.equal(rig.bound.root, projects)
  })
})

describe('the exclude globs are relative to the entry path', () => {
  const secrets = (t: TestContext) => {
    const made = tree(t)
    write(made.projects, {
      'app/fixtures/secrets/k.txt': 'k',
      'app/fixtures/ok.txt': 'ok',
      'private/p.txt': 'p',
      'app/.env': 'e',
    })
    return made
  }

  test('a pathed and a named glob still match through a narrowed root', async t => {
    const { projects, elsewhere } = secrets(t)
    const rig = await rigOf(t, projects, {
      start: elsewhere,
      exclude: ['app/fixtures/secrets/**', '.env'],
      clientRoots: async () => [uri(projects, 'app')],
    })
    if (rig === undefined) return
    assert.equal(rig.bound.root, path.join(projects, 'app'))
    assert.match(await rig.fail('read', { path: 'fixtures/secrets/k.txt' }), /^excluded/)
    assert.match(await rig.fail('read', { path: '.env' }), /^excluded/)
    assert.equal((await rig.call('read', { path: 'fixtures/ok.txt' })).content, 'ok')
    assert.ok(!(await listed(rig)).some(n => n.includes('secrets')))
  })

  test('a client root that is an excluded folder is dropped, and the bound root stays', async t => {
    const { projects, elsewhere } = secrets(t)
    const rig = await rigOf(t, projects, {
      start: elsewhere,
      exclude: ['private/**'],
      clientRoots: async () => [uri(projects, 'private')],
    })
    if (rig === undefined) return
    assert.equal(rig.bound.root, projects)
    assert.match(await rig.fail('read', { path: 'private/p.txt' }), /^excluded/)
  })

  test('a start folder that is excluded makes Workspace unavailable, a start folder beside it keeps the globs', async t => {
    const { projects } = secrets(t)
    const opened = await open(projects, { start: path.join(projects, 'private'), exclude: ['private/**'] })
    assert.ok('unavailable' in opened)
    if ('rig' in opened) await opened.rig.close()
    const rig = await rigOf(t, projects, { start: path.join(projects, 'app'), exclude: ['app/fixtures/secrets/**'] })
    if (rig === undefined) return
    assert.match(await rig.fail('read', { path: 'fixtures/secrets/k.txt' }), /^excluded/)
  })

  test('a named glob on a folder above hides a client root and a start folder inside it', async t => {
    const { projects, elsewhere } = secrets(t)
    write(projects, { 'private/sub/x.txt': 'x' })
    const rig = await rigOf(t, projects, {
      start: elsewhere,
      exclude: ['private'],
      clientRoots: async () => [uri(projects, 'private', 'sub')],
    })
    if (rig === undefined) return
    assert.equal(rig.bound.root, projects)
    const opened = await open(projects, { start: path.join(projects, 'private', 'sub'), exclude: ['private'] })
    assert.ok('unavailable' in opened)
    if ('rig' in opened) await opened.rig.close()
  })
})

describe('createRoots over a real client and server', () => {
  type Answer = (call: number) => unknown | Promise<unknown>

  /** A client that declares `roots` (or not) and answers `roots/list` with `answer`. Returns the server side. */
  const pair = async (t: TestContext, options: { capable?: boolean; answer?: Answer; waitMs?: number } = {}) => {
    const lines: string[] = []
    const roots = createRoots({ log: line => lines.push(line), waitMs: options.waitMs ?? 2_000 })
    const server = new Server({ name: 'server', version: '0' }, { capabilities: {} })
    roots.attach(server)
    const client = new Client(
      { name: 'client', version: '0' },
      { capabilities: options.capable === false ? {} : { roots: {} } },
    )
    let calls = 0
    if (options.capable !== false)
      client.setRequestHandler(
        ListRootsRequestSchema,
        async () => (await (options.answer ?? (() => ({ roots: [] })))(++calls)) as never,
      )
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    t.after(async () => {
      roots.close()
      await client.close()
    })
    return { roots, lines, client, a, calls: () => calls }
  }

  test('a client with the capability is asked one time and its answer settles the list', async t => {
    const { roots, client, a, calls } = await pair(t, {
      answer: () => ({ roots: [{ uri: 'file:///a', name: 'ignored' }, { uri: 'file:///b' }] }),
    })
    await client.connect(a)
    assert.deepEqual(await roots.read(), ['file:///a', 'file:///b'])
    assert.equal(calls(), 1)
  })

  test('a client without the capability gets no request', async t => {
    const { roots, client, a, calls } = await pair(t, { capable: false })
    await client.connect(a)
    assert.deepEqual(await roots.read(), [])
    assert.equal(calls(), 0)
  })

  test('a client that answers after the wait changes nothing, and the timeout logs one line', async t => {
    const { roots, lines, client, a } = await pair(t, {
      waitMs: 100,
      answer: async () => {
        await sleep(300)
        return { roots: [{ uri: 'file:///late' }] }
      },
    })
    const began = performance.now()
    await client.connect(a)
    assert.deepEqual(await roots.read(), [])
    assert.ok(performance.now() - began < 1000)
    await sleep(400)
    // The timer of the server is unref'd, so the test holds the loop open.
    const [settled] = await Promise.all([roots.read(), sleep(400)])
    assert.deepEqual(settled, [])
    assert.equal(lines.length, 1)
    assert.ok(!lines[0]!.includes('late'))
  })

  test('an error answer and an answer that is not the schema give no roots', async t => {
    for (const answer of [
      () => {
        throw new Error('no')
      },
      () => ({ roots: [{ uri: 5 }] }),
      () => ({ roots: 'x' }),
      () => 'nothing',
    ]) {
      const { roots, lines, client, a } = await pair(t, { answer, waitMs: 200 })
      await client.connect(a)
      assert.deepEqual(await roots.read(), [])
      assert.equal(lines.length, 1)
    }
  })

  test('1000 roots give the first 16', async t => {
    const { roots, client, a } = await pair(t, {
      answer: () => ({ roots: Array.from({ length: 1000 }, (_, i) => ({ uri: `file:///r${i}` })) }),
    })
    await client.connect(a)
    const read = await roots.read()
    assert.equal(read.length, LIMITS.roots)
    assert.equal(read[0], 'file:///r0')
  })

  test('a client that closes, or a shutdown, settles the list at once', async t => {
    const { roots, client, a } = await pair(t, { answer: () => new Promise(() => {}) })
    await client.connect(a)
    await client.close()
    assert.deepEqual(await roots.read(), [])
    const other = createRoots({ log: () => {} })
    other.close()
    assert.deepEqual(await other.read(), [])
  })

  test('a client that never sends initialized still settles the list', async t => {
    const lines: string[] = []
    const roots = createRoots({ log: line => lines.push(line), waitMs: 100, initializedWaitMs: 150 })
    const server = new Server({ name: 'server', version: '0' }, { capabilities: {} })
    roots.attach(server)
    t.after(() => roots.close())
    // The timer of the server is unref'd, so the test holds the loop open.
    const [settled] = await Promise.all([roots.read(), sleep(400)])
    assert.deepEqual(settled, [])
    assert.equal(lines.length, 1)
  })
})

describe('the config step of the bind (issue #163)', () => {
  const section = (roots: string[], exclude: string[] = []) => ({
    roots: roots.map(p => ({ path: p, write: false })),
    exclude,
    skip: [],
  })
  const step = (base: string, roots: string[], start: string, exclude: string[] = [], home = base) =>
    bindStep({ workspace: section(roots, exclude), start, home, configFile: path.join(base, 'c.json') })
  const reasonOf = (s: Awaited<ReturnType<typeof step>>): string => {
    assert.equal(s.ok, false)
    return s.ok ? '' : s.reason
  }

  test('each failure of the step gives its reason with no client, and each reason ends with the restart sentence', async t => {
    const { base, projects, elsewhere, other } = tree(t)
    const gone = path.join(base, 'gone')
    const home = folders(t)()
    fs.mkdirSync(path.join(projects, '.git'))
    const cases: [string, Awaited<ReturnType<typeof step>>, RegExp][] = [
      [
        'a path that does not exist',
        await step(base, [gone], projects),
        /^workspace\.roots\[0\]\.path is not a folder that exists\./,
      ],
      [
        'a start folder in none of two entries',
        await step(base, [projects, other], elsewhere),
        /^the client started toolscript-mcp in a folder that is in none of the 2 entries of workspace\.roots\. Start the client in one of them. /,
      ],
      [
        'a start folder that is excluded',
        await step(base, [projects], path.join(projects, 'app'), ['app']),
        /^the folder where the client started toolscript-mcp is excluded by workspace\.exclude\./,
      ],
      ['the home folder as a root', await step(base, [home], home, [], home), /refused/],
      [
        'a start folder that is refused as a root',
        await step(base, [projects], path.join(projects, '.git')),
        /^the folder where the client started toolscript-mcp is refused as a root: /,
      ],
    ]
    for (const [name, s, shape] of cases) {
      const reason = reasonOf(s)
      assert.match(reason, shape, name)
      assert.ok(reason.endsWith(RESTART_SENTENCE), `${name}: ${reason}`)
      assert.equal(reason.split(RESTART_SENTENCE).length, 2, `${name}: the sentence once`)
      assert.ok(!reason.includes(base) && !reason.includes(home), `${name}: no path`)
    }
    assert.equal(
      RESTART_SENTENCE,
      'Workspace reads workspace.roots only at its start: after a change, reconnect toolscript-mcp or restart the client.',
    )
    assert.ok(!/add |edit |widen/i.test(RESTART_SENTENCE))
  })

  test('a step that throws gives a failed step with a fixed reason, never a rejection', async t => {
    const { base, projects } = tree(t)
    const broken = {
      get roots(): never {
        throw new Error(`boom ${base}`)
      },
      exclude: [],
      skip: [],
    }
    const s = await bindStep({ workspace: broken, start: projects, home: base, configFile: path.join(base, 'c.json') })
    assert.deepEqual(s, { ok: false, reason: `Workspace could not read its roots. ${RESTART_SENTENCE}` })
  })

  test('a step that passed is a bound root, and client roots never turn a failed step into a bind', async t => {
    const { base, projects, elsewhere, other } = tree(t)
    const passed = await step(base, [projects], projects)
    assert.ok(passed.ok)
    const failed = reasonOf(await step(base, [projects, other], elsewhere))
    const opened = await open(projects, {
      roots: [projects, other],
      start: elsewhere,
      clientRoots: async () => [uri(projects, 'app'), uri(other)],
    })
    assert.ok('unavailable' in opened)
    if ('rig' in opened) await opened.rig.close()
    else assert.equal(opened.unavailable, failed)
  })
})

// A case-sensitive APFS volume holds `app` and `App` as two folders. CI makes one and names it in the variable. Without
// the variable the test skips, and on CI a volume that folds case is a failure.
describe('a macOS volume that does not fold case (issue #157)', () => {
  const base = process.env.TOOLSCRIPT_TEST_CASE_DIR
  const skipWhy =
    process.platform !== 'darwin'
      ? 'macOS only'
      : base === undefined
        ? 'TOOLSCRIPT_TEST_CASE_DIR does not name a folder on a case-sensitive volume'
        : false

  test('a start folder that differs from an entry in case is in no entry', { skip: skipWhy }, async t => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(base!, 'ws-case-')))
    t.after(() => rm(dir))
    for (const name of ['proj/app', 'proj/App', 'proj/other']) fs.mkdirSync(path.join(dir, name), { recursive: true })
    assert.equal(
      fs.readdirSync(path.join(dir, 'proj')).filter(n => n.toLowerCase() === 'app').length,
      2,
      'the volume folds case',
    )
    const workspace = {
      roots: ['proj/app', 'proj/other'].map(p => ({ path: path.join(dir, p), write: false })),
      exclude: [],
      skip: [],
    }
    const s = await bindStep({
      workspace,
      start: path.join(dir, 'proj/App'),
      home: folders(t)(),
      configFile: path.join(dir, 'c.json'),
    })
    assert.equal(s.ok, false)
  })
})
