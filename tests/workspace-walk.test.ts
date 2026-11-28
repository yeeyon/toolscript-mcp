// The walk of `list` and `search` over big folders (issue #148): excluded names do not count toward the budget, and a
// folder with more names than the budget is read to the budget, not to its end. Small injected limits, small trees.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { queueWaitMs } from '../src/core/workspace.ts'
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

// Several files of one \`search\` walk are read at the same time (the option `searchInFlight` of the limits). Each visit
// proves its own open as before, and the matches are taken in the order of the walk, so the answer is the same for any N.
describe('search with several files in flight', () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  /** A tree with matches, a binary file, an excluded file and a folder in a folder, so the order and the counts matter. */
  const mixed = (t: TestContext) => {
    const root = tree(t)
    const text = (i: number) => Array.from({ length: 6 }, (_, k) => `line ${k} hit ${i}`).join('\n') + '\n'
    write(root, {
      ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a/f${String(i).padStart(2, '0')}.txt`, text(i)])),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`a/b/g${String(i).padStart(2, '0')}.txt`, text(100 + i)]),
      ),
      'a/bin.dat': 'hit\u0000hit',
      'a/skip.sqlite': 'hit\n',
      'c.txt': 'hit\n',
    })
    return root
  }

  test('the answer is the same for 1, 2, 4 and 8 files in flight, also when it is cut at maxMatches', async t => {
    const root = mixed(t)
    for (const args of [
      { query: 'hit' },
      { query: 'hit', maxMatches: 7 },
      { query: ['hit', 'line 3'], maxMatches: 11 },
    ]) {
      const answers: string[] = []
      for (const searchInFlight of [1, 2, 4, 8]) {
        const rig = await rigOf(t, root, { exclude: ['*.sqlite'], limits: { searchInFlight } })
        if (rig === undefined) return
        answers.push(JSON.stringify(await rig.call('search', args)))
      }
      assert.equal(
        new Set(answers).size,
        1,
        JSON.stringify(args) + ' differs: ' + answers.map(a => a.slice(0, 120)).join(' | '),
      )
    }
  })

  test('up to N opens are at the same time, never more, and one at a time for N = 1', async t => {
    const root = mixed(t)
    for (const [searchInFlight, most] of [
      [1, 1],
      [4, 4],
    ] as const) {
      let now = 0
      let top = 0
      const rig = await rigOf(t, root, {
        limits: { searchInFlight },
        hook: async lookup => {
          if (lookup !== 'open') return
          top = Math.max(top, ++now)
          await sleep(15)
          now--
        },
      })
      if (rig === undefined) return
      const r = await rig.call('search', { query: 'hit', maxMatches: 2000 })
      assert.equal(r.filesScanned, 44)
      // The first call of a rig can pay a one-time open, so the bound is checked on the counted peak.
      assert.ok(top <= most, `N = ${searchInFlight}: ${top} opens at the same time`)
      if (searchInFlight > 1) assert.ok(top >= 2, `N = ${searchInFlight}: no overlap, peak ${top}`)
    }
  })

  test('with no kind from the listing, the lstat of up to N entries of a folder are at the same time for a search, and one at a time for N = 1 and for a list', async t => {
    // No file matches the include, so no file is opened: the lookups of `lstat` are those of the entries and of their brackets.
    const root = tree(t)
    write(root, files('e', 24))
    for (const [tool, searchInFlight, most, least] of [
      ['search', 1, 1, 1],
      ['search', 4, 4, 2],
      ['list', 4, 1, 1],
    ] as const) {
      let now = 0
      let top = 0
      const rig = await rigOf(t, root, {
        limits: { searchInFlight },
        listedKinds: false,
        hook: async lookup => {
          if (lookup !== 'lstat') return
          top = Math.max(top, ++now)
          await sleep(10)
          now--
        },
      })
      if (rig === undefined) return
      const args = tool === 'search' ? { query: 'hit', include: ['**/*.nomatch'] } : { include: ['**/*.nomatch'] }
      const r = await rig.call(tool, args)
      assert.equal(r.truncated, false)
      assert.ok(top <= most, `${tool} N = ${searchInFlight}: ${top} lstat at the same time`)
      assert.ok(top >= least, `${tool} N = ${searchInFlight}: peak ${top}`)
    }
  })

  test('a search takes the kind of each entry from the listing: no lstat of an entry, the same answer, and a list still looks at each', async t => {
    const root = mixed(t)
    const counted = async (listedKinds: boolean, tool: string, args: Record<string, unknown>) => {
      let lstats = 0
      const rig = await rigOf(t, root, {
        listedKinds,
        hook: lookup => void (lookup === 'lstat' && lstats++),
      })
      if (rig === undefined) return undefined
      await rig.call(tool, args) // the first call of a rig can pay a one-time lookup
      lstats = 0
      const answer = await rig.call(tool, args)
      return { lstats, answer: JSON.stringify(answer) }
    }
    const withKinds = await counted(true, 'search', { query: 'hit', maxMatches: 2000 })
    const without = await counted(false, 'search', { query: 'hit', maxMatches: 2000 })
    if (withKinds === undefined || without === undefined) return
    assert.equal(withKinds.answer, without.answer)
    // The tree has 46 names: each had one lstat without the kind, with the proofs of the folder around it on Windows and macOS.
    assert.ok(
      without.lstats - withKinds.lstats >= 46,
      `lstat: ${without.lstats} without the kind, ${withKinds.lstats} with it`,
    )
    const listA = await counted(true, 'list', { depth: 3 })
    const listB = await counted(false, 'list', { depth: 3 })
    if (listA === undefined || listB === undefined) return
    assert.equal(listA.lstats, listB.lstats, 'a list does not use the kinds of the listing')
    assert.ok(listA.lstats >= 46)
  })

  test('an error of one visit ends the call after every running visit has ended: none opens a name later', async t => {
    const root = tree(t)
    write(root, { 'd/a0': 'hit\n', 'd/a1': 'hit\n', 'd/a2': 'hit\n', 'd/a3': 'hit\n', 'd/a4': 'hit\n' })
    let listed = false
    let opens = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    let afterReturn = 0
    let returned = false
    const rig = await rigOf(t, root, {
      limits: { searchInFlight: 4 },
      hook: async lookup => {
        if (returned && lookup !== 'readdir') afterReturn++
        if (lookup === 'readdir') listed = true
        if (lookup !== 'open' || !listed) return
        const n = ++opens
        // The first open of a file of d fails, the second fails too, the third is held, the others go on.
        if (n === 2 || n === 3) throw new Error('stop ' + n)
        if (n === 4) await gate
      },
    })
    if (rig === undefined) return
    const call = rig.client.callTool({ name: 'search', arguments: { query: 'hit' } }).then(r => {
      returned = true
      return r
    })
    for (let i = 0; i < 200 && opens < 4; i++) await sleep(5)
    assert.ok(opens >= 4, 'the 4 opens of the files are in flight')
    await sleep(60)
    assert.equal(returned, false, 'the call waits for the held visit before it ends')
    release()
    const r = await call
    assert.equal(r.isError, true)
    await sleep(80)
    assert.equal(afterReturn, 0, 'a lookup ran after the call ended')
    assert.equal(rig.bound.provider.inFlight(), 0)
    // The next call works: no handle or folder is left half closed.
    opens = 100
    assert.equal((await rig.call('search', { query: 'hit' })).filesScanned, 5)
  })

  test('a cancel while the opens are held ends the call, and the slot and the handles are free for the next call', async t => {
    const root = tree(t)
    write(root, files('h', 12))
    let hold = true
    let listed = false
    let held = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const rig = await rigOf(t, root, {
      limits: { searchInFlight: 4 },
      hook: async lookup => {
        // The opens after the first listing are the files of the walk: they are held.
        if (lookup === 'readdir') listed = true
        if (lookup === 'open' && hold && listed) {
          held++
          await gate
        }
      },
    })
    if (rig === undefined) return
    const quit = new AbortController()
    const call = rig.call('search', { query: 'hit' }, quit.signal)
    const outcome = call.then(
      () => 'done',
      () => 'cancelled',
    )
    for (let i = 0; i < 400 && held < 2; i++) await sleep(5)
    assert.ok(held >= 2, 'at least 2 opens were in flight')
    quit.abort()
    hold = false
    release()
    assert.equal(await outcome, 'cancelled')
    for (let i = 0; i < 400 && rig.bound.provider.inFlight() > 0; i++) await sleep(5)
    assert.equal(rig.bound.provider.inFlight(), 0)
    const again = await rig.call('search', { query: 'hit' })
    assert.equal(again.filesScanned, 12)
  })
})

describe('a call that waits too long for its walk slot answers as not started', () => {
  // callMs 3400 and searchMs 1000 give a queue wait of 400 ms: queueWaitMs = callMs - searchMs - 2000. The held walk
  // keeps the slot for about that long, so searchMs is longer than the hold.
  const limits = { searchMs: 1000, callMs: 3400 }
  const waitMs = 400
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !ok(); i++) await pause(5)
    assert.ok(ok(), 'the condition did not come true')
  }
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

  test('the queue wait is the call limit less the walk budget and 2 s, and 0 for a short limit', () => {
    assert.equal(queueWaitMs(60_000, 10_000), 48_000)
    assert.equal(queueWaitMs(5_000, 10_000), 0)
    assert.equal(queueWaitMs(12_000, 10_000), 0)
    assert.equal(queueWaitMs(3_400, 1_000), waitMs)
  })

  test('calls that still wait at the cap answer at once as not started, in order, and open no file', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    let opens = 0
    const rig = await rigOf(t, root, {
      limits,
      hook: async lookup => {
        if (lookup === 'open') opens++
        await h.hook(lookup)
      },
    })
    if (rig === undefined) return
    const first = rig.call('search', { query: 'hit' })
    await until(() => h.held() === 1)
    const opensBefore = opens
    const began = performance.now()
    const answered: string[] = []
    const second = rig.call('search', { query: 'hit' }).then(r => (answered.push('second'), r))
    const third = rig.call('list').then(r => (answered.push('third'), r))
    const [b, c] = await Promise.all([second, third])
    const took = performance.now() - began
    assert.ok(took >= waitMs - 30 && took < waitMs + 500, `the cap answered after ${took} ms`)
    assert.deepEqual(answered, ['second', 'third'])
    assert.deepEqual(b, { matches: [], truncated: true, filesScanned: 0, skipped: 0, notStarted: true })
    assert.deepEqual(c, { entries: [], truncated: true, notStarted: true })
    assert.equal(h.held(), 1, 'a walk of theirs made a lookup')
    assert.equal(opens, opensBefore, 'a call that did not start opened a file or a folder')
    h.release()
    const done = await first
    assert.equal(done.truncated, false)
    assert.equal(done.matches.length, 1)
    assert.ok(!('notStarted' in done))
    const later = await rig.call('search', { query: 'hit' })
    assert.equal(later.matches.length, 1)
    assert.ok(!('notStarted' in later))
    await until(() => rig.bound.provider.inFlight() === 0)
  })

  test('a call that gets its slot just before the cap runs its whole budget and returns its matches', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { limits, hook: h.hook })
    if (rig === undefined) return
    const first = rig.call('search', { query: 'hit' })
    await until(() => h.held() === 1)
    const second = rig.call('search', { query: 'hit' })
    await pause(waitMs - 150)
    h.release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.matches.length, 1)
    assert.equal(b.matches.length, 1)
    assert.equal(b.truncated, false)
    assert.ok(!('notStarted' in b))
  })

  test('a batch that fits gives the same results as one call at a time, with no notStarted key', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit one\n', 'd/b.txt': 'hit two\n', 'd/c.txt': 'nothing\n' })
    const rig = await rigOf(t, root, { limits })
    if (rig === undefined) return
    const args = [{ query: 'hit' }, { query: 'two' }, { query: ['one', 'nothing'] }, { query: 'hit', path: 'd' }]
    const one: string[] = []
    for (const a of args) one.push(JSON.stringify(await rig.call('search', a)))
    const batch = (await Promise.all(args.map(a => rig.call('search', a)))).map(r => JSON.stringify(r))
    assert.deepEqual(batch, one)
    for (const text of batch) assert.ok(!text.includes('notStarted'))
    await until(() => rig.bound.provider.inFlight() === 0)
  })

  test('a cancel while waiting fails and takes no slot; a call that left by the cap takes none later; the others keep their order', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { limits, hook: h.hook })
    if (rig === undefined) return
    const first = rig.call('search', { query: 'hit' })
    await until(() => h.held() === 1)
    const quit = new AbortController()
    const cancelled = rig.call('list', {}, quit.signal)
    const left = rig.call('search', { query: 'hit' })
    await until(() => rig.bound.provider.inFlight() === 3)
    quit.abort()
    await assert.rejects(cancelled)
    assert.equal((await left).notStarted, true)
    const order: string[] = []
    const next = rig.call('search', { query: 'hit' }).then(r => (order.push('next'), r))
    const last = rig.call('list').then(r => (order.push('last'), r))
    await until(() => rig.bound.provider.inFlight() === 3)
    h.release()
    const [a, n, l] = await Promise.all([first, next, last])
    assert.equal(a.truncated, false)
    assert.equal(n.matches.length, 1)
    assert.ok(!('notStarted' in n))
    assert.ok(!('notStarted' in l))
    assert.deepEqual(order, ['next', 'last'])
    await until(() => rig.bound.provider.inFlight() === 0)
  })

  test('with a call limit under 12 s a call that must queue answers at once, and a walk alone runs', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'hit\n' })
    const h = holding()
    const rig = await rigOf(t, root, { limits: { searchMs: 1000, callMs: 3000 }, hook: h.hook })
    if (rig === undefined) return
    const alone = rig.call('search', { query: 'hit' })
    await until(() => h.held() === 1)
    const began = performance.now()
    const second = await rig.call('search', { query: 'hit' })
    assert.equal(second.notStarted, true)
    assert.ok(performance.now() - began < 500)
    h.release()
    assert.equal((await alone).matches.length, 1)
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
    const rig = await rigOf(t, root, { hook: h.hook, limits: { searchMs } })
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
    const rig = await rigOf(t, root, { hook: h.hook })
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
    const rig = await rigOf(t, root, { hook: h.hook })
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
  test('a search that took its last match walks no sibling folder, at any number in flight', async t => {
    const root = tree(t)
    const sub = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`b/s${i}/f.dat`, 'nothing\n']))
    write(root, {
      ...Object.fromEntries(Object.keys(files('a/x', 4)).map(k => [`${k}.txt`, 'hit\n'])),
      ...Object.fromEntries(Object.keys(files('b/y', 400)).map(k => [`${k}.dat`, 'nothing\n'])),
      ...sub,
    })
    for (const searchInFlight of [1, 4]) {
      let readdirs = 0
      const rig = await rigOf(t, root, {
        limits: { searchInFlight },
        hook: lookup => void (lookup === 'readdir' && readdirs++),
      })
      if (rig === undefined) return
      readdirs = 0
      const found = await rig.call('search', { query: 'hit', include: ['**/*.txt'], maxMatches: 2 })
      assert.equal(found.matches.length, 2)
      assert.equal(readdirs, 2, `N = ${searchInFlight}: the root and a, never b`)
    }
  })

  test('the visits before a folder are taken before the folder is opened: a cut file, then a folder that cannot be read', async t => {
    const deep = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`b/${'d/'.repeat(i + 1)}f.txt`, 'nothing\n']))
    for (const [name, extra] of [
      ['unreadable', { 'b/f.txt': 'nothing\n' }],
      ['deep', deep],
    ] as const) {
      const root = tree(t)
      write(root, { 'a.txt': 'hit\n'.repeat(10), ...extra })
      for (const searchInFlight of [1, 4]) {
        let readdirs = 0
        const rig = await rigOf(t, root, {
          limits: { searchInFlight },
          hook: lookup => {
            if (lookup !== 'readdir') return
            // The root is the first listing: a second one is a folder of the walk, and it cannot be read.
            if (++readdirs > 1) throw new Error('unreadable folder')
          },
        })
        if (rig === undefined) return
        readdirs = 0
        const found = await rig.call('search', { query: 'hit', maxMatches: 2 })
        assert.equal(found.matches.length, 2, `${name}, N = ${searchInFlight}`)
        assert.equal(found.truncated, true)
        assert.equal(readdirs, 1, `${name}, N = ${searchInFlight}: no folder after the cut`)
      }
    }
  })
})
