// The change tools of the Workspace (issue #144, pull request B), on real temp trees: diff, edit and write. Each fixture
// checks bytes, hashes and names on disk, never a success text. A fixture is refused when the call fails with its code,
// no byte and no name from outside the root is in any result, and no file on disk changed.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LIMITS } from '../src/core/workspace.ts'
import type { Hook } from '../src/host/workspace/confined.ts'
import { codeOf, marker, open, rm, tempDir, trySymlink, write, type Rig, type RigOptions } from './workspace-rig.ts'

const win = process.platform === 'win32'
const mac = process.platform === 'darwin'
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const ZERO = `sha256:${'0'.repeat(64)}`

const folders = (t: TestContext) => {
  const dirs: string[] = []
  t.after(() => dirs.forEach(rm))
  return (): string => {
    const dir = tempDir()
    dirs.push(dir)
    return dir
  }
}

/** A rig with the write grant, closed at the end of the test. macOS ships Workspace unavailable when its method test fails. */
const rigOf = async (t: TestContext, root: string, options: RigOptions = {}): Promise<Rig | undefined> => {
  const opened = await open(root, { write: true, ...options })
  if ('unavailable' in opened) {
    if (mac) return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** Every name and byte under `dir`, a link as a link: two snapshots are equal when nothing changed. */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const visit = (sub: string) => {
    for (const name of fs.readdirSync(path.join(dir, sub)).sort()) {
      const rel = sub === '' ? name : `${sub}/${name}`
      const st = fs.lstatSync(path.join(dir, rel))
      out[rel] = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : sha(fs.readFileSync(path.join(dir, rel)))
      if (st.isDirectory()) visit(rel)
    }
  }
  visit('')
  return out
}

const bytes = (root: string, name: string): Buffer => fs.readFileSync(path.join(root, name))
const edit1 = (old: string, now: string) => [{ old, new: now }]
const lockFiles = (rig: Rig): string[] => {
  const dir = path.join(rig.home, '.toolscript-mcp', 'locks')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.lock')) : []
}

describe('the tools that change files', () => {
  test('diff is listed with no write grant, edit and write only with it, and their handlers refuse without it', async t => {
    const root = folders(t)()
    write(root, { 'a.txt': 'x' })
    const readOnly = await rigOf(t, root, { write: false })
    const granted = await rigOf(t, root)
    if (readOnly === undefined || granted === undefined) return
    const names = async (rig: Rig) => (await rig.client.listTools()).tools.map(tool => tool.name)
    assert.deepEqual(await names(readOnly), ['list', 'search', 'read', 'stat', 'diff'])
    assert.deepEqual(await names(granted), ['list', 'search', 'read', 'stat', 'diff', 'edit', 'write'])
    const hints = Object.fromEntries(
      (await granted.client.listTools()).tools.map(tool => [tool.name, tool.annotations?.readOnlyHint]),
    )
    assert.deepEqual([hints.diff, hints.edit, hints.write], [true, false, false])
    const hash = sha(Buffer.from('x'))
    assert.equal(
      codeOf(await readOnly.fail('edit', { path: 'a.txt', expectedHash: hash, edits: edit1('x', 'y') })),
      'read-only',
    )
    assert.equal(codeOf(await readOnly.fail('write', { path: 'new.txt', content: 'y' })), 'read-only')
    assert.deepEqual(snapshot(root), { 'a.txt': hash }, 'nothing changed, and nothing was made')
    const preview = await readOnly.call('diff', { path: 'a.txt', expectedHash: hash, edits: edit1('x', 'y') })
    assert.deepEqual([preview.applied, preview.changed], [false, true])
  })

  test('diff changes no byte and no modified time, makes nothing, takes no lock, and gives the hash of the bytes an edit would write', async t => {
    const root = folders(t)()
    write(root, { 'a/f.txt': 'one\ntwo\nthree\n' })
    const file = path.join(root, 'a', 'f.txt')
    fs.utimesSync(file, new Date(1_000_000_000_000), new Date(1_000_000_000_000))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const before = { tree: snapshot(root), mtime: fs.statSync(file).mtimeMs }
    const read = await rig.call('read', { path: 'a/f.txt' })
    const expected = Buffer.from('one\nTWO\nthree\n')
    const edits = await rig.call('diff', { path: 'a/f.txt', expectedHash: read.hash, edits: edit1('two', 'TWO') })
    assert.deepEqual(
      [edits.applied, edits.created, edits.changed, edits.oldHash, edits.newHash],
      [false, false, true, read.hash, sha(expected)],
    )
    assert.equal(edits.diff, '--- a/a/f.txt\n+++ b/a/f.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n')
    assert.deepEqual([edits.added, edits.removed, edits.diffTruncated, edits.warnings], [1, 1, false, []])
    const whole = await rig.call('diff', { path: 'a/f.txt', expectedHash: read.hash, content: 'one\nTWO\nthree\n' })
    assert.equal(whole.newHash, sha(expected))
    const made = await rig.call('diff', { path: 'new/deep/g.txt', content: 'hello\n' })
    assert.deepEqual(
      [made.applied, made.created, made.changed, made.oldHash, made.newHash],
      [false, true, true, null, sha(Buffer.from('hello\n'))],
    )
    assert.equal(made.diff, '--- /dev/null\n+++ b/new/deep/g.txt\n@@ -0,0 +1,1 @@\n+hello\n')
    // The same preview without a hash, and with a wrong one: the wrong one is stale.
    assert.equal((await rig.call('diff', { path: 'a/f.txt', edits: edit1('two', 'TWO') })).newHash, sha(expected))
    assert.equal(
      codeOf(await rig.fail('diff', { path: 'a/f.txt', expectedHash: ZERO, edits: edit1('two', 'TWO') })),
      'stale',
    )
    assert.equal(codeOf(await rig.fail('diff', { path: 'a/f.txt', content: 'x' })), 'exists')
    assert.equal(codeOf(await rig.fail('diff', { path: 'missing.txt', edits: edit1('a', 'b') })), 'not-found')
    assert.deepEqual(snapshot(root), before.tree)
    assert.equal(fs.statSync(file).mtimeMs, before.mtime, 'the modified time')
    assert.equal(fs.existsSync(path.join(rig.home, '.toolscript-mcp')), false, 'no lock folder: diff takes no lock')
  })
})

describe('the hash check', () => {
  test('an old hash fails with stale and changes nothing, edit needs a hash, and write needs none for a new file', async t => {
    const root = folders(t)()
    write(root, { 'a.txt': 'alpha\n' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const read = await rig.call('read', { path: 'a.txt' })
    const before = snapshot(root)
    assert.equal(
      codeOf(await rig.fail('edit', { path: 'a.txt', expectedHash: ZERO, edits: edit1('alpha', 'beta') })),
      'stale',
    )
    assert.equal(codeOf(await rig.fail('edit', { path: 'a.txt', edits: edit1('alpha', 'beta') } as never)), 'bad-input')
    assert.equal(codeOf(await rig.fail('write', { path: 'a.txt', content: 'x' })), 'exists')
    assert.equal(codeOf(await rig.fail('write', { path: 'a.txt', content: 'x', expectedHash: ZERO })), 'stale')
    assert.equal(
      codeOf(await rig.fail('write', { path: 'missing.txt', content: 'x', expectedHash: read.hash })),
      'not-found',
    )
    assert.deepEqual(snapshot(root), before)
    // The file changes after the read: the hash of the read is stale.
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha changed elsewhere\n')
    assert.equal(
      codeOf(await rig.fail('edit', { path: 'a.txt', expectedHash: read.hash, edits: edit1('alpha', 'beta') })),
      'stale',
    )
    assert.equal(bytes(root, 'a.txt').toString(), 'alpha changed elsewhere\n')
    // A new file needs none, a replacement needs the hash.
    const made = await rig.call('write', { path: 'b.txt', content: 'bravo\n' })
    assert.deepEqual(
      [made.applied, made.created, made.oldHash, made.newHash],
      [true, true, null, sha(Buffer.from('bravo\n'))],
    )
    assert.deepEqual(bytes(root, 'b.txt'), Buffer.from('bravo\n'))
    const again = await rig.call('read', { path: 'b.txt' })
    const replaced = await rig.call('write', { path: 'b.txt', content: 'charlie\n', expectedHash: again.hash })
    assert.deepEqual([replaced.applied, replaced.created, replaced.oldHash], [true, false, again.hash])
    assert.deepEqual(bytes(root, 'b.txt'), Buffer.from('charlie\n'))
  })
})

describe('exact bytes', () => {
  test('after an edit the file differs from the old bytes only in the replaced ranges: LF, CRLF, mixed, a byte order mark, no final line end', async t => {
    const root = folders(t)()
    const fixtures: Record<string, Buffer> = {
      'lf.txt': Buffer.from('a\nb\nMID\nc\n'),
      'crlf.txt': Buffer.from('a\r\nb\r\nMID\r\nc\r\n'),
      'mixed.txt': Buffer.from('a\r\nb\nMID\r\nc\n'),
      'bom.txt': Buffer.concat([BOM, Buffer.from('a\nMID\n')]),
      'no-end.txt': Buffer.from('a\nMID'),
      'utf8.txt': Buffer.from('héllo wörld MID ünï\n'),
    }
    write(root, fixtures)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    for (const [name, old] of Object.entries(fixtures)) {
      const read = await rig.call('read', { path: name })
      const at = old.indexOf('MID')
      const expected = Buffer.concat([old.subarray(0, at), Buffer.from('X\nY'), old.subarray(at + 3)])
      const change = await rig.call('edit', { path: name, expectedHash: read.hash, edits: edit1('MID', 'X\nY') })
      assert.deepEqual(bytes(root, name), expected, name)
      assert.deepEqual(
        [change.path, change.applied, change.created, change.changed, change.oldHash, change.newHash],
        [name, true, false, true, read.hash, sha(expected)],
        name,
      )
    }
    assert.deepEqual(bytes(root, 'bom.txt').subarray(0, 3), BOM, 'the byte order mark stays')
    assert.ok(!(await rig.call('read', { path: 'bom.txt' })).content.startsWith('\uFEFF'))
  })

  test('a whole replacement keeps the byte order mark, writes the content as given, and a same-content write changes nothing', async t => {
    const root = folders(t)()
    write(root, { 'bom.txt': Buffer.concat([BOM, Buffer.from('old\r\n')]), 'same.txt': 'same\n' })
    const same = path.join(root, 'same.txt')
    fs.utimesSync(same, new Date(1_000_000_000_000), new Date(1_000_000_000_000))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const bom = await rig.call('read', { path: 'bom.txt' })
    const done = await rig.call('write', { path: 'bom.txt', content: 'new\r\nlines\n', expectedHash: bom.hash })
    assert.deepEqual(bytes(root, 'bom.txt'), Buffer.concat([BOM, Buffer.from('new\r\nlines\n')]))
    assert.equal(done.newHash, sha(bytes(root, 'bom.txt')))
    assert.deepEqual(done.warnings, ['The new text has LF line ends in a file that has CRLF line ends.'])
    const read = await rig.call('read', { path: 'same.txt' })
    const mtime = fs.statSync(same).mtimeMs
    const none = await rig.call('write', { path: 'same.txt', content: 'same\n', expectedHash: read.hash })
    assert.deepEqual(
      [none.applied, none.changed, none.oldHash, none.newHash, none.diff],
      [false, false, read.hash, read.hash, ''],
    )
    assert.equal(fs.statSync(same).mtimeMs, mtime, 'no write, so the modified time stays')
  })

  test('the mode of a file stays (not on Windows)', { skip: win }, async t => {
    const root = folders(t)()
    write(root, { 'run.sh': '#!/bin/sh\necho old\n', 'tool.sh': '#!/bin/sh\necho old\n' })
    for (const name of ['run.sh', 'tool.sh']) fs.chmodSync(path.join(root, name), 0o755)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const run = await rig.call('read', { path: 'run.sh' })
    await rig.call('edit', { path: 'run.sh', expectedHash: run.hash, edits: edit1('old', 'new') })
    const tool = await rig.call('read', { path: 'tool.sh' })
    await rig.call('write', { path: 'tool.sh', content: '#!/bin/sh\necho new\n', expectedHash: tool.hash })
    for (const name of ['run.sh', 'tool.sh']) {
      assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o755, name)
      assert.equal(bytes(root, name).toString(), '#!/bin/sh\necho new\n')
    }
  })

  test('a read-only file is refused by edit and write on every system, and nothing changes', async t => {
    // Root can write a read-only file on Linux and macOS, as it can with any other tool.
    if (!win && process.getuid?.() === 0) return void t.skip('the test runs as root')
    const root = folders(t)()
    const file = path.join(root, 'locked.txt')
    write(root, { 'locked.txt': 'old\n', 'plain.txt': 'old\n' })
    fs.chmodSync(file, 0o444)
    t.after(() => void (fs.existsSync(file) && fs.chmodSync(file, 0o644)))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const before = snapshot(root)
    const read = await rig.call('read', { path: 'locked.txt' })
    const calls = [
      ['edit', { path: 'locked.txt', expectedHash: read.hash, edits: edit1('old', 'new') }],
      ['write', { path: 'locked.txt', expectedHash: read.hash, content: 'new\n' }],
    ] as const
    for (const [tool, args] of calls) {
      const message = await rig.fail(tool, args)
      assert.equal(codeOf(message), 'io', `${tool}: ${message}`)
      assert.match(message, /\((EACCES|EPERM)\)/, tool)
    }
    assert.deepEqual(snapshot(root), before, 'no byte changed and no temp file is left')
    assert.equal(fs.statSync(file).mode & 0o222, 0, 'the mode is as it was')
    // A writable file next to it still changes.
    const plain = await rig.call('read', { path: 'plain.txt' })
    await rig.call('edit', { path: 'plain.txt', expectedHash: plain.hash, edits: edit1('old', 'new') })
    assert.equal(bytes(root, 'plain.txt').toString(), 'new\n')
  })

  test('no-match and many-matches change nothing, all replaces each match, and an old with other line ends gets the hint', async t => {
    const root = folders(t)()
    write(root, { 'a.txt': 'x y x y x\n', 'crlf.txt': 'one\r\ntwo\r\n' })
    for (const name of ['a.txt', 'crlf.txt'])
      fs.utimesSync(path.join(root, name), new Date(1_000_000_000_000), new Date(1_000_000_000_000))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const a = await rig.call('read', { path: 'a.txt' })
    const crlf = await rig.call('read', { path: 'crlf.txt' })
    const before = { tree: snapshot(root), mtime: fs.statSync(path.join(root, 'a.txt')).mtimeMs }
    const no = await rig.fail('edit', { path: 'a.txt', expectedHash: a.hash, edits: edit1('z', 'q') })
    assert.equal(codeOf(no), 'no-match')
    const many = await rig.fail('edit', { path: 'a.txt', expectedHash: a.hash, edits: edit1('x', 'q') })
    assert.equal(codeOf(many), 'many-matches')
    assert.match(many, /occurs 3 times/)
    // The second edit of the list is the one that fails, so the first is not applied either.
    assert.equal(
      codeOf(
        await rig.fail('edit', {
          path: 'a.txt',
          expectedHash: a.hash,
          edits: [
            { old: 'y', new: 'Y', all: true },
            { old: 'nope', new: 'q' },
          ],
        }),
      ),
      'no-match',
    )
    const hint = await rig.fail('edit', { path: 'crlf.txt', expectedHash: crlf.hash, edits: edit1('one\ntwo', 'q') })
    assert.equal(codeOf(hint), 'no-match')
    assert.match(hint, /CRLF line ends/)
    assert.deepEqual(snapshot(root), before.tree)
    assert.equal(fs.statSync(path.join(root, 'a.txt')).mtimeMs, before.mtime)
    const all = await rig.call('edit', {
      path: 'a.txt',
      expectedHash: a.hash,
      edits: [
        { old: 'x', new: 'X', all: true },
        { old: 'y', new: 'Y', all: true },
      ],
    })
    assert.equal(bytes(root, 'a.txt').toString(), 'X Y X Y X\n')
    assert.deepEqual([all.added, all.removed], [1, 1])
  })

  test('an edit that would make the file larger than 4 MiB, a file over it, a binary file and invalid UTF-8 are refused', async t => {
    const root = folders(t)()
    write(root, {
      'near.txt': Buffer.concat([Buffer.alloc(LIMITS.readBytes - 10, 0x61), Buffer.from('MID')]),
      'big.txt': Buffer.alloc(LIMITS.readBytes + 1, 0x61),
      'binary.txt': Buffer.from('ab\0cd'),
      'bad.txt': Buffer.from([0x61, 0xc3, 0x28]),
    })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const near = await rig.call('read', { path: 'near.txt' })
    const before = snapshot(root)
    assert.equal(
      codeOf(
        await rig.fail('edit', { path: 'near.txt', expectedHash: near.hash, edits: edit1('MID', 'y'.repeat(100)) }),
      ),
      'too-large',
    )
    assert.equal(
      codeOf(await rig.fail('edit', { path: 'big.txt', expectedHash: ZERO, edits: edit1('a', 'b') })),
      'too-large',
    )
    assert.equal(
      codeOf(await rig.fail('edit', { path: 'binary.txt', expectedHash: ZERO, edits: edit1('a', 'b') })),
      'binary',
    )
    assert.equal(
      codeOf(await rig.fail('edit', { path: 'bad.txt', expectedHash: ZERO, edits: edit1('a', 'b') })),
      'encoding',
    )
    assert.equal(
      codeOf(await rig.fail('write', { path: 'huge.txt', content: 'a'.repeat(LIMITS.readBytes + 1) })),
      'too-large',
    )
    assert.equal(codeOf(await rig.fail('write', { path: 'binary2.txt', content: 'a\0b' })), 'binary')
    assert.deepEqual(snapshot(root), before)
    const fits = await rig.call('edit', {
      path: 'near.txt',
      expectedHash: near.hash,
      edits: edit1('MID', 'y'.repeat(9)),
    })
    assert.equal(fits.applied, true)
    assert.equal(bytes(root, 'near.txt').length, LIMITS.readBytes - 10 + 9)
  })

  test('write makes the missing folders and the file, and fails with exists on a second call', async t => {
    const root = folders(t)()
    write(root, { 'keep.txt': 'k' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const made = await rig.call('write', { path: 'a/b/c/new.txt', content: 'hi\n' })
    assert.equal(made.path, 'a/b/c/new.txt')
    assert.deepEqual(snapshot(root), {
      'keep.txt': sha(Buffer.from('k')),
      a: 'dir',
      'a/b': 'dir',
      'a/b/c': 'dir',
      'a/b/c/new.txt': sha(Buffer.from('hi\n')),
    })
    assert.equal(codeOf(await rig.fail('write', { path: 'a/b/c/new.txt', content: 'again' })), 'exists')
    assert.equal(codeOf(await rig.fail('write', { path: 'a/b', content: 'x' })), 'exists', 'a folder is something')
    assert.equal(codeOf(await rig.fail('write', { path: 'keep.txt/x.txt', content: 'x' })), 'not-folder')
    assert.deepEqual(bytes(root, 'a/b/c/new.txt'), Buffer.from('hi\n'))
    const empty = await rig.call('write', { path: 'empty.txt', content: '' })
    assert.deepEqual([empty.created, empty.changed, empty.added], [true, true, 0])
    assert.equal(bytes(root, 'empty.txt').length, 0)
  })
})

describe('confinement of the change tools', () => {
  /** The calls that change or preview `p`: a label and the arguments. A label that ends in `new` makes a new file. */
  const variants = (p: string): [string, string, Record<string, unknown>][] => [
    ['diff', 'diff edits', { path: p, edits: edit1('x', 'y') }],
    ['diff', 'diff new', { path: p, content: 'pwned' }],
    ['diff', 'diff replace', { path: p, content: 'pwned', expectedHash: ZERO }],
    ['edit', 'edit', { path: p, expectedHash: ZERO, edits: edit1('x', 'y') }],
    ['write', 'write new', { path: p, content: 'pwned' }],
    ['write', 'write replace', { path: p, content: 'pwned', expectedHash: ZERO }],
  ]

  /**
   * Runs each variant on `p`: it must fail with `code` (`newCode` for a variant that makes a new file). A list of
   * codes says that any of them does. Returns the messages.
   */
  const refuse = async (
    rig: Rig,
    p: string,
    code: string | string[],
    newCode: string | string[] = code,
  ): Promise<string[]> => {
    const seen: string[] = []
    for (const [tool, label, args] of variants(p)) {
      const message = await rig.fail(tool, args)
      seen.push(message)
      const want = [label.endsWith('new') ? newCode : code].flat()
      assert.ok(want.includes(codeOf(message)), `${label} ${JSON.stringify(p.slice(0, 40))}: ${codeOf(message)}`)
    }
    return seen
  }

  test('a bad path is refused with bad-path before any file system call', async t => {
    const root = folders(t)()
    write(root, { 'a/b.txt': 'x' })
    let lookups = 0
    const rig = await rigOf(t, root, { hook: () => void lookups++ })
    if (rig === undefined) return
    const before = snapshot(root)
    const bad = [
      '../x',
      'a/../../x',
      'a/..',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'C:x',
      '//server/share/x',
      'a\\b',
      'a\u0000b',
      'a//b',
      './a',
      Array.from({ length: 65 }, () => 'a').join('/'),
      ...(win ? ['f.txt::$DATA', 'f.txt:s', 'f.txt.', 'f.txt ', 'NUL', 'CON.txt'] : []),
    ]
    for (const text of bad) await refuse(rig, text, 'bad-path')
    assert.equal(lookups, 0, 'no file system call')
    assert.deepEqual(snapshot(root), before)
  })

  test('each sensitive path is refused as excluded by all three tools, a new file in an excluded place is never made', async t => {
    const dirs = folders(t)
    const root = dirs()
    const clean = dirs()
    const secret = marker()
    const sensitive = [
      '.git/config',
      '.git/hooks/pre-commit',
      '.env',
      '.env.local',
      'sub/.env.production',
      'id_rsa',
      'sub/key.pem',
      '.claude/settings.json',
      '.mcp.json',
      '.vscode/tasks.json',
      'fixtures/secrets/a.txt',
      'data/app.sqlite',
    ]
    write(root, { 'ok.txt': 'fine', ...Object.fromEntries(sensitive.map(name => [name, secret])) })
    write(clean, { 'ok.txt': 'fine' })
    const exclude = ['fixtures/secrets/**', '*.sqlite']
    const rig = await rigOf(t, root, { exclude })
    const bare = await rigOf(t, clean, { exclude })
    if (rig === undefined || bare === undefined) return
    const before = snapshot(root)
    const seen: string[] = []
    for (const name of sensitive) seen.push(...(await refuse(rig, name, 'excluded')))
    assert.deepEqual(snapshot(root), before, 'no byte and no name changed')
    // Where the folder does not exist, the refusal comes first: nothing is made on the way.
    const cleanBefore = snapshot(clean)
    for (const name of [...sensitive, '.git/hooks/pre-commit', '.vscode/tasks.json', 'fixtures/secrets/new.txt'])
      seen.push(...(await refuse(bare, name, 'excluded')))
    assert.deepEqual(snapshot(clean), cleanBefore)
    for (const folder of ['.git', '.vscode', '.claude', 'fixtures'])
      assert.equal(fs.existsSync(path.join(clean, folder)), false, `${folder} was not made`)
    assert.ok(!seen.join('\n').includes(secret))
  })

  test('the config file of the session, placed in the root, is excluded for all three tools', async t => {
    const root = folders(t)()
    const home = folders(t)()
    const secret = marker()
    fs.writeFileSync(path.join(root, 'toolscript.json'), secret)
    const { bindWorkspace } = await import('../src/host/workspace/bind.ts')
    const binding = await bindWorkspace({
      workspace: { roots: [{ path: root, write: true }], exclude: [], skip: [] },
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
    for (const [tool, , args] of variants('toolscript.json')) {
      const r = await client.callTool({ name: tool, arguments: args })
      assert.equal(r.isError, true)
      assert.match(JSON.stringify(r.content), /excluded/)
      assert.ok(!JSON.stringify(r).includes(secret))
    }
    assert.equal(fs.readFileSync(path.join(root, 'toolscript.json'), 'utf8'), secret)
  })

  test('a case variant, an NFD spelling and, on Linux, a separate file of another case are excluded', async t => {
    const root = folders(t)()
    const secret = marker()
    write(root, { '.env': secret, 'café.txt': secret, 'plain.txt': 'ok', '.git/x': secret })
    if (!win && !mac) write(root, { '.ENV': secret })
    const rig = await rigOf(t, root, { exclude: ['café.txt'] })
    if (rig === undefined) return
    const before = snapshot(root)
    for (const name of [
      '.ENV',
      '.Env',
      'cafe\u0301.txt',
      'CAFÉ.TXT',
      '.GIT/x',
      '.GIT/new.txt',
      '.Git/hooks/pre-commit',
    ])
      await refuse(rig, name, 'excluded')
    assert.deepEqual(snapshot(root), before)
  })

  test(
    'a short name of an excluded file or folder is refused (Windows, where the volume has short names)',
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
      const before = snapshot(root)
      // A new file at the alias finds the excluded file there: `exists`, and nothing is written.
      await refuse(rig, alias, 'excluded', ['excluded', 'exists'])
      const folderAlias = short('.git')
      if (folderAlias !== undefined) {
        await refuse(rig, `${folderAlias}/x`, 'excluded', ['excluded', 'exists'])
        // The folder `hooks` is not there: a change finds nothing, and a new file stops at the real spelling of `.git`.
        await refuse(rig, `${folderAlias}/hooks/pre-commit`, ['excluded', 'not-found'], 'excluded')
      } else t.diagnostic('the folder .git has no short name on this volume')
      assert.deepEqual(snapshot(root), before)
    },
  )

  test('a link, a junction or a folder link: a change or a new file under it is refused, and the tree outside is unchanged', async t => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(outside, { 'secret.txt': secret, 'deeper/more.txt': secret })
    write(root, { 'inside/f.txt': 'inside', 'real.txt': 'real' })
    const fileLink = trySymlink(path.join(outside, 'secret.txt'), path.join(root, 'lnk-file'), 'file')
    assert.ok(
      trySymlink(outside, path.join(root, 'lnk-dir'), win ? 'junction' : 'dir'),
      'a directory link always works',
    )
    assert.ok(trySymlink(path.join(root, 'inside'), path.join(root, 'lnk-in'), win ? 'junction' : 'dir'))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const before = [snapshot(outside), snapshot(root)]
    const seen: string[] = []
    for (const name of ['lnk-dir/secret.txt', 'lnk-in/f.txt']) seen.push(...(await refuse(rig, name, 'link')))
    // A new file or folder under a link, and under a folder that is not there yet below it. On Windows a change to a
    // file that is not there finds nothing before the proof, so `not-found` is the refusal there.
    for (const name of ['lnk-dir/new.txt', 'lnk-dir/deeper/new.txt', 'lnk-dir/a/b/c.txt', 'lnk-in/new.txt'])
      seen.push(...(await refuse(rig, name, win ? ['link', 'not-found'] : 'link', 'link')))
    if (fileLink) seen.push(...(await refuse(rig, 'lnk-file', 'link', 'exists')))
    else t.diagnostic('this system refuses to make a file symlink: that case did not run')
    assert.deepEqual([snapshot(outside), snapshot(root)], before, 'no byte and no name changed, inside or outside')
    assert.ok(!seen.join('\n').includes(secret))
  })

  test('a junction to a folder outside is refused for a new file too (Windows)', { skip: !win }, async t => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(outside, { 'secret.txt': secret })
    fs.symlinkSync(outside, path.join(root, 'junc'), 'junction')
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const before = snapshot(outside)
    await refuse(rig, 'junc/secret.txt', 'link')
    for (const name of ['junc/new.txt', 'junc/a/b.txt']) await refuse(rig, name, ['link', 'not-found'], 'link')
    assert.deepEqual(snapshot(outside), before)
  })

  test('a file in the root that is a second name of a file outside is refused, and the outside file is unchanged', async t => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(outside, { 'secret.txt': secret })
    write(root, { 'plain.txt': 'plain' })
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'))
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const seen = await refuse(rig, 'hard.txt', 'hard-link', 'exists')
    assert.ok(!seen.join('\n').includes(secret))
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), secret)
    assert.equal(bytes(root, 'hard.txt').toString(), secret)
  })
})

describe('a swap of a folder while a file is changed', () => {
  /** Swaps `root/b` between a real folder (in) and a link to the folder outside (out). */
  const swapper = (root: string, outside: string) => {
    const b = path.join(root, 'b')
    let out = false
    const unlink = () => {
      if (win) fs.rmdirSync(b)
      else fs.unlinkSync(b)
      fs.renameSync(`${b}.real`, b)
    }
    return {
      set: (want: boolean) => {
        if (want === out) return
        if (want) {
          fs.renameSync(b, `${b}.real`)
          fs.symlinkSync(outside, b, win ? 'junction' : 'dir')
        } else unlink()
        out = want
      },
      reset: () => {
        try {
          if (out) unlink()
        } finally {
          out = false
        }
      },
    }
  }

  const INSIDE = 'inside text\n'

  const setup = (t: TestContext) => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    write(root, { 'b/id.txt': INSIDE })
    // The same bytes inside and outside: the hash that the model got for the inside file would also pass for the outside one.
    write(outside, { 'id.txt': INSIDE })
    return { root, outside, swap: swapper(root, outside) }
  }

  test('every pattern of in and out over the lookups of one edit leaves the outside tree unchanged, except the case that the ADR names for Windows', async t => {
    const { root, outside, swap } = setup(t)
    const seen: string[] = []
    let hook: Hook = () => {}
    const rig = await rigOf(t, root, { hook: name => hook(name) })
    if (rig === undefined) return
    const hash = sha(Buffer.from(INSIDE))
    const args = { path: 'b/id.txt', expectedHash: hash, edits: edit1('inside', 'CHANGED') }
    hook = name => void seen.push(name)
    await rig.call('edit', args)
    const lookups = [...seen]
    assert.ok(lookups.length >= 3 && lookups.length <= 8, `the lookups of an edit: ${lookups.join(',')}`)
    const passing: number[] = []
    let impossible = 0
    for (let mask = 0; mask < 1 << lookups.length; mask++) {
      fs.writeFileSync(path.join(root, 'b', 'id.txt'), INSIDE)
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
      const r = await rig.client.callTool({ name: 'edit', arguments: args })
      swap.reset()
      if (stuck) impossible++
      if (fs.readFileSync(path.join(outside, 'id.txt'), 'utf8') !== INSIDE) {
        if (!stuck) passing.push(mask)
        fs.writeFileSync(path.join(outside, 'id.txt'), INSIDE)
        continue
      }
      if (r.isError === true)
        assert.match(
          codeOf((r.content as { text: string }[])[0]!.text),
          /^(link|not-found|not-folder|not-file|root-changed|io|stale|hard-link)$/,
        )
    }
    // The case that the ADR names for Windows: out at the open, then in and out in turn. Any other pattern is a bug.
    const known = (mask: number) => {
      const from = lookups.indexOf('open')
      return lookups.every((_, i) => i < from || ((mask >> i) & 1) === ((i - from) % 2 === 0 ? 1 : 0))
    }
    t.diagnostic(
      `lookups ${lookups.join(',')}; patterns that wrote outside: [${passing}]; patterns that cannot happen: ${impossible}`,
    )
    if (win)
      assert.deepEqual(
        passing.filter(mask => !known(mask)),
        [],
        'only the known case can write outside',
      )
    else assert.deepEqual(passing, [], 'no pattern writes outside')
  })

  test('every pattern of in and out over the lookups of a write of a new file, and of a new folder with it, leaves no payload outside', async t => {
    const { root, outside, swap } = setup(t)
    const seen: string[] = []
    let hook: Hook = () => {}
    const rig = await rigOf(t, root, { hook: name => hook(name) })
    if (rig === undefined) return
    const PAYLOAD = 'payload that must never be outside\n'
    /** Everything in `outside` except its own file, as a path to its size (a folder is -1). */
    const leaked = (): Record<string, number> => {
      const found: Record<string, number> = {}
      const visit = (sub: string) => {
        for (const name of fs.readdirSync(path.join(outside, sub))) {
          const rel = sub === '' ? name : `${sub}/${name}`
          if (rel === 'id.txt') continue
          const st = fs.statSync(path.join(outside, rel))
          found[rel] = st.isDirectory() ? -1 : st.size
          if (st.isDirectory()) visit(rel)
        }
      }
      visit('')
      return found
    }
    const clean = () => {
      for (const name of fs.readdirSync(outside))
        if (name !== 'id.txt') fs.rmSync(path.join(outside, name), { recursive: true, force: true })
      fs.rmSync(path.join(root, 'b', 'c'), { recursive: true, force: true })
      fs.rmSync(path.join(root, 'b', 'new.txt'), { force: true })
    }
    const began = Date.now()
    for (const target of ['b/new.txt', 'b/c/new.txt']) {
      // `b/c/new.txt` has no `c`: the write makes the folder and the file, so it looks up more names.
      seen.length = 0
      hook = name => void seen.push(name)
      await rig.call('write', { path: target, content: PAYLOAD })
      const lookups = [...seen]
      clean()
      assert.ok(lookups.length >= 3, `the lookups of a write: ${lookups.join(',')}`)
      // One pattern is the state of the folder (in or out) at each lookup. The whole space is 2^n and a pattern costs about
      // 20 ms on Windows, so the sweep takes the patterns that can matter, at most 2^11 and at most 2 s for each path:
      // every pattern over the six lookups around an open (the last open first), where a file or folder is made, and
      // every pattern with at most two changes of state. The alternating case of the ADR (out at the open, then in
      // and out in turn) is in the first set.
      const n = lookups.length
      const patterns = new Map<string, boolean[]>()
      const add = (bits: boolean[]) => void patterns.set(bits.map(b => (b ? 1 : 0)).join(''), bits)
      const opens = lookups.flatMap((name, i) => (name === 'open' ? [i] : [])).reverse()
      const around = (o: number) => {
        for (let w = 0; w < 64; w++)
          add(Array.from({ length: n }, (_, i) => i >= o - 1 && i < o + 5 && ((w >> (i - o + 1)) & 1) === 1))
      }
      around(opens[0]!)
      for (const start of [false, true])
        for (let a = 0; a <= n; a++)
          for (let b = a; b <= n; b++)
            add(Array.from({ length: n }, (_, i) => (i < a ? start : i < b ? !start : start)))
      for (const o of opens.slice(1)) around(o)
      const order = [...patterns.values()].slice(0, 1 << 11)
      const outsideBytes: string[] = []
      const outsideEmpty: string[] = []
      const targetBegan = Date.now()
      let tried = 0
      let impossible = 0
      for (const bits of order) {
        if (Date.now() - targetBegan > 2200) break
        let at = 0
        let stuck = false
        const key = bits.map(b => (b ? 1 : 0)).join('')
        hook = () => {
          const want = bits[at++] === true
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
        const r = await rig.client.callTool({ name: 'write', arguments: { path: target, content: PAYLOAD } })
        swap.reset()
        tried++
        if (stuck) impossible++
        const found = leaked()
        if (Object.values(found).some(size => size > 0)) outsideBytes.push(key)
        else if (Object.keys(found).length > 0) outsideEmpty.push(key)
        if (r.isError === true)
          assert.match(
            codeOf((r.content as { text: string }[])[0]!.text),
            /^(link|not-found|not-folder|not-file|root-changed|io|exists|hard-link)$/,
          )
        clean()
      }
      t.diagnostic(
        `${target}: lookups ${lookups.join(',')}; patterns tried ${tried} of ${order.length}; empty entries outside: ${outsideEmpty.length}; impossible: ${impossible}`,
      )
      assert.ok(tried >= Math.min(order.length, 64), `the sweep is bounded by time (${tried} patterns)`)
      assert.deepEqual(outsideBytes, [], 'no byte of the payload is outside')
      // Windows and macOS: the file or folder is made before it is proven, so an empty entry can be left outside (the ADR
      // names it). Linux makes nothing outside.
      if (!win && !mac) assert.deepEqual(outsideEmpty, [], 'Linux makes nothing outside')
    }
    assert.equal(fs.readFileSync(path.join(outside, 'id.txt'), 'utf8'), INSIDE, 'the outside file is unchanged')
    assert.ok(Date.now() - began < 5000, `the sweep takes at most 5 s: ${Date.now() - began} ms`)
  })

  test('a loop that swaps the folder for at most 1 s while at most 300 edits run changes no outside byte', async t => {
    const { root, outside, swap } = setup(t)
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const end = Date.now() + 1000
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
    let edits = 0
    const outcomes = new Map<string, number>()
    let current = INSIDE
    while (edits < 300 && Date.now() < end) {
      const next = current === INSIDE ? 'other text\n' : INSIDE
      const hash = sha(Buffer.from(current))
      const r = await rig.client.callTool({
        name: 'write',
        arguments: { path: 'b/id.txt', content: next, expectedHash: hash },
      })
      const key = r.isError === true ? codeOf((r.content as { text: string }[])[0]!.text) : 'written'
      if (key === 'written') current = next
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
      edits++
    }
    stop = true
    await flipper
    swap.reset()
    t.diagnostic(`${edits} writes: ${JSON.stringify(Object.fromEntries(outcomes))}`)
    assert.equal(fs.readFileSync(path.join(outside, 'id.txt'), 'utf8'), INSIDE, 'the outside file is unchanged')
    assert.deepEqual(fs.readdirSync(outside), ['id.txt'], 'and nothing was made outside')
  })
})

describe('cancel and the lock', () => {
  test('a cancel before the write step changes nothing and drops the lock, and the next change is not busy', async t => {
    const root = folders(t)()
    write(root, { 'f.txt': 'old\n' })
    const abort = new AbortController()
    let armed = false
    let hits = 0
    const rig = await rigOf(t, root, {
      hook: async () => {
        // The first lookup of the change: the lock is held. The cancel reaches the server before the write step.
        if (armed && hits++ === 0) {
          abort.abort()
          await sleep(100)
        }
      },
    })
    if (rig === undefined) return
    const read = await rig.call('read', { path: 'f.txt' })
    armed = true
    const running = rig.call(
      'edit',
      { path: 'f.txt', expectedHash: read.hash, edits: edit1('old', 'new') },
      abort.signal,
    )
    await assert.rejects(running)
    for (let i = 0; i < 200 && rig.bound.provider.inFlight() > 0; i++) await sleep(10)
    assert.equal(rig.bound.provider.inFlight(), 0)
    assert.equal(bytes(root, 'f.txt').toString(), 'old\n', 'nothing was written')
    assert.deepEqual(lockFiles(rig), [], 'the lock is dropped')
    armed = false
    const done = await rig.call('edit', { path: 'f.txt', expectedHash: read.hash, edits: edit1('old', 'new') })
    assert.equal(done.applied, true)
    assert.equal(bytes(root, 'f.txt').toString(), 'new\n')
    assert.deepEqual(lockFiles(rig), [])
  })
})
