// The confined file system and the four read tools, on real temp trees. Each fixture checks bytes and names that the
// result holds, never a success text. A fixture is refused when the call fails with its code, no byte or name from
// outside the root is in any result, and no file on disk changed.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DEFAULT_SKIP, LIMITS, makeExcluder } from '../src/core/workspace.ts'
import {
  openConfined,
  readCapped,
  sameFile,
  type Confined,
  type Dir,
  type Hook,
  type Opened,
} from '../src/host/workspace/confined.ts'
import { createProvider } from '../src/host/workspace/provider.ts'
import { codeOf, marker, open, rm, tempDir, trySymlink, write, type Rig, type RigOptions } from './workspace-rig.ts'

const win = process.platform === 'win32'
const mac = process.platform === 'darwin'

/** The temp folders of a test, removed at its end. */
const folders = (t: TestContext) => {
  const dirs: string[] = []
  t.after(() => dirs.forEach(rm))
  return (): string => {
    const dir = tempDir()
    dirs.push(dir)
    return dir
  }
}

/**
 * A rig for `root`, closed at the end of the test. When the method test of macOS fails, Workspace is unavailable
 * there by design (decision of issue #144): the test is skipped with the reason, and the macOS check below says so.
 */
const rigOf = async (t: TestContext, root: string, options: RigOptions = {}): Promise<Rig | undefined> => {
  const opened = await open(root, options)
  if ('unavailable' in opened) {
    if (mac) return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

describe('the method of this system', () => {
  test('passes, so Workspace is available (macOS: the CI run shows whether O_NOFOLLOW_ANY works)', async t => {
    const dir = folders(t)()
    const opened = await open(dir)
    if ('unavailable' in opened) {
      assert.ok(mac, `Workspace must be available on ${process.platform}: ${opened.unavailable}`)
      t.diagnostic(`macOS ships Workspace unavailable until a follow-up: ${opened.unavailable}`)
      return
    }
    t.after(() => opened.rig.close())
    t.diagnostic(`confined by ${opened.rig.bound.method}`)
    assert.equal(opened.rig.bound.method, win ? 'realpath' : mac ? 'nofollow-any' : 'proc')
  })

  test('a failed method test makes Workspace unavailable, with the reason', async t => {
    const dir = folders(t)()
    // Linux has no other system to claim: it claims macOS, whose flag it ignores. The others claim Linux, with no /proc.
    const claim = process.platform === 'linux' ? 'darwin' : 'linux'
    await assert.rejects(openConfined(dir, { platform: claim }), (err: Error) => {
      assert.match(err.message, /^unavailable: Workspace is not available on this system: /)
      return true
    })
    const opened = await open(dir, { platform: claim })
    assert.ok('unavailable' in opened)
    assert.match((opened as { unavailable: string }).unavailable, /not available on this system/)
  })

  test('macOS: O_NOFOLLOW_ANY refuses a symlink in a middle part', { skip: !mac }, async t => {
    const dir = folders(t)()
    const outside = folders(t)()
    write(dir, { 'real/f.txt': 'inside' })
    write(outside, { 'f.txt': marker() })
    fs.symlinkSync(outside, path.join(dir, 'mid'), 'dir')
    const confined = await openConfined(dir, { platform: 'darwin' })
    await assert.rejects(confined.file(['mid', 'f.txt']), { code: 'link' })
    const ok = await confined.file(['real', 'f.txt'])
    await ok.handle.close()
    await confined.close()
  })
})

describe('the compare of a handle and its path', () => {
  const id = (dev: bigint, ino: bigint) => ({ dev, ino })
  // [name, handle, path, root dev, platform, same]
  const table: [string, ReturnType<typeof id>, ReturnType<typeof id>, bigint, string, boolean][] = [
    ['windows: same file on the root volume', id(7n, 5n), id(7n, 5n), 7n, 'win32', true],
    [
      'windows: Node 22.13 gives dev 0 for the path, and the handle is on the root volume',
      id(7n, 5n),
      id(0n, 5n),
      7n,
      'win32',
      true,
    ],
    ['windows: dev 0 with a handle on another volume never passes', id(9n, 5n), id(0n, 5n), 7n, 'win32', false],
    [
      'windows: equal ino and dev on another volume than the root never passes',
      id(9n, 5n),
      id(9n, 5n),
      7n,
      'win32',
      false,
    ],
    ['windows: a real path dev that differs never passes', id(7n, 5n), id(9n, 5n), 7n, 'win32', false],
    ['windows: a different ino never passes', id(7n, 5n), id(7n, 6n), 7n, 'win32', false],
    ['linux: plain compare', id(7n, 5n), id(7n, 5n), 1n, 'linux', true],
    ['linux: dev 0 is no wildcard', id(7n, 5n), id(0n, 5n), 7n, 'linux', false],
    ['darwin: a different dev never passes', id(7n, 5n), id(8n, 5n), 7n, 'darwin', false],
    ['darwin: a different ino never passes', id(7n, 5n), id(7n, 6n), 7n, 'darwin', false],
  ]
  for (const [name, handle, atPath, rootDev, platform, same] of table)
    test(name, () => assert.equal(sameFile(handle, atPath, rootDev, platform), same))
})

describe('list, stat, read and search', () => {
  const tree = (root: string) =>
    write(root, {
      'src/retry.ts': 'export const maxAttempts: 3\nexport const retry = () => maxAttempts\n',
      'src/util/helpers.ts': '// helper: maxAttempts is used here\r\nexport const x = 1\r\n',
      'README.md': 'Retry docs\nMAXATTEMPTS in capitals\n',
      'node_modules/pkg/index.js': 'maxAttempts: 3 in a dependency\n',
      'dist/out.js': 'maxAttempts: 3 built\n',
      'empty/.keep': '',
    })

  test('list returns sorted entries with types and sizes, and stat tells what a path is', async t => {
    const root = folders(t)()
    tree(root)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const top = await rig.call('list')
    assert.deepEqual(
      top.entries.map((e: { path: string; type: string }) => [e.path, e.type]),
      [
        ['README.md', 'file'],
        ['dist', 'folder'],
        ['empty', 'folder'],
        ['node_modules', 'folder'],
        ['src', 'folder'],
      ],
    )
    assert.equal(top.truncated, false)
    assert.equal(top.entries[0].size, fs.statSync(path.join(root, 'README.md')).size)
    assert.equal(top.entries[1].size, undefined)
    const deep = await rig.call('list', { path: 'src', depth: 2 })
    assert.deepEqual(
      deep.entries.map((e: { path: string }) => e.path),
      ['src/retry.ts', 'src/util', 'src/util/helpers.ts'],
    )
    const globbed = await rig.call('list', { depth: 3, include: ['src/**/*.ts'] })
    assert.deepEqual(
      globbed.entries.map((e: { path: string }) => e.path),
      ['src/retry.ts', 'src/util/helpers.ts'],
    )
    assert.deepEqual(await rig.call('stat', { path: 'src/retry.ts' }), {
      path: 'src/retry.ts',
      type: 'file',
      size: fs.statSync(path.join(root, 'src', 'retry.ts')).size,
    })
    assert.deepEqual(await rig.call('stat', { path: 'src' }), { path: 'src', type: 'folder' })
    assert.deepEqual(await rig.call('stat', { path: '.' }), { path: '.', type: 'folder' })
    assert.deepEqual(await rig.call('stat', { path: 'nope/x.txt' }), { path: 'nope/x.txt', type: 'missing' })
    assert.deepEqual(await rig.call('stat', { path: 'src/retry.ts/x' }), { path: 'src/retry.ts/x', type: 'missing' })
  })

  test('read returns the text, the hash of the bytes and the size', async t => {
    const root = folders(t)()
    tree(root)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const bytes = fs.readFileSync(path.join(root, 'src', 'retry.ts'))
    assert.deepEqual(await rig.call('read', { path: 'src/retry.ts' }), {
      path: 'src/retry.ts',
      content: bytes.toString('utf8'),
      hash: sha(bytes),
      encoding: 'utf-8',
      size: bytes.length,
    })
    assert.equal(codeOf(await rig.fail('read', { path: 'src' })), 'not-file')
    assert.equal(codeOf(await rig.fail('read', { path: '.' })), 'not-file')
    assert.equal(codeOf(await rig.fail('read', { path: 'src/none.ts' })), 'not-found')
    assert.equal(codeOf(await rig.fail('list', { path: 'README.md' })), 'not-folder')
  })

  test('search finds literal text by line and column, sorted, and does not enter skipped folders', async t => {
    const root = folders(t)()
    tree(root)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const hits = await rig.call('search', { query: 'maxAttempts' })
    assert.deepEqual(hits.matches, [
      { path: 'src/retry.ts', line: 1, column: 14, text: 'export const maxAttempts: 3' },
      { path: 'src/retry.ts', line: 2, column: 28, text: 'export const retry = () => maxAttempts' },
      { path: 'src/util/helpers.ts', line: 1, column: 12, text: '// helper: maxAttempts is used here' },
    ])
    assert.equal(hits.filesScanned, 4)
    assert.equal(hits.truncated, false)
    const caseless = await rig.call('search', { query: 'maxattempts', ignoreCase: true })
    assert.equal(caseless.matches.length, 4)
    assert.deepEqual(caseless.matches.at(-1), {
      path: 'src/util/helpers.ts',
      line: 1,
      column: 12,
      text: '// helper: maxAttempts is used here',
    })
    assert.equal((await rig.call('search', { query: 'maxattempts' })).matches.length, 0)
    // The path names a skipped folder, so it is entered.
    assert.deepEqual(
      (await rig.call('search', { query: 'maxAttempts', path: 'node_modules' })).matches.map(
        (m: { path: string }) => m.path,
      ),
      ['node_modules/pkg/index.js'],
    )
    assert.equal((await rig.call('search', { query: 'maxAttempts', path: 'node_modules/pkg' })).matches.length, 1)
    // include narrows, and a regular expression is plain text.
    assert.equal((await rig.call('search', { query: 'maxAttempts', include: ['src/util/**'] })).matches.length, 1)
    assert.equal((await rig.call('search', { query: 'max.ttempts' })).matches.length, 0)
  })

  test('the skip list of the config replaces the default one', async t => {
    const root = folders(t)()
    tree(root)
    const rig = await rigOf(t, root, { skip: ['src'] })
    if (rig === undefined) return
    const paths = (await rig.call('search', { query: 'maxAttempts' })).matches.map((m: { path: string }) => m.path)
    assert.deepEqual(paths, ['dist/out.js', 'node_modules/pkg/index.js'])
  })

  test('search skips a binary file, a file over 1 MiB and invalid UTF-8, counts them, and cuts a long line', async t => {
    const root = folders(t)()
    const long = 'x'.repeat(1000)
    write(root, {
      'a.txt': `needle ${long}\n`,
      'bin.dat': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1]),
      'big.txt': `needle${'y'.repeat(LIMITS.searchFileBytes)}`,
      'bad.txt': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xff, 0xfe]),
    })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const r = await rig.call('search', { query: 'needle' })
    assert.equal(r.matches.length, 1)
    assert.equal(r.matches[0].text.length, LIMITS.lineChars)
    assert.equal(r.matches[0].column, 1)
    assert.equal(r.filesScanned, 1)
    assert.equal(r.skipped, 3)
  })

  test('search stops at maxMatches, and the limits of the files and the entries set truncated', async t => {
    const root = folders(t)()
    write(
      root,
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, 'hit\nhit\n'])),
    )
    const rig = await rigOf(t, root, { limits: { searchFiles: 5, listEntries: 7 } })
    if (rig === undefined) return
    const few = await rig.call('search', { query: 'hit', maxMatches: 3 })
    assert.equal(few.matches.length, 3)
    assert.equal(few.truncated, true)
    const files = await rig.call('search', { query: 'hit' })
    assert.equal(files.filesScanned, 5)
    assert.equal(files.truncated, true)
    // The volume orders a cut folder, so the 5 files are some 5 of the 12.
    const hit = [...new Set(files.matches.map((m: { path: string }) => m.path))]
    assert.equal(hit.length, 5)
    assert.deepEqual(hit, [...hit].sort())
    for (const p of hit) assert.match(p, /^f\d\d\.txt$/)
    // `list` visits at most as many names as `search` (here 5), so a larger visit limit shows the limit of the entries.
    const wide = await rigOf(t, root, { limits: { searchFiles: 50, listEntries: 7 } })
    if (wide === undefined) return
    const entries = await wide.call('list')
    assert.equal(entries.entries.length, 7)
    assert.equal(entries.truncated, true)
    const visits = await rig.call('list')
    assert.equal(visits.entries.length, 5)
    assert.equal(visits.truncated, true)
  })

  test('an include that matches nothing, or a tree of folders only, still ends at the limit of names or of time', async t => {
    const root = folders(t)()
    write(root, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`d${String(i).padStart(2, '0')}/keep`, ''])))
    write(root, { 'a.txt': 'hit' })
    const few = await rigOf(t, root, { limits: { searchFiles: 10 } })
    if (few === undefined) return
    // Before: an include with no match never reached the check, and a walk of folders only had no file to count.
    const none = await few.call('search', { query: 'hit', include: ['**/*.nomatch'] })
    assert.deepEqual([none.matches.length, none.truncated], [0, true])
    const folders10 = await few.call('search', { query: 'hit', path: 'd00' })
    assert.equal(folders10.truncated, false, 'a small folder ends by itself')
    const listing = await few.call('list', { depth: 2, include: ['**/*.nomatch'] })
    assert.deepEqual([listing.entries.length, listing.truncated], [0, true])
    // The time limit is checked at each name, so a slow volume ends the walk with no file in it.
    let slow = false
    const timed = await rigOf(t, root, { limits: { searchMs: 20 }, hook: async () => void (slow && (await sleep(8))) })
    if (timed === undefined) return
    slow = true
    const late = await timed.call('search', { query: 'hit', include: ['**/*.nomatch'] })
    assert.deepEqual([late.matches.length, late.truncated], [0, true])
  })

  test('the real spelling comes back on a volume that ignores case', { skip: !win && !mac }, async t => {
    const root = folders(t)()
    write(root, { 'src/Retry.ts': 'x' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.equal((await rig.call('read', { path: 'SRC/retry.TS' })).path, 'src/Retry.ts')
    assert.equal((await rig.call('stat', { path: 'SRC/retry.TS' })).path, 'src/Retry.ts')
  })
})

describe('the text of a path', () => {
  test('a bad path is refused with bad-path before any file system call', async t => {
    const root = folders(t)()
    write(root, { 'a/b.txt': 'x' })
    let lookups = 0
    const rig = await rigOf(t, root, { hook: () => void lookups++ })
    if (rig === undefined) return
    lookups = 0 // the start of the server looked at the root, which is no lookup of a path
    const bad = [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'C:x',
      '//server/share/x',
      'a\\b',
      'a\u0000b',
      'a//b',
      './a',
      Array.from({ length: 65 }, () => 'a').join('/'),
    ]
    for (const tool of ['read', 'stat', 'list', 'search'])
      for (const text of bad) {
        const args = tool === 'search' ? { query: 'x', path: text } : { path: text }
        assert.equal(codeOf(await rig.fail(tool, args)), 'bad-path', `${tool} ${JSON.stringify(text.slice(0, 20))}`)
      }
    assert.equal(lookups, 0)
    if (win)
      for (const text of ['f.txt::$DATA', 'f.txt:s', 'f.txt.', 'f.txt ', 'NUL', 'CON.txt'])
        assert.equal(codeOf(await rig.fail('read', { path: text })), 'bad-path', text)
    assert.equal(lookups, 0)
    assert.equal(codeOf(await rig.fail('read', { path: 'a/b.txt', extra: 1 } as never)), 'bad-input')
  })
})

describe('links', () => {
  /** A tree with a secret outside the root, and the links to it. `made` names the links that this system made. */
  const linked = (root: string, outside: string) => {
    const secret = marker()
    write(outside, { 'secret.txt': secret, 'deeper/more.txt': secret })
    write(root, { 'inside/f.txt': 'inside file', 'real.txt': 'a real file' })
    const made = {
      file: trySymlink(path.join(outside, 'secret.txt'), path.join(root, 'lnk-file'), 'file'),
      dir: trySymlink(outside, path.join(root, 'lnk-dir'), win ? 'junction' : 'dir'),
      inside: trySymlink(path.join(root, 'inside'), path.join(root, 'lnk-in'), win ? 'junction' : 'dir'),
    }
    return { secret, made }
  }

  test('read and stat through a link are refused, list shows the link and enters nothing, search reads nothing behind it', async t => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const { secret, made } = linked(root, outside)
    assert.ok(made.dir && made.inside, 'a directory link (a junction on Windows) is always possible')
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const seen: string[] = []
    const refuse = async (tool: string, p: string) => {
      const message = await rig.fail(tool, { path: p })
      seen.push(message)
      assert.equal(codeOf(message), 'link', `${tool} ${p}`)
    }
    await refuse('read', 'lnk-dir/secret.txt')
    await refuse('stat', 'lnk-dir')
    await refuse('stat', 'lnk-dir/secret.txt')
    await refuse('list', 'lnk-dir')
    await refuse('read', 'lnk-in/f.txt')
    await refuse('stat', 'lnk-in')
    await refuse('list', 'lnk-in')
    assert.equal(codeOf(await rig.fail('search', { query: 'x', path: 'lnk-dir' })), 'link')
    if (made.file) {
      await refuse('read', 'lnk-file')
      await refuse('stat', 'lnk-file')
    } else t.diagnostic('this system refuses to make a file symlink: those cases did not run')
    const top = await rig.call('list', { depth: 3 })
    const byPath = Object.fromEntries(top.entries.map((e: { path: string; type: string }) => [e.path, e.type]))
    assert.equal(byPath['lnk-dir'], 'link')
    assert.equal(byPath['lnk-in'], 'link')
    assert.equal(byPath['real.txt'], 'file')
    assert.equal(byPath['inside/f.txt'], 'file')
    assert.ok(
      !Object.keys(byPath).some(p => p.startsWith('lnk-dir/') || p.startsWith('lnk-in/')),
      'nothing below a link',
    )
    const hits = await rig.call('search', { query: secret })
    assert.deepEqual(hits.matches, [])
    const all = JSON.stringify([top, hits, seen, await rig.call('search', { query: 'file' })])
    assert.ok(!all.includes(secret), 'no byte of the secret is in a result')
  })

  test('a junction to a folder outside is refused (Windows)', { skip: !win }, async t => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(outside, { 'secret.txt': secret })
    fs.symlinkSync(outside, path.join(root, 'junc'), 'junction')
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.equal(codeOf(await rig.fail('read', { path: 'junc/secret.txt' })), 'link')
    assert.equal(codeOf(await rig.fail('stat', { path: 'junc' })), 'link')
    assert.equal((await rig.call('list')).entries.find((e: { path: string }) => e.path === 'junc').type, 'link')
    assert.deepEqual((await rig.call('search', { query: secret })).matches, [])
  })

  test('a hard link to a file outside is refused by read and skipped by search', async t => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(outside, { 'secret.txt': secret })
    write(root, { 'plain.txt': 'plain' })
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const message = await rig.fail('read', { path: 'hard.txt' })
    assert.equal(codeOf(message), 'hard-link')
    assert.ok(!message.includes(secret))
    const hits = await rig.call('search', { query: secret })
    assert.deepEqual(hits.matches, [])
    assert.equal(hits.skipped, 1)
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), secret, 'no file on disk changed')
  })
})

describe('exclusions', () => {
  const sensitive: Record<string, string> = {
    '.git/config': 'git',
    '.git/hooks/pre-commit': 'hook',
    '.env': 'env',
    '.env.local': 'env',
    'sub/.env.production': 'env',
    id_rsa: 'key',
    'sub/key.pem': 'key',
    '.claude/settings.json': 'settings',
    '.mcp.json': 'mcp',
    '.vscode/tasks.json': 'tasks',
    'fixtures/secrets/a.txt': 'user',
    'data/app.sqlite': 'user',
  }

  test('each sensitive path is refused as excluded, and no list or search shows a name or byte of it', async t => {
    const root = folders(t)()
    const secret = marker()
    write(root, { 'ok.txt': 'fine', 'src/main.ts': 'code' })
    write(root, Object.fromEntries(Object.keys(sensitive).map(name => [name, secret])))
    const rig = await rigOf(t, root, { exclude: ['fixtures/secrets/**', '*.sqlite'] })
    if (rig === undefined) return
    for (const name of Object.keys(sensitive))
      for (const tool of ['read', 'stat'])
        assert.equal(codeOf(await rig.fail(tool, { path: name })), 'excluded', `${tool} ${name}`)
    for (const folder of ['.git', '.claude', '.vscode', 'fixtures/secrets', '.git/hooks'])
      assert.equal(codeOf(await rig.fail('list', { path: folder })), 'excluded', `list ${folder}`)
    assert.equal(codeOf(await rig.fail('search', { query: 'x', path: '.git' })), 'excluded')
    const everything = await rig.call('list', { depth: 8 })
    assert.deepEqual(
      everything.entries.map((e: { path: string }) => e.path),
      ['data', 'fixtures', 'ok.txt', 'src', 'src/main.ts', 'sub'],
    )
    const hits = await rig.call('search', { query: secret })
    assert.deepEqual(hits.matches, [])
    assert.ok(!JSON.stringify([everything, hits]).includes(secret))
  })

  test('the config file of the session is excluded by its real path, wherever it is in the root', async t => {
    const root = folders(t)()
    const home = folders(t)()
    const secret = marker()
    fs.writeFileSync(path.join(root, 'toolscript.json'), secret)
    const { bindWorkspace } = await import('../src/host/workspace/bind.ts')
    const binding = await bindWorkspace({
      workspace: { roots: [{ path: root, write: false }], exclude: [], skip: [] },
      start: root,
      home,
      configFile: path.join(root, 'toolscript.json'),
      log: () => {},
    })
    if (!binding.ok) {
      assert.ok(mac, binding.reason)
      return
    }
    t.after(() => binding.bound.provider.close())
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const client = new Client({ name: 't', version: '0' })
    await client.connect(await binding.bound.provider.serve())
    t.after(() => client.close())
    const r = await client.callTool({ name: 'read', arguments: { path: 'toolscript.json' } })
    assert.equal(r.isError, true)
    assert.match(JSON.stringify(r.content), /excluded/)
    assert.ok(!JSON.stringify(r).includes(secret))
    const listed = await client.callTool({ name: 'list', arguments: {} })
    assert.deepEqual((listed.structuredContent as { entries: unknown[] }).entries, [])
  })

  test('a case variant, an NFD spelling and, on Linux, a separate file of another case are excluded', async t => {
    const root = folders(t)()
    const secret = marker()
    write(root, { '.env': secret, 'café.txt': secret, 'plain.txt': 'ok' })
    if (!win && !mac) write(root, { '.ENV': secret })
    const rig = await rigOf(t, root, { exclude: ['café.txt'] })
    if (rig === undefined) return
    for (const name of ['.ENV', '.Env', '.env', 'cafe\u0301.txt', 'CAFÉ.TXT'])
      assert.equal(codeOf(await rig.fail('read', { path: name })), 'excluded', name)
    assert.deepEqual(
      (await rig.call('list')).entries.map((e: { path: string }) => e.path),
      ['plain.txt'],
    )
  })

  test(
    'a short name of an excluded file is refused (Windows, where the volume has short names)',
    { skip: !win },
    async t => {
      const root = folders(t)()
      const secret = marker()
      write(root, { '.env': secret, '.git/x': secret, 'a long file name.txt': 'x' })
      const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a', root], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const short = (name: string) => {
        const words = listing
          .split(/\r?\n/)
          .find(line => line.trimEnd().endsWith(` ${name}`))
          ?.trim()
          .split(/\s+/)
        const candidate = words?.at(-2)
        return candidate?.includes('~') ? candidate : undefined
      }
      const alias = short('.env')
      if (alias === undefined) return void t.skip('the volume has no short names')
      const rig = await rigOf(t, root)
      if (rig === undefined) return
      assert.equal(codeOf(await rig.fail('read', { path: alias })), 'excluded')
      assert.equal(codeOf(await rig.fail('stat', { path: alias })), 'excluded')
      const folderAlias = short('.git')
      if (folderAlias !== undefined) {
        for (const tool of ['list', 'stat'])
          assert.equal(codeOf(await rig.fail(tool, { path: folderAlias })), 'excluded', tool)
        assert.equal(codeOf(await rig.fail('read', { path: `${folderAlias}/x` })), 'excluded')
        assert.equal(codeOf(await rig.fail('search', { query: 'x', path: folderAlias })), 'excluded')
      } else t.diagnostic('the folder .git has no short name on this volume')
      const other = short('a long file name.txt')
      if (other !== undefined) assert.equal((await rig.call('read', { path: other })).path, 'a long file name.txt')
    },
  )
})

describe('the bytes that one read takes', () => {
  /** A provider over `root` whose handles lie about their size (10 bytes) and count what they read. */
  const lying = async (t: TestContext, root: string) => {
    const confined = await openConfined(root)
    t.after(() => confined.close())
    const counted = { read: 0, readFile: 0 }
    const wrapHandle = (handle: FileHandle): FileHandle =>
      new Proxy(handle, {
        get: (target, prop) => {
          if (prop === 'readFile')
            return (...args: unknown[]) => (
              counted.readFile++,
              (target.readFile as (...a: unknown[]) => unknown)(...args)
            )
          if (prop === 'read')
            return async (...args: unknown[]) => {
              const r = (await (target.read as (...a: unknown[]) => Promise<{ bytesRead: number }>)(...args)) as {
                bytesRead: number
              }
              counted.read += r.bytesRead
              return r
            }
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    const wrapFile = async (opened: Opened): Promise<Opened> => ({
      ...opened,
      handle: wrapHandle(opened.handle),
      size: 10,
    })
    const wrapDir = (dir: Dir): Dir => ({
      ...dir,
      openFile: async name => wrapFile(await dir.openFile(name)),
      openDir: async name => wrapDir(await dir.openDir(name)),
    })
    const lies: Confined = {
      ...confined,
      root: async () => wrapDir(await confined.root()),
      dir: async parts => wrapDir(await confined.dir(parts)),
      file: async parts => wrapFile(await confined.file(parts)),
    }
    const provider = createProvider({
      confined: lies,
      excluded: makeExcluder(root, [], []),
      skip: DEFAULT_SKIP,
      windows: win,
      log: () => {},
    })
    const client = new Client({ name: 'workspace-test', version: '0' })
    await client.connect(await provider.serve())
    t.after(async () => {
      await client.close()
      await provider.close()
    })
    return { client, counted }
  }

  test('read and search take at most one byte over the limit through the handle, whatever the size said', async t => {
    const root = folders(t)()
    write(root, {
      'big.txt': Buffer.alloc(LIMITS.readBytes + 4000, 0x61),
      'search/big.txt': Buffer.alloc(LIMITS.searchFileBytes + 4000, 0x61),
    })
    const rig = await lying(t, root).catch(err => (mac ? undefined : Promise.reject(err)))
    if (rig === undefined) return void t.skip('Workspace is unavailable on macOS')
    const read = await rig.client.callTool({ name: 'read', arguments: { path: 'big.txt' } })
    assert.equal(read.isError, true)
    assert.equal(codeOf((read.content as { text: string }[])[0]!.text), 'too-large')
    // Before: the whole file was read to its end (readFile) and checked after.
    assert.equal(rig.counted.readFile, 0, 'no read to the end of the file')
    assert.equal(rig.counted.read, LIMITS.readBytes + 1)
    rig.counted.read = 0
    const search = await rig.client.callTool({ name: 'search', arguments: { query: 'a', path: 'search' } })
    assert.equal(search.isError, undefined)
    assert.deepEqual(
      [(search.structuredContent as any).matches.length, (search.structuredContent as any).skipped],
      [0, 1],
    )
    assert.equal(rig.counted.readFile, 0)
    assert.equal(rig.counted.read, LIMITS.searchFileBytes + 1)
  })

  test('readCapped returns a file of exactly the limit, refuses one byte more, and ends at the end of a short file', async t => {
    const root = folders(t)()
    write(root, { 'exact.txt': Buffer.alloc(1000, 0x62), 'more.txt': Buffer.alloc(1001, 0x62), 'empty.txt': '' })
    for (const [name, max, want] of [
      ['exact.txt', 1000, 1000],
      ['more.txt', 1000, undefined],
      ['empty.txt', 1000, 0],
      ['exact.txt', 300 * 1024, 1000],
    ] as const) {
      const handle = await fs.promises.open(path.join(root, name), 'r')
      try {
        assert.equal((await readCapped(handle, max))?.length, want, `${name} with ${max}`)
      } finally {
        await handle.close()
      }
    }
  })
})

describe('the root of a Linux server', { skip: process.platform !== 'linux' }, () => {
  /** Swaps `root` for a link to `outside`, and back. The real folder is kept at `root.real`. */
  const rootSwap = (root: string, outside: string) => {
    let out = false
    return (want: boolean) => {
      if (want === out) return
      if (want) {
        fs.renameSync(root, `${root}.real`)
        fs.symlinkSync(outside, root, 'dir')
      } else {
        fs.unlinkSync(root)
        fs.renameSync(`${root}.real`, root)
      }
      out = want
    }
  }

  const attempt = async (t: TestContext, pattern: (lookup: string, at: number) => boolean | undefined) => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(root, { 'f.txt': 'inside' })
    write(outside, { 'f.txt': secret })
    const swap = rootSwap(root, outside)
    t.after(() => {
      try {
        swap(false)
      } catch {
        // `folders` removed the folders first.
      }
      rm(`${root}.real`)
    })
    let at = 0
    const result = await openConfined(root, {
      hook: lookup => {
        const want = pattern(lookup, at++)
        if (want !== undefined) swap(want)
      },
    }).then(
      async confined => {
        const read = await confined.file(['f.txt']).then(
          async o => (await o.handle.readFile('utf8').finally(() => o.handle.close())) as string,
          (err: Error) => `refused: ${err.message}`,
        )
        await confined.close()
        return { opened: true as const, read }
      },
      (err: Error) => ({ opened: false as const, error: err.message }),
    )
    return { result, secret }
  }

  test('a root that is swapped for a link before the open, or swapped for one and back around it, fails closed', async t => {
    // Out at the open and still out at the check of the path: the path is a link.
    const link = await attempt(t, lookup => (lookup === 'open' ? true : undefined))
    assert.equal(link.result.opened, false)
    assert.match((link.result as { error: string }).error, /^root-changed:/)
    // Out at the open, back in before the check: the held folder is the outside one and the path is not.
    // Before: the root was checked by its path first and opened after, and nothing compared the held folder.
    const back = await attempt(t, lookup => (lookup === 'open' ? true : lookup === 'lstat' ? false : undefined))
    assert.equal(back.result.opened, false)
    assert.match((back.result as { error: string }).error, /^root-changed:/)
    assert.ok(!JSON.stringify(back.result).includes(back.secret))
    // In at the open, out at the check: the path is a link, so the server does not start.
    const late = await attempt(t, lookup => (lookup === 'lstat' ? true : undefined))
    assert.equal(late.result.opened, false)
    // No swap: it opens and reads the inside file.
    const plain = await attempt(t, () => undefined)
    assert.deepEqual(plain.result, { opened: true, read: 'inside' })
  })
})

describe('content', () => {
  test('refuses a file over 4 MiB, a NUL byte, invalid UTF-8 and UTF-16, and reads a file of exactly 4 MiB', async t => {
    const root = folders(t)()
    write(root, {
      'big.txt': Buffer.alloc(5 * 1024 * 1024, 0x61),
      'limit.txt': Buffer.alloc(LIMITS.readBytes, 0x61),
      'has-nul.txt': Buffer.from('ab\u0000cd'),
      'bad.txt': Buffer.from([0x61, 0xc3, 0x28]),
      'utf16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]),
    })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.equal(codeOf(await rig.fail('read', { path: 'big.txt' })), 'too-large')
    assert.equal(codeOf(await rig.fail('read', { path: 'has-nul.txt' })), 'binary')
    assert.equal(codeOf(await rig.fail('read', { path: 'utf16.txt' })), 'binary')
    assert.equal(codeOf(await rig.fail('read', { path: 'bad.txt' })), 'encoding')
    const limit = await rig.call('read', { path: 'limit.txt' })
    assert.equal(limit.size, LIMITS.readBytes)
    assert.equal(limit.content.length, LIMITS.readBytes)
  })

  test('content and hash match the bytes on disk for a CRLF file and a file with a byte order mark', async t => {
    const root = folders(t)()
    const crlf = Buffer.from('one\r\ntwo\r\n\r\nthree')
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\n')])
    write(root, { 'crlf.txt': crlf, 'bom.txt': bom, 'empty.txt': '' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const a = await rig.call('read', { path: 'crlf.txt' })
    assert.deepEqual(Buffer.from(a.content), crlf)
    assert.equal(a.hash, sha(crlf))
    assert.equal(a.encoding, 'utf-8')
    const b = await rig.call('read', { path: 'bom.txt' })
    assert.deepEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(b.content)]), bom)
    assert.equal(b.hash, sha(bom))
    assert.equal(b.encoding, 'utf-8-bom')
    assert.equal(b.size, bom.length)
    const e = await rig.call('read', { path: 'empty.txt' })
    assert.equal(e.content, '')
    assert.equal(e.hash, sha(new Uint8Array()))
    const lines = await rig.call('search', { query: 'two' })
    assert.deepEqual(lines.matches, [{ path: 'crlf.txt', line: 2, column: 1, text: 'two' }])
  })
})

describe('a swap of a folder while a file is read, a folder is listed or a path is looked at', () => {
  /** Swaps `root/b` between a real folder (in) and a link to the folder outside (out). */
  const swapper = (root: string, outside: string) => {
    const b = path.join(root, 'b')
    let out = false
    return {
      set: (want: boolean) => {
        if (want === out) return
        if (want) {
          fs.renameSync(b, `${b}.real`)
          fs.symlinkSync(outside, b, win ? 'junction' : 'dir')
        } else {
          if (win) fs.rmdirSync(b)
          else fs.unlinkSync(b)
          fs.renameSync(`${b}.real`, b)
        }
        out = want
      },
      reset: () => {
        try {
          if (out) {
            if (win) fs.rmdirSync(b)
            else fs.unlinkSync(b)
            fs.renameSync(`${b}.real`, b)
          }
        } finally {
          out = false
        }
      },
    }
  }

  const setup = (t: TestContext, nested = false) => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    // The outside folder has a file of the same name with other bytes, and a file whose name is the secret.
    // A nested probe looks at `b/c`, so `b` is a middle part of the path: the same files sit in `c` of each.
    const at = nested ? 'c/' : ''
    write(root, { [`b/${at}id.txt`]: 'inside file' })
    write(outside, { [`${at}id.txt`]: `outside ${secret}`, [`${at}${secret}.txt`]: 'x'.repeat(777) })
    return { root, outside, secret, swap: swapper(root, outside) }
  }

  /** A tool call, what an inside result looks like, and which lookups of it a sweep may vary. */
  type Probe = {
    /** True when the probe looks at `b/c`, a folder under the swapped one. */
    readonly nested?: boolean
    readonly tool: string
    readonly args: Record<string, unknown>
    /** True when the structured result shows nothing but the inside file. */
    readonly safe: (result: any) => boolean
    /**
     * The ranges `[from, to)` of lookups over which a sweep tries every pattern, given the lookups of one call and the
     * index `cut` of the first lookup that is not the proof of the folder `b`.
     */
    /** When set, a sweep varies only these lookups (at most 9), and the others stay inside. */
    readonly free?: (lookups: readonly string[]) => number[]
    readonly windows: (lookups: readonly string[], cut: number) => [number, number][]
    /** The leaking patterns that the ADR names for this call and system, as a test of the mask. */
    readonly known: (mask: number, lookups: readonly string[]) => boolean
  }

  /**
   * The family of Windows and macOS for a folder that is listed or looked at (see `makeDir`): each lookup that is
   * outside has a lookup that is inside right before it and right after it (the proofs of the folder), so the swap
   * alternates and the last lookup is inside. The first lookup, which stats the root, is free.
   */
  const alternating = (mask: number, lookups: readonly string[]): boolean =>
    lookups.every((_, i) => {
      const bit = (k: number) => (mask >> k) & 1
      return i === 0 || bit(i) === 0 || ((i === 1 || bit(i - 1) === 0) && i < lookups.length - 1 && bit(i + 1) === 0)
    })

  const inside = { path: 'b/id.txt', type: 'file', size: 'inside file'.length }
  const insideNested = { ...inside, path: 'b/c/id.txt' }
  /**
   * The family of Windows for a folder that is a middle part of the path (`b` of `b/c`): the proof of `b/c` (open,
   * then `realpath` and `lstat` two times) falls into the read family, because the `lstat` of `b/c` does not see a
   * junction at `b`, and the folder then holds the outside id. Every lookup after the proof may be any. The alternating
   * family of a flat folder holds too, and so does the first lookup, which stats the root.
   */
  const nestedKnown = (mask: number, lookups: readonly string[]): boolean => {
    if (alternating(mask, lookups)) return win || mac
    if (!win) return false
    const from = lookups.indexOf('open')
    return lookups.every((_, i) => i < from || i >= from + 5 || ((mask >> i) & 1) === ((i - from) % 2 === 0 ? 1 : 0))
  }
  /**
   * The lookups of a nested call that a sweep varies, at most 9 (512 patterns), in one range of the mask space: all but
   * the check of the root (the root is not the swapped folder), the `lstat` of `b/c` after the proof, and the lookups
   * after the first 10 (the `lstat` of the entry after the first one). The others stay inside.
   */
  const nestedFree = (lookups: readonly string[]): number[] =>
    lookups.map((_, i) => i).filter(i => i >= 1 && i !== 6 && i < 11)
  const probes: Record<'read' | 'list' | 'stat' | 'listNested' | 'statNested', Probe> = {
    read: {
      tool: 'read',
      args: { path: 'b/id.txt' },
      safe: r => r.content === 'inside file',
      windows: lookups => [[0, lookups.length]],
      // The case that the ADR names for Windows: out at the open, then in and out in turn.
      known: (mask, lookups) => {
        if (!win) return false
        const from = lookups.indexOf('open')
        return lookups.every((_, i) => i < from || ((mask >> i) & 1) === ((i - from) % 2 === 0 ? 1 : 0))
      },
    },
    list: {
      tool: 'list',
      args: { path: 'b' },
      safe: r => r.entries.every((e: unknown) => JSON.stringify(e) === JSON.stringify(inside)),
      // The proof of the folder alone, then the enumeration alone (the proof of the folder is the code of every tool).
      windows: (lookups, cut) => [
        [0, cut],
        [cut, lookups.length],
      ],
      known: (mask, lookups) => (win || mac) && alternating(mask, lookups),
    },
    stat: {
      tool: 'stat',
      args: { path: 'b/id.txt' },
      safe: r => r.type === 'missing' || JSON.stringify(r) === JSON.stringify(inside),
      windows: (lookups, cut) => [
        [0, cut],
        [cut, lookups.length],
      ],
      known: (mask, lookups) => (win || mac) && alternating(mask, lookups),
    },
    // One range over the proof and the lookups after it, so that a pattern of the proof followed by any other is tried.
    listNested: {
      nested: true,
      tool: 'list',
      args: { path: 'b/c' },
      safe: r => r.entries.every((e: unknown) => JSON.stringify(e) === JSON.stringify(insideNested)),
      windows: lookups => [[0, lookups.length]],
      free: nestedFree,
      known: nestedKnown,
    },
    statNested: {
      nested: true,
      tool: 'stat',
      args: { path: 'b/c/id.txt' },
      safe: r => r.type === 'missing' || JSON.stringify(r) === JSON.stringify(insideNested),
      windows: lookups => [[0, lookups.length]],
      free: nestedFree,
      known: nestedKnown,
    },
  }

  /**
   * Every pattern of in and out over the lookups of one call of `probe`. The call must refuse, or show only the inside
   * file. A pattern that shows more is a leak: only the patterns that `probe.known` names (the ADR, section What stays
   * possible) may leak, and no other may. Returns the leaking patterns.
   */
  const sweep = async (t: TestContext, name: keyof typeof probes): Promise<number[]> => {
    const probe = probes[name]
    const { root, secret, swap } = setup(t, probe.nested)
    let hook: Hook = () => {}
    const rig = await rigOf(t, root, { hook: name => hook(name) })
    if (rig === undefined) return []
    const record = async (tool: string, args: Record<string, unknown>): Promise<string[]> => {
      const seen: string[] = []
      hook = lookup => void seen.push(lookup)
      const r = await rig.client.callTool({ name: tool, arguments: args })
      assert.ok(r.isError !== true, `${tool} failed with no swap: ${JSON.stringify(r.content)}`)
      assert.ok(probe.safe(r.structuredContent) || args !== probe.args, `${tool} with no swap: ${JSON.stringify(r)}`)
      return seen
    }
    const lookups = await record(probe.tool, probe.args)
    // The lookups of the proof of `b` alone: those of a listing before its first read of the names.
    const listed = await record('list', { path: probe.nested ? 'b/c' : 'b' })
    const cut = listed.indexOf('readdir') - (rig.bound.method === 'proc' ? 0 : 1)
    assert.ok(cut >= 1 && cut < lookups.length + 1, `the proof of a folder: ${listed.join(',')}`)
    assert.ok(lookups.length >= 2 && lookups.length <= 12, `the lookups of ${name}: ${lookups.join(',')}`)
    const leaks = new Set<number>()
    let impossible = 0
    let calls = 0
    for (const [from, to] of probe.windows(lookups, cut)) {
      const free = probe.free?.(lookups)
      assert.ok(free === undefined || free.length <= 9, `a nested sweep is at most 512 patterns: ${lookups.join(',')}`)
      for (let pattern = 0; pattern < 1 << (free?.length ?? to - from); pattern++) {
        const mask = free ? free.reduce((m, at, k) => m | (((pattern >> k) & 1) << at), 0) : pattern << from
        let at = 0
        let stuck = false
        hook = () => {
          const want = ((mask >> at++) & 1) === 1
          if (stuck) return
          try {
            swap.set(want)
          } catch (err) {
            // Windows: a folder above an open file cannot be renamed. A pattern that needs it cannot happen.
            assert.ok(
              win && ['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? ''),
              `swap failed: ${err}`,
            )
            stuck = true
          }
        }
        const r = await rig.client.callTool({ name: probe.tool, arguments: probe.args })
        swap.reset()
        calls++
        if (stuck) impossible++
        const leaked =
          JSON.stringify(r).includes(secret) ||
          (r.isError !== true
            ? !probe.safe(r.structuredContent)
            : !/^(link|not-found|not-folder|not-file|root-changed|io)$/.test(
                codeOf((r.content as { text: string }[])[0]!.text),
              ))
        if (leaked && !stuck) leaks.add(mask)
      }
    }
    t.diagnostic(
      `${name}: ${calls} calls over lookups ${lookups.join(',')}; patterns that show outside data: [${[...leaks]}]; patterns that cannot happen: ${impossible}`,
    )
    const unnamed = [...leaks].filter(mask => !probe.known(mask, lookups))
    assert.deepEqual(unnamed, [], `${name}: a pattern that the ADR does not name shows outside data`)
    return [...leaks]
  }

  test('every pattern of in and out over the lookups of one read refuses or reads the inside file', async t => {
    await sweep(t, 'read')
  })

  test('every pattern of in and out over the lookups of a listing refuses or lists only the inside entries', async t => {
    await sweep(t, 'list')
  })

  test('every pattern of in and out over the lookups of a stat refuses or shows only the inside file', async t => {
    await sweep(t, 'stat')
  })

  test('every pattern of in and out over the lookups of a listing of a nested folder refuses or lists only the inside entries', async t => {
    await sweep(t, 'listNested')
  })

  test('every pattern of in and out over the lookups of a stat of a nested file refuses or shows only the inside file', async t => {
    await sweep(t, 'statNested')
  })

  test('a loop that swaps the folder for at most 2 s while at most 300 reads, listings and stats run shows no outside byte', async t => {
    const { root, secret, swap } = setup(t)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const end = Date.now() + 2000
    let stop = false
    const flipper = (async () => {
      while (!stop && Date.now() < end) {
        try {
          swap.set(true)
          await new Promise(resolve => setImmediate(resolve))
          swap.set(false)
        } catch {
          // Windows can refuse a swap while a file is open.
        }
        await new Promise(resolve => setImmediate(resolve))
      }
    })()
    let reads = 0
    const outcomes = new Map<string, number>()
    const rotation = ['read', 'list', 'stat'] as const
    while (reads < 300 && Date.now() < end) {
      const probe = probes[rotation[reads % rotation.length]!]
      const r = await rig.client.callTool({ name: probe.tool, arguments: probe.args })
      assert.ok(!JSON.stringify(r).includes(secret), 'an outside byte')
      // On Windows and macOS a timed swap can still show outside names and metadata through list and stat: the family
      // that ADR 0144 names. Bytes of a file never. Linux shows nothing from outside.
      const metadataOnly = probe.tool !== 'read' && (process.platform === 'win32' || process.platform === 'darwin')
      if (r.isError !== true && !metadataOnly)
        assert.ok(probe.safe(r.structuredContent), `${probe.tool}: ${JSON.stringify(r)}`)
      const key = r.isError === true ? codeOf((r.content as { text: string }[])[0]!.text) : probe.tool
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
      reads++
    }
    stop = true
    await flipper
    swap.reset()
    t.diagnostic(`${reads} reads: ${JSON.stringify(Object.fromEntries(outcomes))}`)
  })
})

describe('the root and the session', () => {
  test('two servers in two folders under one approved parent each see only their own folder', async t => {
    const parent = folders(t)()
    write(parent, { 'a/only-a.txt': 'A', 'b/only-b.txt': 'B', 'shared.txt': 'parent file' })
    const a = await rigOf(t, parent, { roots: [parent], start: path.join(parent, 'a') })
    const b = await rigOf(t, parent, { roots: [parent], start: path.join(parent, 'b') })
    if (a === undefined || b === undefined) return
    assert.equal(a.bound.root, path.join(parent, 'a'))
    assert.deepEqual(
      (await a.call('list')).entries.map((e: { path: string }) => e.path),
      ['only-a.txt'],
    )
    assert.deepEqual(
      (await b.call('list')).entries.map((e: { path: string }) => e.path),
      ['only-b.txt'],
    )
    assert.equal((await a.call('read', { path: 'only-a.txt' })).content, 'A')
    assert.equal(codeOf(await a.fail('read', { path: 'only-b.txt' })), 'not-found')
    assert.equal(codeOf(await b.fail('read', { path: '../a/only-a.txt' })), 'bad-path')
    assert.equal(codeOf(await b.fail('read', { path: 'shared.txt' })), 'not-found')
    assert.deepEqual((await a.call('search', { query: 'B' })).matches, [])
  })

  test('with several entries and a start folder outside all of them, Workspace is unavailable and says what to do', async t => {
    const dirs = folders(t)
    const one = dirs()
    const two = dirs()
    const elsewhere = dirs()
    const opened = await open(one, { roots: [one, two], start: elsewhere })
    assert.ok('unavailable' in opened)
    assert.match((opened as { unavailable: string }).unavailable, /Start the client in one of them/)
    // One entry binds to its own path from any folder.
    const single = await rigOf(t, one, { roots: [one], start: elsewhere })
    if (single === undefined) return
    assert.equal(single.bound.root, one)
  })

  test('a refused root gives a reason that names the place and no path', async t => {
    const dirs = folders(t)
    const root = dirs()
    const home = dirs()
    const { bindWorkspace } = await import('../src/host/workspace/bind.ts')
    const attempt = (roots: string[], homeDir = home) =>
      bindWorkspace({
        workspace: { roots: roots.map(p => ({ path: p, write: false })), exclude: [], skip: [] },
        start: root,
        home: homeDir,
        configFile: path.join(home, 'c.json'),
        log: () => {},
      })
    const refused = async (roots: string[], pattern: RegExp, homeDir?: string) => {
      const r = await attempt(roots, homeDir)
      assert.equal(r.ok, false)
      const reason = r.ok ? '' : r.reason
      assert.match(reason, pattern)
      for (const p of roots) assert.ok(!reason.includes(p), 'the reason shows no path')
    }
    await refused([home], /home folder/, home)
    await refused([path.dirname(home)], /holds it|network|root/, home)
    await refused([path.parse(root).root], /file system root/)
    await refused([path.join(root, 'missing')], /not a folder that exists/)
    write(root, { '.git/x': '' })
    await refused([path.join(root, '.git')], /\.git/)
    // Another entry does not rescue a bad one: Workspace fails closed.
    const mixed = await attempt([root, home], home)
    assert.equal(mixed.ok, false)
  })

  test('a root that another folder replaced fails each call with root-changed', async t => {
    const root = folders(t)()
    write(root, { 'a.txt': 'x' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.equal((await rig.call('read', { path: 'a.txt' })).content, 'x')
    fs.renameSync(root, `${root}.old`)
    t.after(() => rm(`${root}.old`))
    fs.mkdirSync(root)
    write(root, { 'a.txt': 'replacement' })
    for (const [tool, args] of [
      ['read', { path: 'a.txt' }],
      ['list', {}],
      ['stat', { path: 'a.txt' }],
      ['search', { query: 'x' }],
    ] as const)
      assert.equal(codeOf(await rig.fail(tool, args)), 'root-changed', tool)
  })
})

describe('cancel', () => {
  test('a cancel during a long search ends the call within 1 s', async t => {
    const root = folders(t)()
    write(root, Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`dir${i % 6}/f${i}.txt`, 'no match here\n'])))
    let slow = false
    const rig = await rigOf(t, root, { hook: async () => void (slow && (await sleep(15))) })
    if (rig === undefined) return
    slow = true
    const abort = new AbortController()
    const running = rig.call('search', { query: 'zzz-not-found' }, abort.signal)
    running.catch(() => {})
    await sleep(150)
    assert.equal(rig.bound.provider.inFlight(), 1, 'the search is still running')
    const aborted = performance.now()
    abort.abort()
    await assert.rejects(running)
    while (rig.bound.provider.inFlight() > 0 && performance.now() - aborted < 1000) await sleep(10)
    assert.equal(rig.bound.provider.inFlight(), 0)
    assert.ok(performance.now() - aborted < 1000)
  })
})

// A volume that opens a file under a name that its folder does not list (a short name such as GIT~1, another case) needs
// a folder on vfat, exFAT, SMB or a 9p share of a Windows folder. CI mounts a vfat image and names it in the variable.
const aliasBase = process.env.TOOLSCRIPT_TEST_ALIAS_DIR
describe('names that the volume opens but does not list (Linux)', () => {
  const skipWhy =
    process.platform !== 'linux'
      ? 'Linux only'
      : aliasBase === undefined
        ? 'TOOLSCRIPT_TEST_ALIAS_DIR does not name a folder on a volume with short names'
        : false

  const fixture = (t: TestContext) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(aliasBase!, 'ws-alias-')))
    t.after(() => rm(root))
    const secret = marker()
    // The order of the writes decides the short names: each is the first of its kind.
    write(root, {
      '.git/config': secret,
      '.env': secret,
      '.ssh/known_hosts': secret,
      'a long file name.txt': 'long file bytes\n',
      'README.md': 'readme bytes\n',
    })
    const opens = (name: string) => {
      try {
        fs.closeSync(fs.openSync(path.join(root, name), 'r'))
        return true
      } catch {
        return false
      }
    }
    const missing = ['GIT~1/config', 'ENV~1', 'SSH~1/known_hosts', 'ALONGF~1.TXT'].filter(n => !opens(n))
    if (missing.length > 0) {
      t.skip(`this volume gives no short name for ${missing.join(', ')}`)
      return undefined
    }
    return { root, secret }
  }

  test('an alias of an excluded name is excluded, and no result holds its bytes', { skip: skipWhy }, async t => {
    const fx = fixture(t)
    if (fx === undefined) return
    const rig = await rigOf(t, fx.root, { write: true })
    if (rig === undefined) return
    const calls: [string, Record<string, unknown>][] = [
      ['read', { path: 'GIT~1/config' }],
      ['list', { path: 'GIT~1' }],
      ['stat', { path: 'GIT~1' }],
      ['search', { query: 'SECRET', path: 'GIT~1' }],
      ['read', { path: 'ENV~1' }],
      ['stat', { path: 'ENV~1' }],
      ['diff', { path: 'ENV~1', content: 'x' }],
      ['diff', { path: 'ENV~1', expectedHash: sha(Buffer.from(fx.secret)), content: 'x' }],
      ['read', { path: 'SSH~1/known_hosts' }],
      ['write', { path: 'GIT~1/new.txt', content: 'x' }],
      ['edit', { path: 'ENV~1', expectedHash: sha(Buffer.from(fx.secret)), edits: [{ old: 'SECRET', new: 'x' }] }],
    ]
    for (const [tool, args] of calls) {
      const message = await rig.fail(tool, args)
      assert.equal(codeOf(message), 'excluded', `${tool} ${JSON.stringify(args)}`)
      assert.ok(!message.includes(fx.secret), `${tool} shows the bytes`)
    }
    assert.equal(fs.readFileSync(path.join(fx.root, '.env'), 'utf8'), fx.secret)
    assert.deepEqual(fs.readdirSync(path.join(fx.root, '.git')), ['config'])
  })

  test(
    'an alias of a file that is not excluded works, and the result has the listed name',
    { skip: skipWhy },
    async t => {
      const fx = fixture(t)
      if (fx === undefined) return
      const rig = await rigOf(t, fx.root)
      if (rig === undefined) return
      const read = await rig.call('read', { path: 'ALONGF~1.TXT' })
      assert.equal(read.path, 'a long file name.txt')
      assert.match(read.content, /long file bytes/)
      assert.deepEqual(await rig.call('stat', { path: 'readme.md' }), { path: 'README.md', type: 'file', size: 13 })
    },
  )
})
