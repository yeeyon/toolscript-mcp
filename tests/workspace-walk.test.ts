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
