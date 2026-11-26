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
