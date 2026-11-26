import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileUriPath, narrowRoot } from '../src/core/roots.ts'

describe('fileUriPath', () => {
  const win = (uri: unknown) => fileUriPath(uri, 'win32')
  const posix = (uri: unknown) => fileUriPath(uri, 'linux')

  test('Windows: the forms that clients send', () => {
    const table: [string, string][] = [
      ['file:///C:/Users/me/Projects/app', 'C:\\Users\\me\\Projects\\app'],
      ['file:///c%3A/Users/me/Projects/app', 'c:\\Users\\me\\Projects\\app'],
      ['file:///c%3a/Users/me/app', 'c:\\Users\\me\\app'],
      ['file:///C:/Users/me/My%20Project/', 'C:\\Users\\me\\My Project'],
      ['FILE:///C:/a', 'C:\\a'],
      ['file://localhost/C:/a/b', 'C:\\a\\b'],
      ['file://LOCALHOST/C:/a', 'C:\\a'],
      ['file:///C:/', 'C:\\'],
      ['file:///C:/caf%C3%A9', 'C:\\café'],
    ]
    for (const [uri, path] of table) assert.equal(win(uri), path, uri)
  })

  test('POSIX: the forms that clients send', () => {
    const table: [string, string][] = [
      ['file:///home/me/projects/app', '/home/me/projects/app'],
      ['file:///home/me/caf%C3%A9', '/home/me/café'],
      ['file://localhost/home/me/app', '/home/me/app'],
      ['file:///home/me/app/', '/home/me/app'],
      ['file:///home/me/a%5Cb', '/home/me/a\\b'],
      ['file:///home/me/a\\b', '/home/me/a\\b'],
      ['file:/home/me/app', '/home/me/app'],
      ['file:///', '/'],
      ['file:///home/me/%E4%B8%AD', '/home/me/中'],
    ]
    for (const [uri, path] of table) assert.equal(posix(uri), path, uri)
  })

  test('both platforms refuse what names no local folder, and never throw', () => {
    const bad = [
      'http://example.com/a',
      'c:/a',
      '',
      'file:',
      'file://server/share/app',
      'file:////server/share',
      'file:///%2F%2Fserver/share',
      'file:///?x',
      'file:///a?x=1',
      'file:///a#frag',
      'file:///a/%zz',
      'file:///a/%FF',
      'file:///a/%C3',
      'file:///a/b%2Fc',
      'file:///a/b%00c',
      'file:///a/b%0Ac',
      'file:///a/./b',
      'file:///a/../b',
      'file:///a/%2E%2E/b',
      'file:///a//b',
      `file:///${'a'.repeat(5000)}`,
      'file://?/C:/a',
    ]
    for (const uri of bad) {
      assert.equal(win(uri), undefined, `win ${uri.slice(0, 40)}`)
      assert.equal(posix(uri), undefined, `posix ${uri.slice(0, 40)}`)
    }
    for (const value of [undefined, null, 5, {}, [], ['file:///a']]) {
      assert.equal(win(value), undefined)
      assert.equal(posix(value), undefined)
    }
  })

  test('Windows needs a drive and refuses a decoded backslash', () => {
    for (const uri of ['file:///Users/me/app', 'file:///', 'file:///C/Users', 'file:///C:%5CUsers', 'file:///C:/a%5Cb'])
      assert.equal(win(uri), undefined, uri)
  })

  test('a drive form is only a folder name on POSIX', () => {
    assert.equal(posix('file:///C:/a'), '/C:/a')
  })
})

describe('narrowRoot', () => {
  const root = (bound: string, list: string[], platform = 'linux') => narrowRoot(bound, list, platform)
  const P = '/home/me/Projects'

  test('the cases of the bar, with the list in both orders', () => {
    const table: { bound: string; roots: string[]; expect: string; name: string }[] = [
      { name: 'one root inside', bound: P, roots: [`${P}/app`], expect: `${P}/app` },
      { name: 'two siblings', bound: P, roots: [`${P}/app`, `${P}/lib`], expect: P },
      { name: 'two inside one folder', bound: P, roots: [`${P}/app/src`, `${P}/app/tests`], expect: `${P}/app` },
      { name: 'equal', bound: P, roots: [P], expect: P },
      { name: 'the parent', bound: P, roots: ['/home/me'], expect: P },
      { name: 'an ancestor and a child', bound: P, roots: ['/home/me', `${P}/app`], expect: P },
      { name: 'another folder', bound: P, roots: ['/other'], expect: P },
      { name: 'a sibling of the bound root', bound: `${P}/app`, roots: [`${P}/lib`], expect: `${P}/app` },
      { name: 'none', bound: P, roots: [], expect: P },
      { name: 'one outside is dropped', bound: P, roots: ['/other', `${P}/app`], expect: `${P}/app` },
      { name: 'a name that starts the same', bound: P, roots: [`${P}-old/app`], expect: P },
      { name: 'a deep pair', bound: P, roots: [`${P}/a/b/c`, `${P}/a/b/d/e`], expect: `${P}/a/b` },
    ]
    for (const { name, bound, roots, expect } of table) {
      assert.equal(root(bound, roots), expect, name)
      assert.equal(root(bound, [...roots].reverse()), expect, `${name}, reversed`)
    }
  })

  test('Windows folds case, and the result keeps the spelling of a root', () => {
    const W = 'C:\\Users\\me\\Projects'
    assert.equal(root(W, ['c:\\users\\ME\\projects\\App'], 'win32'), 'c:\\users\\ME\\projects\\App')
    assert.equal(root(W, ['C:\\Users\\me\\Projects\\app', 'C:\\Users\\me\\Projects\\lib'], 'win32'), W)
    assert.equal(root(W, ['D:\\Other'], 'win32'), W)
    assert.equal(root(W, ['C:\\Users\\me'], 'win32'), W)
  })

  test('macOS: the volume decides whether a client root that differs in case is inside the bound root', () => {
    const P = '/Volumes/work/proj/app'
    assert.equal(narrowRoot(P, ['/Volumes/work/proj/App'], 'darwin', false), P)
    assert.equal(narrowRoot(P, ['/Volumes/work/proj/App/src'], 'darwin', false), P)
    assert.equal(narrowRoot(P, ['/Volumes/work/proj/App/src'], 'darwin', true), '/Volumes/work/proj/App/src')
    assert.equal(narrowRoot(P, ['/Volumes/work/proj/App/src'], 'darwin'), '/Volumes/work/proj/App/src')
  })

  test('on POSIX a different case is another folder', () => {
    assert.equal(root(P, ['/home/me/projects/app']), P)
  })

  test('the result is always the bound root or inside it', () => {
    const roots = ['/', '/home', P, `${P}/a`, `${P}/b/c`, '/x']
    for (const a of roots)
      for (const b of roots) {
        const got = root(P, [a, b])
        assert.ok(got === P || got.startsWith(`${P}/`), `${a} ${b} gave ${got}`)
      }
  })
})
