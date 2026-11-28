// The walk of `list` and `search` over big folders (issue #148): excluded names do not count toward the budget, and a
// folder with more names than the budget is read to the budget, not to its end. Small injected limits, small trees.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { open, rm, tempDir, write, type Rig, type RigOptions } from './workspace-rig.ts'

const mac = process.platform === 'darwin'

const tree = (t: TestContext): string => {
  const root = tempDir()
  t.after(() => rm(root))
  return root
}

const rigOf = async (t: TestContext, root: string, options: RigOptions = {}): Promise<Rig | undefined> => {
  const opened = await open(root, options)
  if ('unavailable' in opened) {
    if (mac) return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const files = (prefix: string, count: number, text = 'hit\n'): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${String(i).padStart(3, '0')}`, text]))

describe('the walk of a big folder', () => {
  test('excluded names do not count toward the budget', async t => {
    const root = tree(t)
    write(root, {
      ...Object.fromEntries(Object.keys(files('x', 300)).map(k => [`${k}.sqlite`, 'hit\n'])),
      ...files('k', 5),
    })
    const rig = await rigOf(t, root, { exclude: ['*.sqlite'], limits: { searchFiles: 5 } })
    if (rig === undefined) return
    const listed = await rig.call('list')
    assert.equal(listed.entries.length, 5)
    assert.equal(listed.truncated, false)
    const found = await rig.call('search', { query: 'hit' })
    assert.equal(found.filesScanned, 5)
    assert.equal(found.truncated, false)
  })

  test('a folder with more names than the budget gives that many names and truncated', async t => {
    const root = tree(t)
    write(root, files('f', 40))
    const names = Object.keys(files('f', 40))
    for (const [limit, count, truncated] of [
      [10, 10, true],
      [39, 39, true],
      [40, 40, false],
    ] as const) {
      const rig = await rigOf(t, root, { limits: { searchFiles: limit } })
      if (rig === undefined) return
      const r = await rig.call('list')
      assert.equal(r.entries.length, count, `limit ${limit}`)
      assert.equal(r.truncated, truncated, `limit ${limit}`)
      const seen = r.entries.map((e: { path: string }) => e.path)
      assert.deepEqual(seen, [...seen].sort())
      for (const p of seen) assert.ok(names.includes(p), p)
    }
  })

  test('the names of a folder count before any folder below it is entered', async t => {
    const root = tree(t)
    write(root, { ...Object.fromEntries(Object.keys(files('', 20)).map(k => [`a/${k}`, 'x'])), ...files('z', 5) })
    const rig = await rigOf(t, root, { limits: { searchFiles: 6 } })
    if (rig === undefined) return
    const r = await rig.call('list', { depth: 2 })
    assert.deepEqual(
      r.entries.map((e: { path: string }) => e.path),
      ['a', 'z000', 'z001', 'z002', 'z003', 'z004'],
    )
    assert.equal(r.truncated, true)
  })

  test('a cut list leaves the folder removable, and a later walk still works', async t => {
    const root = tree(t)
    write(root, files('f', 30))
    const rig = await rigOf(t, root, { limits: { searchFiles: 5 } })
    if (rig === undefined) return
    assert.equal((await rig.call('list')).truncated, true)
    assert.equal((await rig.call('search', { query: 'hit' })).truncated, true)
    await rig.close()
    fs.rmSync(path.join(root, 'f000'))
    rm(root)
    assert.equal(fs.existsSync(root), false)
  })
})

describe('the prune by include', () => {
  const sibling = (): Record<string, string> => ({
    ...Object.fromEntries(Object.keys(files('f', 40)).map(k => [`big/${k}`, 'hit\n'])),
    'svc/api/a.cs': 'hit\n',
    'svc/api/deep/b.cs': 'hit\n',
    'svc/note.txt': 'hit\n',
    'one/x.cs': 'hit\n',
  })

  test('a large sibling folder is not read under a small budget, for a folder glob and for one file', async t => {
    const root = tree(t)
    write(root, sibling())
    for (const prune of [true, false]) {
      const rig = await rigOf(t, root, { prune, limits: { searchFiles: 20 } })
      if (rig === undefined) return
      for (const [include, paths] of [
        [['svc/**/*.cs'], ['svc/api/a.cs', 'svc/api/deep/b.cs']],
        [['one/x.cs'], ['one/x.cs']],
      ] as const) {
        const r = await rig.call('search', { query: 'hit', include })
        // With the prune off, `big` takes the whole budget before `svc` is read: the walk is cut and finds nothing.
        assert.deepEqual(
          r.matches.map((m: { path: string }) => m.path),
          prune ? paths : [],
        )
        assert.equal(r.truncated, !prune, `prune ${prune} ${include}`)
      }
    }
  })

  test('with path set and no glob below it, one folder is read', async t => {
    const root = tree(t)
    write(root, {
      ...Object.fromEntries(Object.keys(files('f', 40)).map(k => [`svc/big/${k}`, 'hit\n'])),
      'svc/a.cs': 'hit\n',
    })
    for (const prune of [true, false]) {
      const rig = await rigOf(t, root, { prune, limits: { searchFiles: 10 } })
      if (rig === undefined) return
      const r = await rig.call('search', { query: 'hit', path: 'svc', include: ['*.cs'] })
      assert.deepEqual([r.matches.length, r.truncated], [0, !prune], `prune ${prune}`)
    }
  })

  test('a folder of skip that a glob names is listed and not entered', async t => {
    const root = tree(t)
    write(root, { 'node_modules/p/i.js': 'hit\n', 'src/a.js': 'hit\n' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const listed = await rig.call('list', { depth: 3, include: ['node_modules', 'node_modules/**/*.js', 'src/*.js'] })
    assert.deepEqual(
      listed.entries.map((e: { path: string }) => e.path),
      ['node_modules', 'src/a.js'],
    )
    const found = await rig.call('search', { query: 'hit', include: ['node_modules/**/*.js'] })
    assert.equal(found.matches.length, 0)
  })

  test('the results equal the walk with no prune, on a random tree', async t => {
    let seed = 11
    const rand = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >> 8) % n)
    const dirs = ['a', 'b', 'src', 'Src', 'node_modules', 'ign']
    const leaves = ['x.cs', 'y.ts', 'z.txt', 'c.cs', 'k.sqlite']
    const made: Record<string, string> = { '.gitignore': 'ign/\n', 'ign/i.cs': 'hit\n' }
    while (Object.keys(made).length < 80) {
      const parts = Array.from({ length: rand(4) }, () => dirs[rand(dirs.length)]!)
      made[[...parts, leaves[rand(leaves.length)]!].join('/')] = 'hit\n'
    }
    const root = tree(t)
    write(root, made)
    const on = await rigOf(t, root, { exclude: ['*.sqlite'] })
    const off = await rigOf(t, root, { exclude: ['*.sqlite'], prune: false })
    if (on === undefined || off === undefined) return
    const includes = [
      [],
      ['src/**/*.cs'],
      ['**/*.ts'],
      ['a/b/x.cs'],
      ['*.txt'],
      ['a/*/c.cs', 'Src/**'],
      ['node_modules/**'],
    ]
    const both = (tool: string, args: Record<string, unknown>) =>
      Promise.all([on, off].map(r => r.call(tool, args).catch((e: Error) => e.message)))
    for (const include of includes)
      for (const p of ['.', 'a', 'ign']) {
        const s = { query: 'hit', path: p, include }
        const [u, v] = await both('search', s)
        assert.deepEqual(u, v, `search ${JSON.stringify(s)}`)
        for (const depth of [1, 3, 8]) {
          const args = { path: p, include, depth }
          const [x, y] = await both('list', args)
          assert.deepEqual(x, y, `list ${JSON.stringify(args)}`)
        }
      }
  })
})

describe('the walk slots (issue #160)', () => {
  /** A hook that holds each `readdir` (the first lookup of a walk) until `release`. `read` never does a `readdir`. */
  const holding = () => {
    let on = true
    let held = 0
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    return {
      hook: async (lookup: string) => {
        if (on && lookup === 'readdir') {
          held++
          await gate
        }
      },
      held: () => held,
      release: () => {
        on = false
        release()
      },
    }
  }
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 1000 && !ok(); i++) await new Promise(r => setTimeout(r, 5))
    assert.ok(ok(), 'the condition did not come true')
  }
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
  const searchMs = 200

  test('one walk runs, the next waits with no lookup, and its budget starts at its slot', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { hook: h.hook, limits: { searchMs, walkSlots: 1 } })
    if (rig === undefined) return
    const walks = [1, 2].map(() => rig.call('search', { query: 'hit' }))
    await until(() => h.held() === 1)
    await pause(searchMs + 100)
    assert.equal(h.held(), 1, 'the second walk made a lookup while the slot was held')
    assert.equal(rig.bound.provider.inFlight(), 2)
    assert.equal((await rig.call('read', { path: 'a.txt' })).content, 'hit\n')
    assert.equal((await rig.call('stat', { path: 'a.txt' })).type, 'file')
    h.release()
    const [, second] = await Promise.all(walks)
    assert.equal(second.truncated, false)
    assert.equal(second.matches.length, 1)
  })

  test('a call that is cancelled while it waits fails at once, and a later call still runs', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { hook: h.hook, limits: { walkSlots: 1 } })
    if (rig === undefined) return
    const walks = [rig.call('list')]
    await until(() => h.held() === 1)
    const waiting = rig.call('search', { query: 'hit' })
    const quit = new AbortController()
    const cancelled = rig.call('list', {}, quit.signal)
    await until(() => rig.bound.provider.inFlight() === 3)
    quit.abort()
    await assert.rejects(cancelled)
    await until(() => rig.bound.provider.inFlight() === 2)
    h.release()
    await Promise.all(walks)
    assert.equal((await waiting).matches.length, 1)
    assert.equal((await rig.call('search', { query: 'hit' })).truncated, false)
    await until(() => rig.bound.provider.inFlight() === 0)
  })

  test('a call with bad input or a bad path answers while a walk holds the slot', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { hook: h.hook, limits: { walkSlots: 1 } })
    if (rig === undefined) return
    const walk = rig.call('list')
    await until(() => h.held() === 1)
    assert.match(await rig.fail('list', { depth: 'deep' }), /bad-input/)
    assert.match(await rig.fail('search', { query: 'hit', path: '../outside' }), /./)
    assert.equal(rig.bound.provider.inFlight(), 1)
    h.release()
    await walk
  })

  test('a walk that fails gives its slot back', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    for (let i = 0; i < 5; i++) assert.match(await rig.fail('list', { path: 'missing' }), /./)
    assert.equal((await rig.call('search', { query: 'hit' })).matches.length, 1)
  })

  test('with 2 slots two walks run together and the third waits (issue #180)', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { hook: h.hook, limits: { searchMs, walkSlots: 2 } })
    if (rig === undefined) return
    const walks = [1, 2, 3].map(() => rig.call('search', { query: 'hit' }))
    await until(() => h.held() === 2)
    await pause(searchMs + 100)
    assert.equal(h.held(), 2, 'the third walk made a lookup while both slots were held')
    assert.equal(rig.bound.provider.inFlight(), 3)
    h.release()
    // The two held walks ran past their own budget while held. The third waited, and its budget starts at its slot.
    const [, , third] = await Promise.all(walks)
    assert.equal(third.truncated, false, 'the walk that waited was cut')
    assert.equal(third.matches.length, 1)
  })

  test('a provider that sees 1 CPU holds the second walk, one that sees 2 runs it (issue #180)', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    for (const [parallelism, running] of [
      [1, 1],
      [2, 2],
    ] as const) {
      const h = holding()
      const rig = await rigOf(t, root, { hook: h.hook, limits: { parallelism } })
      if (rig === undefined) return
      const walks = [1, 2].map(() => rig.call('search', { query: 'hit' }))
      await until(() => h.held() === running)
      await pause(150)
      assert.equal(h.held(), running, `${parallelism} CPUs`)
      h.release()
      await Promise.all(walks)
      await rig.close()
    }
  })
})
