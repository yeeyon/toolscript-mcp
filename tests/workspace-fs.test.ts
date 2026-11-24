// The confined file system and the four read tools, on real temp trees. Each fixture checks bytes and names that the
// result holds, never a success text. A fixture is refused when the call fails with its code, no byte or name from
// outside the root is in any result, and no file on disk changed.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LIMITS } from '../src/core/workspace.ts'
import { openConfined, type Hook } from '../src/host/workspace/confined.ts'
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
    assert.deepEqual(
      [...new Set(files.matches.map((m: { path: string }) => m.path))],
      ['f00.txt', 'f01.txt', 'f02.txt', 'f03.txt', 'f04.txt'],
    )
    const entries = await rig.call('list')
    assert.equal(entries.entries.length, 7)
    assert.equal(entries.truncated, true)
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

describe('a swap of a folder while a file is read', () => {
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

  const setup = (t: TestContext) => {
    const dirs = folders(t)
    const root = dirs()
    const outside = dirs()
    const secret = marker()
    write(root, { 'b/id.txt': 'inside file' })
    write(outside, { 'id.txt': `outside ${secret}` })
    return { root, outside, secret, swap: swapper(root, outside) }
  }

  test('every pattern of in and out over the lookups of one read refuses or reads the inside file', async t => {
    const { root, outside, secret, swap } = setup(t)
    const seen: string[] = []
    let hook: Hook = () => {}
    const rig = await rigOf(t, root, { hook: name => hook(name) })
    if (rig === undefined) return
    void outside
    hook = name => void seen.push(name)
    assert.equal((await rig.call('read', { path: 'b/id.txt' })).content, 'inside file')
    const lookups = [...seen]
    assert.ok(lookups.length >= 2 && lookups.length <= 8, `the lookups of a read: ${lookups.join(',')}`)
    const passing: number[] = []
    let impossible = 0
    for (let mask = 0; mask < 1 << lookups.length; mask++) {
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
      const r = await rig.client.callTool({ name: 'read', arguments: { path: 'b/id.txt' } })
      swap.reset()
      const text = JSON.stringify(r)
      if (stuck) impossible++
      if (text.includes(secret)) {
        if (!stuck) passing.push(mask)
        continue
      }
      if (r.isError !== true)
        assert.equal((r.structuredContent as { content: string }).content, 'inside file', `mask ${mask}`)
      else
        assert.match(
          codeOf((r.content as { text: string }[])[0]!.text),
          /^(link|not-found|not-folder|not-file|root-changed|io)$/,
        )
    }
    // The case that the ADR names for Windows: out at the open, then in and out in turn. Any other pattern is a bug.
    const known = (mask: number) => {
      const from = lookups.indexOf('open')
      return lookups.every((_, i) => i < from || ((mask >> i) & 1) === ((i - from) % 2 === 0 ? 1 : 0))
    }
    t.diagnostic(
      `lookups ${lookups.join(',')}; patterns that read outside: [${passing}]; patterns that cannot happen: ${impossible}`,
    )
    if (win)
      assert.deepEqual(
        passing.filter(mask => !known(mask)),
        [],
        'only the known case can read outside',
      )
    else assert.deepEqual(passing, [], 'no pattern reads outside')
  })

  test('a loop that swaps the folder for at most 2 s while at most 300 reads run reads no outside byte', async t => {
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
    while (reads < 300 && Date.now() < end) {
      const r = await rig.client.callTool({ name: 'read', arguments: { path: 'b/id.txt' } })
      assert.ok(!JSON.stringify(r).includes(secret), 'an outside byte')
      const key = r.isError === true ? codeOf((r.content as { text: string }[])[0]!.text) : 'read'
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
