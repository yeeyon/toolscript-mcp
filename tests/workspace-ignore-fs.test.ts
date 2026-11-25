// `list` and `search` with the `.gitignore` of the root (issue #150), on real temp trees. The rules are discovery only:
// `read`, `stat` and the other tools never read them, and an exclusion or `skip` decides before a rule.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '../src/core/workspace.ts'
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

const rigOf = async (t: TestContext, root: string, options: RigOptions = {}): Promise<Rig | undefined> => {
  const opened = await open(root, options)
  if ('unavailable' in opened) {
    if (process.platform === 'darwin') return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const paths = async (rig: Rig, args: Record<string, unknown> = {}): Promise<string[]> =>
  ((await rig.call('list', { depth: 8, ...args })).entries as { path: string }[]).map(e => e.path)

const found = async (rig: Rig, args: Record<string, unknown> = {}): Promise<string[]> => [
  ...new Set(((await rig.call('search', { query: 'needle', ...args })).matches as { path: string }[]).map(m => m.path)),
]

const IGNORE = [
  '# build output',
  'node_modules/',
  '*.log',
  '/out',
  'docs/_build/',
  '**/tmp/*.bak',
  '[Bb]in/',
  '[Oo]bj/',
  '*.py[cod]',
  '!keep.log',
  'logs/',
  '!logs/keep.txt',
].join('\r\n')

const TREE: Record<string, string> = {
  '.gitignore': `﻿${IGNORE}`,
  'a.txt': 'needle',
  'x.log': 'needle',
  'keep.log': 'needle',
  'out/a.txt': 'needle',
  'docs/_build/p.html': 'needle',
  'docs/guide.md': 'needle',
  'src/tmp/a.bak': 'needle',
  'src/tmp/a.txt': 'needle',
  'src/Bin/b.txt': 'needle',
  'src/obj/c.txt': 'needle',
  'src/m.pyc': 'needle',
  'src/m.py': 'needle',
  'logs/keep.txt': 'needle',
  'deep/out/z.txt': 'needle',
}

describe('list and search with the .gitignore of the root', () => {
  test('both hide the same names, with CRLF, a byte order mark and no final newline', async t => {
    const root = folders(t)()
    write(root, TREE)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.deepEqual(await paths(rig), [
      '.gitignore',
      'a.txt',
      'deep',
      'deep/out',
      'deep/out/z.txt',
      'docs',
      'docs/guide.md',
      'keep.log',
      'src',
      'src/m.py',
      'src/tmp',
      'src/tmp/a.txt',
    ])
    assert.deepEqual(await found(rig), [
      'a.txt',
      'deep/out/z.txt',
      'docs/guide.md',
      'keep.log',
      'src/m.py',
      'src/tmp/a.txt',
    ])
  })

  test('read and stat of an ignored file work as before, and path can name an ignored folder', async t => {
    const root = folders(t)()
    write(root, TREE)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.equal((await rig.call('read', { path: 'out/a.txt' })).content, 'needle')
    assert.equal((await rig.call('read', { path: 'x.log' })).content, 'needle')
    assert.equal((await rig.call('stat', { path: 'out' })).type, 'folder')
    assert.deepEqual(await paths(rig, { path: 'out' }), ['out/a.txt'])
    assert.deepEqual(await found(rig, { path: 'out' }), ['out/a.txt'])
    assert.deepEqual(await paths(rig, { path: 'logs' }), ['logs/keep.txt'])
    assert.deepEqual(await paths(rig, { path: 'src/Bin' }), ['src/Bin/b.txt'])
    assert.deepEqual(await found(rig, { path: 'src/obj' }), ['src/obj/c.txt'])
  })

  test('a ! rule below an ignored folder shows nothing, as in git', async t => {
    const root = folders(t)()
    write(root, TREE)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.ok(!(await paths(rig)).includes('logs/keep.txt'))
    assert.ok(!(await found(rig)).includes('logs/keep.txt'))
  })

  test('include never shows an ignored name, and the file shows in list', async t => {
    const root = folders(t)()
    write(root, TREE)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.deepEqual(await paths(rig, { include: ['**/*.log'] }), ['keep.log'])
    assert.deepEqual(await paths(rig, { include: ['.gitignore'] }), ['.gitignore'])
  })

  test('"gitignore": false gives the results of a root with no file', async t => {
    const root = folders(t)()
    write(root, TREE)
    const off = await rigOf(t, root, { gitignore: false })
    const bare = folders(t)()
    write(bare, { ...TREE, '.gitignore': '' })
    const none = await rigOf(t, bare)
    if (off === undefined || none === undefined) return
    assert.deepEqual(await paths(off), await paths(none))
    assert.deepEqual(await found(off), await found(none))
    assert.ok((await paths(off)).includes('x.log'))
  })

  test('the file is read again at each call', async t => {
    const root = folders(t)()
    write(root, { 'a.txt': 'needle', 'b.txt': 'needle' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.deepEqual(await paths(rig), ['a.txt', 'b.txt'])
    write(root, { '.gitignore': 'b.txt' })
    assert.deepEqual(await paths(rig), ['.gitignore', 'a.txt'])
    assert.deepEqual(await found(rig), ['a.txt'])
    fs.rmSync(path.join(root, '.gitignore'))
    assert.deepEqual(await paths(rig), ['a.txt', 'b.txt'])
  })

  test('a file that cannot be used gives no rules and no error', async t => {
    const bad: Record<string, string | Uint8Array> = {
      'not utf8': Buffer.from([0x62, 0x2e, 0x74, 0x78, 0x74, 0x0a, 0xff, 0xfe]),
      'a NUL byte': 'b.txt\n\0\n',
      'over 64 KiB': `b.txt\n${'# x\n'.repeat(LIMITS.ignoreBytes / 4)}`,
    }
    for (const [name, data] of Object.entries(bad)) {
      const root = folders(t)()
      write(root, { 'a.txt': 'needle', 'b.txt': 'needle', '.gitignore': data })
      const rig = await rigOf(t, root)
      if (rig === undefined) return
      assert.deepEqual(await paths(rig), ['.gitignore', 'a.txt', 'b.txt'], name)
      assert.deepEqual(await found(rig), ['a.txt', 'b.txt'], name)
    }
    const root = folders(t)()
    write(root, { 'a.txt': 'needle', 'b.txt': 'needle', 'keep/.gitignore': 'b.txt' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.deepEqual(await found(rig), ['a.txt', 'b.txt'], 'a .gitignore below the root counts for nothing')
  })

  test('a .gitignore that is a hard link or a link, or that an exclusion names, gives no rules', async t => {
    const outside = folders(t)()
    write(outside, { 'rules.txt': 'b.txt' })
    const linked = folders(t)()
    write(linked, { 'a.txt': 'needle', 'b.txt': 'needle' })
    fs.linkSync(path.join(outside, 'rules.txt'), path.join(linked, '.gitignore'))
    const rig = await rigOf(t, linked)
    if (rig !== undefined) assert.deepEqual(await found(rig), ['a.txt', 'b.txt'], 'hard link')
    const sym = folders(t)()
    write(sym, { 'a.txt': 'needle', 'b.txt': 'needle' })
    if (trySymlink(path.join(outside, 'rules.txt'), path.join(sym, '.gitignore'), 'file')) {
      const r = await rigOf(t, sym)
      if (r !== undefined) assert.deepEqual(await found(r), ['a.txt', 'b.txt'], 'symlink')
    }
    const excluded = folders(t)()
    write(excluded, { 'a.txt': 'needle', 'b.txt': 'needle', '.gitignore': 'b.txt' })
    const e = await rigOf(t, excluded, { exclude: ['.gitignore'] })
    if (e !== undefined) assert.deepEqual(await found(e), ['a.txt', 'b.txt'], 'excluded')
  })

  test('an exclusion and skip decide first: no ! rule shows an excluded name or enters a skipped folder', async t => {
    const root = folders(t)()
    write(root, {
      '.gitignore': '!.env\n!node_modules/\n!secret.txt\n',
      '.env': 'needle',
      'secret.txt': 'needle',
      'node_modules/m/i.js': 'needle',
      'a.txt': 'needle',
    })
    const rig = await rigOf(t, root, { exclude: ['secret.txt'] })
    if (rig === undefined) return
    assert.deepEqual(await paths(rig, { depth: 3 }), ['.gitignore', 'a.txt', 'node_modules'])
    assert.deepEqual(await found(rig), ['a.txt'])
  })

  test('an ignored name still counts as a visited name', async t => {
    // 4 names against a budget of 3, and only `.gitignore` is not ignored. The walk is cut only when the ignored names
    // count, whatever order the file system lists the names in.
    const root = folders(t)()
    write(root, { '.gitignore': '*.log', 'a1.log': 'x', 'a2.log': 'x', 'a3.log': 'x' })
    const rig = await rigOf(t, root, { limits: { searchFiles: 3 } })
    if (rig === undefined) return
    const result = await rig.call('list', {})
    const shown = result.entries.map((e: { path: string }) => e.path)
    assert.ok(
      shown.every((p: string) => p === '.gitignore'),
      `no ignored name is shown: ${JSON.stringify(shown)}`,
    )
    assert.equal(result.truncated, true)
  })

  test('hostile rules never fail a call', async t => {
    const texts = [
      '[z-a]\n*',
      '\\ ',
      '/\n!\n/',
      'a'.repeat(LIMITS.ignoreBytes - 1),
      '\n'.repeat(10_000),
      '*a*a*a*a*a*b',
    ]
    for (const text of texts) {
      const root = folders(t)()
      write(root, { '.gitignore': text, 'a.txt': 'needle' })
      const rig = await rigOf(t, root)
      if (rig === undefined) return
      await paths(rig)
      await found(rig)
    }
  })

  test('no error text or description holds a line of the file', async t => {
    const root = folders(t)()
    const secret = marker()
    write(root, { '.gitignore': `${secret}\nout/`, 'out/a.txt': 'x' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.ok(!(await rig.fail('read', { path: 'nothing' })).includes(secret))
    const tools = (await rig.client.listTools()).tools
    for (const name of ['list', 'search']) {
      const description = tools.find(tool => tool.name === name)!.description!
      assert.match(description, /\.gitignore of the root hides/)
      assert.ok(!description.includes(secret))
    }
  })
})
