// The guard of the folders in guardedDirs, as pure code: the realpath is a fake that counts its calls.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUARD_DEPTH,
  GUARD_PARENT_STEPS,
  GUARD_REALPATHS,
  absolutePath,
  guardFind,
  guardHit,
  guardedList,
  isFileName,
  isPathLike,
  markerIn,
  realPathOf,
  resolveGuarded,
  type Realpath,
} from '../src/core/guard.ts'
import { GUARD_MARKERS, normalizePath } from '../src/core/paths.ts'

const HOME = '/home/u'
const PROJECT = '/work/app'
const LIST = guardedList(HOME, PROJECT)

/** A realpath that finds every path, as itself, except a path in or at a link: it gets the target. It records each path. */
const fake = (links: Record<string, string> = {}) => {
  const asked: string[] = []
  const realpath: Realpath = async p => {
    asked.push(p)
    const link = Object.keys(links).find(l => p === l || p.startsWith(`${l}/`))
    // As a POSIX file system does: a link is replaced by its target before a `..` after it.
    return normalizePath(link === undefined ? p : links[link] + p.slice(link.length))
  }
  return { asked, realpath }
}

const hit = (args: unknown, f = fake(), cwd = PROJECT, windows = false) =>
  guardHit(args, {
    home: HOME,
    cwd,
    list: LIST,
    forms: () => resolveGuarded(LIST, f.realpath),
    realpath: f.realpath,
    windows,
  })

// The marker text of a guarded folder is built from parts here, because the guard refuses any call whose argument holds
// it, also a Workspace edit of this file.
const MARK = '.' + 'toolscript-mcp' + '/hints'

describe('guardFind: the key path of the string that hit', () => {
  const find = (args: unknown) =>
    guardFind(args, {
      home: HOME,
      cwd: PROJECT,
      list: LIST,
      forms: () => resolveGuarded(LIST, fake().realpath),
      realpath: fake().realpath,
      windows: false,
    })

  test('names a nested edit, a deep object, an array and the arguments as a whole', async () => {
    const text = 'see ~/' + MARK + ' now'
    assert.deepEqual(await find({ path: 'a.md', edits: [{ old: 'x', new: text }] }), {
      label: '~/' + MARK,
      at: 'edits[0].new',
    })
    assert.equal((await find({ a: { b: { c: { d: text } } } }))?.at, 'a.b.c.d')
    assert.equal((await find({ items: ['ok', ['ok', text]] }))?.at, 'items[1][1]')
    assert.equal((await find({ content: text }))?.at, 'content')
    assert.equal((await find(text))?.at, '')
    assert.equal((await find([text]))?.at, '[0]')
  })

  test('names the argument of a path hit too, and keeps `guardHit` the same', async () => {
    assert.deepEqual(await find({ file: '/home/u/' + MARK + '/x.md' }), { label: '~/' + MARK, at: 'file' })
    assert.equal(await hit({ file: '/home/u/' + MARK + '/x.md' }), '~/' + MARK)
  })

  test('the path carries no argument text: an odd key shows as a dots mark, and a long path is cut', async () => {
    const text = 'x ' + MARK
    assert.equal((await find({ ['bad key/' + MARK]: text }))?.at, '…')
    assert.equal((await find({ ['k'.repeat(41)]: text }))?.at, '…')
    const deep = [...Array(14).keys()].reduce<unknown>(acc => ({ ['k'.repeat(30)]: acc }), text)
    const at = (await find(deep))?.at ?? ''
    assert.ok(at.length <= 101 && at.endsWith('…'), at)
    assert.ok(!at.includes(MARK) && !at.includes('x '), at)
  })
})

describe('the markers', () => {
  test('are the six folders, never the bare state folder', () => {
    assert.deepEqual(GUARD_MARKERS, [
      '.toolscript-mcp/hints',
      '.toolscript-mcp/functions',
      '.toolscript-mcp/learned',
      '.toolscript-mcp/oauth',
      '.toolscript-mcp/broker',
      '.toolscript-mcp/locks',
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
  test('are the six of the home and the project hints, each with the name that a refusal gives', () => {
    assert.deepEqual(
      LIST.map(l => l.label),
      [
        '~/.toolscript-mcp/hints',
        '~/.toolscript-mcp/functions',
        '~/.toolscript-mcp/learned',
        '~/.toolscript-mcp/oauth',
        '~/.toolscript-mcp/broker',
        '~/.toolscript-mcp/locks',
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

  test('reads a string of any length for a marker, and never makes a path of one over 4096 characters', async () => {
    const at = (n: number) => `${' '.repeat(n - 21)}.toolscript-mcp/hints`
    assert.notEqual(await hit({ t: at(4096) }), undefined)
    assert.notEqual(await hit({ t: at(4097) }), undefined)
    assert.notEqual(await hit({ t: at(200_000) }), undefined)
    assert.notEqual(
      await hit({ t: `cat > ~/.toolscript-mcp/hints/x.md <<EOF\n${'line\n'.repeat(1000)}EOF` }),
      undefined,
    )
    const f = fake()
    assert.equal(await hit({ t: `/${'x'.repeat(4096)}` }, f), undefined)
    assert.deepEqual(f.asked, [])
  })

  test('passes a long text with no folder name and makes no file system call', async () => {
    const f = fake()
    const json = JSON.stringify(Array.from({ length: 60000 }, (_, i) => ({ id: i, name: `item ${i}` })))
    assert.ok(json.length > 1_000_000)
    assert.equal(
      await hit({ json, source: 'const a = 1\n'.repeat(20000), shell: 'echo hi\n'.repeat(800) }, f),
      undefined,
    )
    assert.deepEqual(f.asked, [])
  })

  test('makes no file system call for a call with no path candidate', async () => {
    const f = fake()
    assert.equal(await hit({ a: 'word', b: 5, c: ['x', 'y'], d: 'https://example.com/a', e: null }, f), undefined)
    assert.equal(await hit({ list: Array.from({ length: 1000 }, (_, i) => `s${i}`) }, f), undefined)
    assert.deepEqual(f.asked, [])
  })

  test('resolves a link before the .. that follows it, also for a file that does not exist yet', async () => {
    const f = fake({ '/work/alias': '/home/u/.toolscript-mcp/hints' })
    // the link points into hints, so `..` leaves hints for the folder beside it
    assert.equal(await hit({ p: '/work/alias/../oauth/token.json' }, f), '~/.toolscript-mcp/oauth')
    assert.equal(await hit({ p: '/work/alias/../oauth/new/deeper/t.json' }, f), '~/.toolscript-mcp/oauth')
    assert.equal(await hit({ p: '/work/alias/../elsewhere/t.json' }, f), undefined)
  })

  test('also resolves the path with its .. folded by name, so a .. before a link name cannot hide it', async () => {
    const links = fake({ '/work/alias': '/home/u/.toolscript-mcp/hints' })
    const f = {
      asked: links.asked,
      realpath: (p: string) =>
        /\/(?:new|nope)(?:\/|$)/.test(p) ? Promise.reject(new Error('missing')) : links.realpath(p),
    }
    for (const p of [
      '/work/alias/../alias/x.md',
      '/work/nope/../alias/x.md',
      `/work/alias/new${'/x/..'.repeat(20)}/t.json`,
    ])
      assert.equal(await hit({ p }, f), '~/.toolscript-mcp/hints', p)
  })

  test('spends no parent step on a doubled separator or a /./ after a link', async () => {
    const links = fake({ '/work/alias': '/home/u/.toolscript-mcp/hints' })
    // the folder `new` does not exist yet, so the walk steps up to the link
    const f = {
      asked: links.asked,
      realpath: (p: string) => (/\/new(?:\/|$)/.test(p) ? Promise.reject(new Error('missing')) : links.realpath(p)),
    }
    const many = `/work/alias/new${'/'.repeat(40)}token.json`
    assert.equal(await hit({ p: many }, f), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ p: `/work/alias/new${'/.'.repeat(40)}/token.json` }, f), '~/.toolscript-mcp/hints')
  })

  test('realPathOf keeps the .. parts as written when it steps up for a path that does not exist', async () => {
    const asked: string[] = []
    const real: Realpath = async p => {
      asked.push(p)
      if (p === '/work/alias/../oauth') return '/home/u/.toolscript-mcp/oauth'
      throw new Error('missing')
    }
    assert.equal(await realPathOf('/work/alias/../oauth/new.md', real), '/home/u/.toolscript-mcp/oauth/new.md')
    assert.deepEqual(asked, ['/work/alias/../oauth/new.md', '/work/alias/../oauth'])
  })

  test('checks a bare file name in the folder of the server, and no word of prose', async () => {
    const f = fake({ '/work/app/notes.json': '/home/u/.toolscript-mcp/oauth/f.json' })
    assert.equal(await hit({ file: 'notes.json' }, f), '~/.toolscript-mcp/oauth')
    assert.equal(await hit({ file: 'other.json' }, f), undefined)
    const prose = fake()
    assert.equal(
      await hit({ a: 'hello', b: 'running', c: 'two words.txt', d: 'v1.2 notes', e: 'end.' }, prose),
      undefined,
    )
    assert.deepEqual(prose.asked, [])
    for (const text of ['notes.json', 'a.b', 'x_y-z.tar.gz']) assert.equal(isFileName(text), true, text)
    for (const text of ['notes', 'a b.txt', `${'x'.repeat(256)}.txt`, 'a.', 'a/b.txt', 'https://e.com']) {
      assert.equal(isFileName(text), false, text.slice(0, 20))
    }
  })

  test('gives only 16 bare file names a real path', async () => {
    const counted = fake()
    await hit({ names: Array.from({ length: 40 }, (_, i) => `f${i}.txt`) }, counted)
    assert.equal(counted.asked.length, LIST.length + GUARD_REALPATHS)
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

  test('reads \\\\?\\C:\\ and \\\\.\\C:\\ as the local path, and still sends no UNC path to realpath', async () => {
    const list = guardedList('C:/Users/u', '')
    const f = fake()
    const at = (p: string) =>
      guardHit(
        { p },
        {
          home: 'C:/Users/u',
          cwd: 'C:/w',
          list,
          forms: () => resolveGuarded(list, f.realpath),
          realpath: f.realpath,
          windows: true,
        },
      )
    assert.equal(await at('\\\\?\\C:\\Users\\u\\.toolscript-mcp\\files\\..\\hints\\a.md'), '~/.toolscript-mcp/hints')
    assert.equal(await at('\\\\.\\C:\\Users\\u\\.toolscript-mcp\\files\\..\\oauth\\a.json'), '~/.toolscript-mcp/oauth')
    assert.equal(await at('\\\\?\\C:\\Users\\u\\.toolscript-mcp\\files\\a.json'), undefined)
    assert.equal(await at('\\\\?\\UNC\\fake-host\\share\\a'), undefined)
  })

  test('gives a UNC path the lexical check only, so no connection opens to its host', async () => {
    const f = fake()
    const args = {
      p: '\\\\fake-host\\share\\a.png',
      q: '//fake-host/share/b.png',
      r: '\\\\?\\UNC\\fake-host\\share\\c',
    }
    assert.equal(await hit(args, f, PROJECT, true), undefined)
    assert.deepEqual(
      f.asked.filter(p => p.includes('fake-host')),
      [],
    )
  })

  test('on Linux and macOS, // and \\\\ are local paths that get the walk', async () => {
    const f = fake({ '/work/alias': '/home/u/.toolscript-mcp/hints' })
    assert.equal(await hit({ p: '/work/alias/x.md' }, f), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ p: '//work/alias/x.md' }, f), '~/.toolscript-mcp/hints')
    assert.equal(await hit({ p: '\\\\work\\alias\\x.md' }, f), '~/.toolscript-mcp/hints')
    const w = fake({ '/work/alias': '/home/u/.toolscript-mcp/hints' })
    assert.equal(await hit({ p: '//work/alias/x.md' }, w, PROJECT, true), undefined)
    assert.deepEqual(
      w.asked.filter(p => p.includes('alias')),
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
    const none = {
      home: '',
      cwd: '/w',
      list: guardedList('', ''),
      forms: async () => [],
      realpath: f.realpath,
      windows: false,
    }
    assert.equal(await guardHit({ p: '/x/y' }, none), undefined)
    assert.deepEqual(f.asked, [])
    assert.notEqual(await guardHit({ p: '~/.toolscript-mcp/oauth' }, none), undefined)
  })
})

describe('the gaps of issue 107', () => {
  const winGuard = (f: ReturnType<typeof fake>) => {
    const list = guardedList('C:/Users/u', '')
    return (p: string) =>
      guardHit(
        { p },
        {
          home: 'C:/Users/u',
          cwd: 'C:/w',
          list,
          forms: () => resolveGuarded(list, f.realpath),
          realpath: f.realpath,
          windows: true,
        },
      )
  }

  test('(b) a percent-encoded name is read once decoded, and %252F is not decoded twice', () => {
    for (const text of [
      'file:///home/u/.toolscript-mcp%2Fhints/x.md',
      'x/%2Etoolscript-mcp/hints/x.md',
      'cat ~/.toolscript-mcp%2foauth/t.json',
      '%2E%74oolscript-mcp/learned',
    ])
      assert.notEqual(markerIn(text), undefined, text)
    for (const text of ['.toolscript-mcp%252Fhints', '.toolscript-mcp%2Fhints-old', '%', '%zz', '100%', 'a%E0%', '%2'])
      assert.equal(markerIn(text), undefined, text)
  })

  test('(b) a file:// URL is a path candidate, in any letter case, with its decoded path walked', async () => {
    const link = { '/work/alias': '/home/u/.toolscript-mcp/hints' }
    for (const p of [
      'file:///home/u/.toolscript-mcp/files/../oauth/t.json',
      'FILE:///home/u/.toolscript-mcp/files/../oauth/t.json',
      'file://localhost/home/u/.toolscript-mcp/files/..%2Foauth/t.json',
      'file:///home/u/.toolscript-mcp/files/%2E%2E/oauth/t.json',
      'file:///work/alias/x.md',
      'File://work/alias/x.md',
    ])
      assert.notEqual(await hit({ p }, fake(link)), undefined, p)
    const f = fake()
    assert.equal(await hit({ p: 'file:///work/app/README.md' }, f), undefined)
    assert.ok(f.asked.includes('/work/app/README.md'), String(f.asked))
    for (const p of ['https://example.com/a%2Fb?q=1%20x', 's3://bucket/key', 'data:text/plain,a%2Fb', 'ftp://h/a/b']) {
      const g = fake()
      assert.equal(await hit({ p }, g), undefined, p)
      assert.deepEqual(g.asked, [], p)
    }
  })

  test('(b) a string that looks like a scheme but holds a .. part is a path, and other scheme text is not', async () => {
    const inside = '/home/u/.toolscript-mcp/hints/sub'
    for (const p of ['ab:x/..', 'data:x/..', 'file:x/..', 'a.md:z/..', 'ab:x\\..', 'ab://x/..', 'ab:x/../']) {
      assert.equal(isPathLike(p), true, p)
      assert.equal(await hit({ p }, fake(), inside), '~/.toolscript-mcp/hints', p)
    }
    for (const p of ['data:text/plain,a%2Fb', 'ab:x/y', 'ab://x/y', 'mailto:a@b.c']) {
      const g = fake()
      assert.equal(await hit({ p }, g, inside), undefined, p)
      assert.deepEqual(g.asked, [], p)
    }
  })

  test('(b) a file:// URL of more than 4096 characters is no path candidate', async () => {
    const p = `file:///home/u/.toolscript-mcp/files/../oauth/${'x'.repeat(4100)}`
    const g = fake()
    assert.equal(await hit({ p }, g), undefined)
    assert.deepEqual(g.asked, [])
  })

  test('(b) a file:// path on Windows: /C:/x is C:/x, and another host is UNC with no call', async () => {
    const f = fake()
    const at = winGuard(f)
    assert.equal(await at('file:///C:/Users/u/.toolscript-mcp/files/../oauth/t.json'), '~/.toolscript-mcp/oauth')
    assert.equal(await at('file:///C:/work/a.md'), undefined)
    assert.equal(await at('file://fake-host/share/a.png'), undefined)
    assert.deepEqual(
      f.asked.filter(p => p.includes('fake-host')),
      [],
    )
  })

  test('(d) a version, an address or a package is no file name, and a real name still is', () => {
    for (const text of ['v2.0', '1.2.3', '10.0.0.1', 'user@example.com', 'lodash@4.17.21', 'app.log.1', 'icon@2x.png'])
      assert.equal(isFileName(text), false, text)
    for (const text of ['notes.json', 'a.b', 'x_y-z.tar.gz', 'archive.7z', 'song.mp3', 'example.com'])
      assert.equal(isFileName(text), true, text)
  })

  test('(d) versions and addresses cost no real path call, a file name costs one', async () => {
    const f = fake()
    const args = { a: 'v2.0', b: '1.2.3', c: '10.0.0.1', d: 'user@example.com', e: 'lodash@4.17.21' }
    assert.equal(await hit(args, f), undefined)
    assert.deepEqual(f.asked, [])
    for (const name of ['example.com', 'notes.json']) {
      const g = fake()
      await hit({ a: name }, g)
      assert.equal(g.asked.filter(p => p === `/work/app/${name}`).length, 1, name)
    }
  })

  test('a doubled separator, a /./ and a backslash do not hide a marker', () => {
    for (const text of [
      'x/.toolscript-mcp//hints',
      'x/.toolscript-mcp/./hints',
      'x/.toolscript-mcp/.//./oauth',
      'x\\.toolscript-mcp\\\\learned',
    ])
      assert.notEqual(markerIn(text), undefined, text)
  })

  test('(e) a run of dots after a marker is part of its name, and a trailing dot or space on the state folder hides nothing', () => {
    for (const text of [
      '.toolscript-mcp/hints.',
      '.toolscript-mcp/hints./x.md',
      '.toolscript-mcp/hints..\\x',
      '.toolscript-mcp/hints. ',
      '.toolscript-mcp/oauth...',
      '.toolscript-mcp./hints',
      '.toolscript-mcp /hints',
      '.toolscript-mcp. ./oauth',
      'type %USERPROFILE%\\.toolscript-mcp\\oauth.\\t.json',
    ])
      assert.notEqual(markerIn(text), undefined, text)
    for (const text of [
      '.toolscript-mcp/hints.bak',
      '.toolscript-mcp/hints.2',
      '.toolscript-mcp/hints-old',
      '.toolscript-mcp/../hints/x.md',
      '.toolscript-mcp./files/x',
    ])
      assert.equal(markerIn(text), undefined, text)
  })

  test('(e) a part of a path loses its trailing dots and spaces before the compare, in the text and in the real path', async () => {
    const f = fake({ 'C:/Users/u/link': 'C:/Users/u/.toolscript-mcp/learned. ' })
    const at = winGuard(f)
    assert.equal(await at('C:/Users/u/.toolscript-mcp/x/../oauth./t.json'), '~/.toolscript-mcp/oauth')
    assert.equal(await at('C:/Users/u/.toolscript-mcp/hints. /a.md'), '~/.toolscript-mcp/hints')
    assert.equal(await at('C:/Users/u/link/shapes.json'), '~/.toolscript-mcp/learned')
    assert.equal(await at('C:/Users/u/.toolscript-mcp/files./a.json'), undefined)
    assert.equal(await at('C:/Users/u/.toolscript-mcp/hints.bak/x'), undefined)
    assert.equal(await at('C:/Users/u/.toolscript-mcp/files/../files/a.json'), undefined)
    // the text that goes to realpath stays as written
    const g = fake()
    await hit({ p: '/work/app/there./a.md' }, g)
    assert.ok(g.asked.includes('/work/app/there./a.md'), String(g.asked))
  })

  test('(e) a home part that ends in a dot or a space is guarded, on every OS, by path and by link', async () => {
    for (const [home, windows] of [
      ['/home/u.', false],
      ['/home/u.', true],
      ['/home/u ', false],
      ['C:/Users/u.', true],
      ['C:/Users/u.', false],
    ] as const) {
      const list = guardedList(home, '')
      const f = fake({ '/work/link': `${home}/.toolscript-mcp/hints` })
      const at = (p: string) =>
        guardHit(
          { p },
          { home, cwd: '/work', list, forms: () => resolveGuarded(list, f.realpath), realpath: f.realpath, windows },
        )
      const name = `${home} ${windows}`
      assert.equal(await at(`${home}/.toolscript-mcp/x/../hints/a.md`), '~/.toolscript-mcp/hints', name)
      assert.equal(await at(`${home}/.toolscript-mcp/x/../oauth/t`), '~/.toolscript-mcp/oauth', name)
      assert.equal(await at('/work/link/a.md'), '~/.toolscript-mcp/hints', name)
      assert.equal(await at(`${home}/.toolscript-mcp/files./a.json`), undefined, name)
    }
  })

  test('(e) a percent escape that makes a boundary or a letter of the name is still read, other text with % is not', () => {
    for (const text of ['a%20.toolscript-mcp/hints', '.%74oolscript-mcp/hints', '.toolscript%2Dmcp/oauth'])
      assert.notEqual(markerIn(text), undefined, text)
    for (const text of ['%3Cpath d=%22M0 0%22/%3E', 'a%2Fb', "LIKE '%x'"]) assert.equal(markerIn(text), undefined, text)
  })

  test('(6) the project folder at a root gets its own label', () => {
    assert.equal(guardedList('/root', '/').at(-1)?.label, '.toolscript-mcp/hints')
    assert.equal(guardedList('C:/Users/u', 'C:/').at(-1)?.label, '.toolscript-mcp/hints')
    assert.equal(guardedList('/home/u', '/home/u/work/app').at(-1)?.label, '~/work/app/.toolscript-mcp/hints')
    assert.equal(guardedList('/home/u', '/home/u').at(-1)?.label, '~/.toolscript-mcp/hints')
  })

  test('realistic arguments pass', async () => {
    const css = `a { width: calc(100% - 2px) } /* 50% */ SELECT * FROM t WHERE x LIKE '%a%'; printf "%s %d" a 1`
    const args = {
      css,
      p1: '/work/app/README.md',
      p2: './a/b',
      p3: '~/notes.md',
      p4: '/home/u/.toolscript-mcp/files/s/out.json',
      p5: '/home/u/.toolscript-mcp/runs.jsonl',
      p6: '/home/u/.toolscript-mcp/hints-old/x.md',
      p7: '/home/u/.toolscript-mcp/hints.bak',
      p8: 'file:///work/app/README.md',
    }
    assert.equal(await hit(args), undefined)
    assert.equal(await hit({ p: '\\\\fake-host\\share\\a.png' }, fake(), PROJECT, true), undefined)
  })
})
