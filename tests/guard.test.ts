// The guard of the folders in guardedDirs, as pure code: the realpath is a fake that counts its calls.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUARD_DEPTH,
  GUARD_PARENT_STEPS,
  GUARD_REALPATHS,
  absolutePath,
  guardHit,
  guardedList,
  isPathLike,
  markerIn,
  realPathOf,
  resolveGuarded,
  type Realpath,
} from '../src/core/guard.ts'
import { GUARD_MARKERS } from '../src/core/paths.ts'

const HOME = '/home/u'
const PROJECT = '/work/app'
const LIST = guardedList(HOME, PROJECT)

/** A realpath that finds every path, as itself, except a path in or at a link: it gets the target. It records each path. */
const fake = (links: Record<string, string> = {}) => {
  const asked: string[] = []
  const realpath: Realpath = async p => {
    asked.push(p)
    const link = Object.keys(links).find(l => p === l || p.startsWith(`${l}/`))
    return link === undefined ? p : links[link] + p.slice(link.length)
  }
  return { asked, realpath }
}

const hit = (args: unknown, f = fake(), cwd = PROJECT) =>
  guardHit(args, {
    home: HOME,
    cwd,
    list: LIST,
    forms: () => resolveGuarded(LIST, f.realpath),
    realpath: f.realpath,
  })

describe('the markers', () => {
  test('are the four folders, never the bare state folder', () => {
    assert.deepEqual(GUARD_MARKERS, [
      '.toolscript-mcp/hints',
      '.toolscript-mcp/functions',
      '.toolscript-mcp/learned',
      '.toolscript-mcp/oauth',
    ])
  })

  test('match at a name boundary, in any case, with either slash', () => {
    for (const text of [
      '.toolscript-mcp/hints',
      'echo x >> ~/.toolscript-mcp/hints/a.md',
      'cat $HOME/.TOOLSCRIPT-MCP/Hints/x',
      'C:\\Users\\u\\.toolscript-mcp\\oauth\\f-1.json',
      '"~/.toolscript-mcp/learned"',
      '.toolscript-mcp/functions/f.md',
      'x.toolscript-mcp/hints-old .toolscript-mcp/hints',
    ])
      assert.notEqual(markerIn(text), undefined, text)
  })

  test('do not match a name that goes on, a bare state folder or another prefix', () => {
    for (const text of [
      '.toolscript-mcp/hints-old/x.md',
      '.toolscript-mcp/hints.bak',
      '.toolscript-mcp/hints_x',
      '.toolscript-mcp/hints2',
      'my.toolscript-mcp/hints',
      'a-.toolscript-mcp/oauth',
      '.toolscript-mcp-notes/hints/x.md',
      '.toolscript-mcp/files/s/out.json',
      '.toolscript-mcp/runs.jsonl',
      '.toolscript-mcp',
      'hints',
    ])
      assert.equal(markerIn(text), undefined, text)
  })
})

describe('a path candidate', () => {
  test('is a string that starts as a path or holds a separator', () => {
    for (const text of [
      '/a',
      '~',
      '~/a',
      '\\\\server\\share',
      'C:\\a',
      'C:/a',
      '.',
      '..',
      './a',
      'a/b',
      'a\\b',
      '.hidden',
    ])
      assert.equal(isPathLike(text), true, text)
  })

  test('is not a word, a URL, text with a line break or NUL, or a long string', () => {
    for (const text of [
      '',
      'word',
      'two words',
      'C:a',
      'https://example.com/a/b',
      'file:///a/b',
      'a\nb/c',
      'a/b\0',
      'x'.repeat(4097),
    ])
      assert.equal(isPathLike(text), false, text.slice(0, 20))
    assert.equal(isPathLike(`/${'x'.repeat(4095)}`), true)
  })

  test('absolutePath resolves the home, a drive, backslashes, dots and a relative path', () => {
    assert.equal(absolutePath('~/.x', HOME, PROJECT), '/home/u/.x')
    assert.equal(absolutePath('~', HOME, PROJECT), '/home/u')
    assert.equal(absolutePath('a/../b/./c', HOME, PROJECT), '/work/app/b/c')
    assert.equal(absolutePath('C:\\Users\\u\\x\\..\\y', HOME, PROJECT), 'C:/Users/u/y')
    assert.equal(absolutePath('~\\a', 'C:\\Users\\u', 'C:\\w'), 'C:/Users/u/a')
    assert.equal(absolutePath('a\\b', 'C:\\Users\\u', 'C:\\w'), 'C:/w/a/b')
  })
})

describe('the folders', () => {
  test('are the four of the home and the project hints, each with the name that a refusal gives', () => {
    assert.deepEqual(
      LIST.map(l => l.label),
      [
        '~/.toolscript-mcp/hints',
        '~/.toolscript-mcp/functions',
        '~/.toolscript-mcp/learned',
        '~/.toolscript-mcp/oauth',
        '.toolscript-mcp/hints',
      ],
    )
    assert.deepEqual(guardedList('', ''), [])
  })

  test('realPathOf adds the missing rest to the real path of the deepest part that exists', async () => {
    const real: Realpath = async p => {
      if (p === '/a/link') return '/real/target'
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    assert.equal(await realPathOf('/a/link/new/x.md', real), '/real/target/new/x.md')
    assert.equal(await realPathOf('/a/none', real), undefined)
  })

  test('realPathOf stops after the parent steps', async () => {
    const asked: string[] = []
    const never: Realpath = async p => (asked.push(p), Promise.reject(new Error('missing')))
    const deep = `/${Array.from({ length: 60 }, (_, i) => `d${i}`).join('/')}`
    assert.equal(await realPathOf(deep, never), undefined)
    assert.equal(asked.length, GUARD_PARENT_STEPS + 1)
  })
})

describe('guardHit', () => {
  test('names the folder for a path, under any case and with dots, and for a project hint', async () => {
    assert.equal(await hit({ p: '/home/u/.toolscript-mcp/hints/x.md' }), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ p: '/home/u/.toolscript-mcp/files/../oauth/f.json' }), '~/.toolscript-mcp/oauth')
    assert.equal(await hit({ p: '/HOME/U/.Toolscript-MCP/Functions' }), '~/.toolscript-mcp/functions')
    // the marker answers first, so a path with the name of a folder gets the name of the home folder
    assert.equal(await hit({ p: '/work/app/.toolscript-mcp/hints/x.md' }), '~/.toolscript-mcp/hints')
  })

  test('a path with no marker needs the guarded folder itself, and a link gives the project hints their own name', async () => {
    assert.equal(await hit({ p: 'hints/x.md' }, fake(), '/home/u/.toolscript-mcp'), '~/.toolscript-mcp/hints')
    assert.equal(
      await hit({ p: 'x/y.md' }, fake({ '/work/app/x': '/work/app/.toolscript-mcp/hints' })),
      '.toolscript-mcp/hints',
    )
  })

  test('names the folder for a text that holds a marker', async () => {
    assert.equal(await hit({ command: 'echo x >> ~/.toolscript-mcp/hints/a.md' }), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ command: 'cat $HOME/.toolscript-mcp/learned/shapes.json' }), '~/.toolscript-mcp/learned')
  })

  test('follows a link of the real path, also under a folder that does not exist yet', async () => {
    const f = fake({ '/tmp/link': '/home/u/.toolscript-mcp/hints' })
    assert.equal(await hit({ p: '/tmp/link/x.md' }, f), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ p: '/tmp/link/new/deeper/x.md' }, f), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ p: '/tmp/other/x.md' }, f), undefined)
  })

  test('compares the path with the real path of a guarded folder too', async () => {
    const f = fake({ '/home/u/.toolscript-mcp/hints': '/real/hints' })
    assert.equal(await hit({ p: '/real/hints/x.md' }, f), '~/.toolscript-mcp/hints')
  })

  test('passes the paths that are not in a guarded folder', async () => {
    for (const p of [
      '/home/u/.toolscript-mcp/files/s/out.json',
      '/home/u/.toolscript-mcp/runs.jsonl',
      '/home/u/.toolscript-mcp/hints-old/x.md',
      '/work/app/src/hints/x.md',
      '/work/app/README.md',
      '/work/app/.toolscript-mcp-notes/hints/x.md',
      'https://example.com/a/b',
      'plain word',
    ])
      assert.equal(await hit({ p }), undefined, p)
  })

  test('reads values and array items to the depth, and never keys', async () => {
    const marked = '~/.toolscript-mcp/hints/x.md'
    const nested = (levels: number): unknown => {
      let value: unknown = marked
      for (let i = 1; i <= levels; i++) value = i % 2 === 0 ? [value] : { k: value }
      return value
    }
    assert.equal(GUARD_DEPTH, 16)
    // The arguments are the first object: a string inside 16 of them is read.
    assert.notEqual(await hit(nested(GUARD_DEPTH)), undefined)
    assert.equal(await hit(nested(GUARD_DEPTH + 1)), undefined)
    assert.equal(await hit({ [marked]: 1 }), undefined)
    assert.notEqual(await hit({ edits: [{ file: { path: marked } }] }), undefined)
  })

  test('reads a string of at most 4096 characters, and a longer one is content', async () => {
    const at = (n: number) => `${' '.repeat(n - 21)}.toolscript-mcp/hints`
    assert.notEqual(await hit({ t: at(4096) }), undefined)
    assert.equal(await hit({ t: at(4097) }), undefined)
  })

  test('makes no file system call for a call with no path candidate', async () => {
    const f = fake()
    assert.equal(await hit({ a: 'word', b: 5, c: ['x', 'y'], d: 'https://example.com/a', e: null }, f), undefined)
    assert.equal(await hit({ list: Array.from({ length: 1000 }, (_, i) => `s${i}`) }, f), undefined)
    assert.deepEqual(f.asked, [])
  })

  test('gives only the first 16 candidates a real path', async () => {
    const f = fake({ '/l/x': '/home/u/.toolscript-mcp/hints' })
    const paths = (n: number) => ({
      list: Array.from({ length: n }, (_, i) => (i === n - 1 ? '/l/x/a.md' : `/p/${i}`)),
    })
    assert.equal(await hit(paths(GUARD_REALPATHS), f), '~/.toolscript-mcp/hints')
    assert.equal(await hit(paths(GUARD_REALPATHS + 1), f), undefined)
    const counted = fake()
    await hit(paths(40), counted)
    assert.equal(counted.asked.length, LIST.length + GUARD_REALPATHS)
  })

  test('gives a UNC path the lexical check only, so no connection opens to its host', async () => {
    const f = fake()
    assert.equal(await hit({ p: '\\\\fake-host\\share\\a.png', q: '//fake-host/share/b.png' }, f), undefined)
    assert.deepEqual(
      f.asked.filter(p => p.includes('fake-host')),
      [],
    )
  })

  test('resolves the guarded folders one time for a call', async () => {
    const f = fake()
    await hit({ a: '/p/1', b: '/p/2' }, f)
    assert.equal(f.asked.filter(p => p.includes('.toolscript-mcp')).length, LIST.length)
  })

  test('an empty home and project guard no path, and the markers still hold', async () => {
    const f = fake()
    const none = { home: '', cwd: '/w', list: guardedList('', ''), forms: async () => [], realpath: f.realpath }
    assert.equal(await guardHit({ p: '/x/y' }, none), undefined)
    assert.deepEqual(f.asked, [])
    assert.notEqual(await guardHit({ p: '~/.toolscript-mcp/oauth' }, none), undefined)
  })
})
