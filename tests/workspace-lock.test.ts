// The lock of the Workspace editing tools (issue #144, pull request B): no lost update between two calls, two sessions or
// two processes, `busy` after the wait, a lock of a dead process taken over, and a lock that never stays after a failed call.
// The processes are real: the child is tests/workspace-lock-child.ts, over the HOME of the test.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { lockKey } from '../src/host/workspace/write.ts'
import { codeOf, open, rm, tempDir, write, type Rig, type RigOptions } from './workspace-rig.ts'

const mac = process.platform === 'darwin'
const CHILD = path.join(import.meta.dirname, 'workspace-lock-child.ts')
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const edit = (file: string, old: string, now: string) => ({
  path: file,
  expectedHash: sha(old),
  edits: [{ old, new: now }],
})

const rigOf = async (t: TestContext, root: string, options: RigOptions = {}): Promise<Rig | undefined> => {
  const opened = await open(root, { write: true, ...options })
  if ('unavailable' in opened) {
    if (mac) return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const locksOf = (rig: Rig): string[] => {
  const dir = path.join(rig.home, '.toolscript-mcp', 'locks')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.lock')) : []
}

type Reply = { id: number; ok?: boolean; text?: string; result?: Record<string, unknown>; held?: true; released?: true }

/** A real process with its own provider over `root`, and the HOME `home`. */
const startChild = (t: TestContext, root: string, home: string) => {
  const proc: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CHILD, root, home],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: home, USERPROFILE: home } },
  )
  t.after(() => void proc.kill('SIGKILL'))
  const pending = new Map<number, (reply: Reply) => void>()
  let ready = () => {}
  const started = new Promise<void>(resolve => (ready = resolve))
  readline.createInterface({ input: proc.stdout! }).on('line', text => {
    const m = JSON.parse(text) as Reply & { ready?: true }
    if (m.ready) ready()
    else pending.get(m.id)?.(m)
  })
  let id = 0
  return {
    proc,
    started,
    send: (command: Record<string, unknown>) =>
      new Promise<Reply>(resolve => {
        const n = ++id
        pending.set(n, resolve)
        proc.stdin!.write(`${JSON.stringify({ id: n, ...command })}\n`)
      }),
  }
}

const tree = (t: TestContext) => {
  const root = tempDir()
  t.after(() => rm(root))
  return root
}

describe('the lock inside one process', () => {
  test('two edits of one file with one hash apply exactly one, and the other fails with stale', async t => {
    const root = tree(t)
    write(root, { 'f.txt': 'v' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const began = Date.now()
    let rounds = 0
    for (; rounds < 100 && Date.now() - began < 1000; rounds++) {
      fs.writeFileSync(path.join(root, 'f.txt'), 'v')
      const [a, b] = await Promise.all(
        ['a', 'b'].map(now => rig.client.callTool({ name: 'edit', arguments: edit('f.txt', 'v', now) })),
      )
      const results = [a!, b!]
      const wins = results.filter(r => r.isError !== true)
      const losses = results.filter(r => r.isError === true)
      assert.equal(wins.length, 1, `round ${rounds}`)
      assert.equal(codeOf((losses[0]!.content as { text: string }[])[0]!.text), 'stale')
      const winner = results[0]!.isError === true ? 'b' : 'a'
      assert.equal(
        fs.readFileSync(path.join(root, 'f.txt'), 'utf8'),
        winner,
        `the file holds the winner, round ${rounds}`,
      )
    }
    t.diagnostic(`${rounds} rounds`)
    assert.ok(rounds >= 2, 'the laptop can be busy: the rounds are bounded by time')
    assert.deepEqual(locksOf(rig), [], 'no lock stays')
  })

  test('the lock key folds case and Unicode form on every system, so two spellings of one file share a lock', () => {
    const root = path.join(path.parse(process.cwd()).root, 'ws-root')
    assert.equal(lockKey(root, ['A.txt']), lockKey(root, ['a.txt']))
    assert.equal(lockKey(root, ['Dir', 'F.TXT']), lockKey(root, ['dir', 'f.txt']))
    assert.equal(lockKey(root, ['café.txt']), lockKey(root, ['café.txt']))
    assert.notEqual(lockKey(root, ['a.txt']), lockKey(root, ['b.txt']))
    assert.notEqual(lockKey(root, ['a', 'b.txt']), lockKey(root, ['ab.txt']))
  })

  test('two edits of one file under two spellings with one hash apply exactly one (a volume that ignores case)', async t => {
    const root = tree(t)
    write(root, { 'A.txt': 'one\ntwo\n' })
    // Windows and macOS ignore case by default. Linux does on a bind mount of such a folder, so the probe decides.
    if (!fs.existsSync(path.join(root, 'a.txt'))) return void t.skip('this volume tells A.txt and a.txt apart')
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const text = 'one\ntwo\n'
    const began = Date.now()
    let rounds = 0
    for (; rounds < 50 && Date.now() - began < 2000; rounds++) {
      fs.writeFileSync(path.join(root, 'A.txt'), text)
      const [a, b] = await Promise.all([
        rig.client.callTool({
          name: 'edit',
          arguments: { path: 'A.txt', expectedHash: sha(text), edits: [{ old: 'one', new: 'ONE' }] },
        }),
        rig.client.callTool({
          name: 'edit',
          arguments: { path: 'a.txt', expectedHash: sha(text), edits: [{ old: 'two', new: 'TWO' }] },
        }),
      ])
      const results = [a!, b!]
      const wins = results.filter(r => r.isError !== true)
      const losses = results.filter(r => r.isError === true)
      assert.equal(wins.length, 1, `round ${rounds}`)
      assert.equal(codeOf((losses[0]!.content as { text: string }[])[0]!.text), 'stale')
      const now = fs.readFileSync(path.join(root, 'A.txt'), 'utf8')
      assert.ok(now === 'ONE\ntwo\n' || now === 'one\nTWO\n', `one edit, not both: ${JSON.stringify(now)}`)
    }
    t.diagnostic(`${rounds} rounds`)
    assert.ok(rounds >= 2)
    assert.deepEqual(locksOf(rig), [], 'no lock stays')
  })

  test('the lock file is named for the hash of the real path, and the change takes it before it opens the file', async t => {
    const root = tree(t)
    write(root, { 'f.txt': 'v' })
    const seen: string[][] = []
    let armed = false
    let rig: Rig | undefined
    rig = await rigOf(t, root, { hook: () => void (armed && rig !== undefined && seen.push(locksOf(rig))) })
    if (rig === undefined) return
    armed = true
    await rig.call('edit', edit('f.txt', 'v', 'w'))
    armed = false
    const name = `${lockKey(rig.bound.root, ['f.txt'])}.lock`
    assert.match(name, /^[0-9a-f]{64}\.lock$/)
    assert.ok(seen.length > 0)
    for (const files of seen) assert.deepEqual(files, [name])
    assert.deepEqual(locksOf(rig), [])
  })

  test('edits of two different files run at the same time', async t => {
    const root = tree(t)
    write(root, { 'a.txt': 'v', 'b.txt': 'v' })
    // The first lookup of the first edit waits at the gate, with the lock of its file held.
    let rigHook: () => Promise<void> = async () => {}
    let gate: () => void = () => {}
    const entered = new Promise<void>(resolve => {
      let first = true
      const held = new Promise<void>(open => (gate = open))
      rigHook = async () => {
        if (first) {
          first = false
          resolve()
          await held
        }
      }
    })
    const rig = await rigOf(t, root, { hook: () => rigHook() })
    if (rig === undefined) return
    const slow = rig.call('edit', edit('a.txt', 'v', 'slow'))
    await entered
    // The first edit is inside its lock. The second file does not wait for it.
    const quick = await rig.call('edit', edit('b.txt', 'v', 'quick'))
    assert.equal(quick.applied, true)
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'quick')
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v', 'the first edit has not written yet')
    gate()
    assert.equal((await slow).applied, true)
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'slow')
    assert.deepEqual(locksOf(rig), [])
  })

  test('a failed change drops its lock: stale, no-match and exists leave no lock file', async t => {
    const root = tree(t)
    write(root, { 'f.txt': 'v' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    assert.equal(codeOf(await rig.fail('edit', edit('f.txt', 'old', 'x'))), 'stale')
    assert.equal(
      codeOf(
        await rig.fail(
          'edit',
          edit('f.txt', 'v', 'x').edits && { ...edit('f.txt', 'v', 'x'), edits: [{ old: 'zzz', new: 'x' }] },
        ),
      ),
      'no-match',
    )
    assert.equal(codeOf(await rig.fail('write', { path: 'f.txt', content: 'x' })), 'exists')
    assert.deepEqual(locksOf(rig), [])
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'v')
  })
})

describe('the lock across processes', () => {
  test('two processes that edit one file with one hash apply exactly one, and the other fails with stale', async t => {
    const root = tree(t)
    write(root, { 'f.txt': 'v0' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const [a, b] = [startChild(t, rig.bound.root, rig.home), startChild(t, rig.bound.root, rig.home)]
    await Promise.all([a.started, b.started])
    const began = Date.now()
    let rounds = 0
    for (; rounds < 8 && Date.now() - began < 5000; rounds++) {
      const old = `v${rounds}`
      const [x, y] = await Promise.all([
        a.send({ edit: edit('f.txt', old, `a${rounds}`) }),
        b.send({ edit: edit('f.txt', old, `b${rounds}`) }),
      ])
      assert.equal([x!, y!].filter(r => r.ok === true).length, 1, `round ${rounds}: ${JSON.stringify([x, y])}`)
      const loser = x!.ok === true ? y! : x!
      assert.equal(codeOf(loser.text ?? ''), 'stale')
      const winner = x!.ok === true ? `a${rounds}` : `b${rounds}`
      assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), winner)
      fs.writeFileSync(path.join(root, 'f.txt'), `v${rounds + 1}`)
    }
    t.diagnostic(`${rounds} rounds`)
    assert.ok(rounds >= 5)
    assert.deepEqual(locksOf(rig), [])
  })

  test('a lock held by a live process gives busy after the wait and keeps the other lock, then the change goes through', async t => {
    const root = tree(t)
    write(root, { 'f.txt': 'v' })
    const rig = await rigOf(t, root, { locks: { waitMs: 400 } })
    if (rig === undefined) return
    const holder = startChild(t, rig.bound.root, rig.home)
    await holder.started
    assert.equal((await holder.send({ hold: 'f.txt' })).held, true)
    const held = locksOf(rig)
    assert.equal(held.length, 1)
    const began = Date.now()
    const message = await rig.fail('edit', edit('f.txt', 'v', 'w'))
    const waited = Date.now() - began
    assert.equal(codeOf(message), 'busy')
    assert.ok(waited >= 350 && waited < 3000, `waited ${waited} ms`)
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'v')
    assert.deepEqual(locksOf(rig), held, 'the lock of the other process is still there')
    assert.equal((await holder.send({ release: true })).released, true)
    assert.deepEqual(locksOf(rig), [])
    assert.equal((await rig.call('edit', edit('f.txt', 'v', 'w'))).applied, true)
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'w')
  })

  test('a lock of a dead process is taken over at once', async t => {
    const root = tree(t)
    write(root, { 'f.txt': 'v' })
    const rig = await rigOf(t, root)
    if (rig === undefined) return
    const holder = startChild(t, rig.bound.root, rig.home)
    await holder.started
    assert.equal((await holder.send({ hold: 'f.txt' })).held, true)
    assert.equal(locksOf(rig).length, 1)
    const exited = new Promise<void>(resolve => holder.proc.once('exit', () => resolve()))
    holder.proc.kill('SIGKILL')
    await exited
    assert.equal(locksOf(rig).length, 1, 'the dead process left its lock file')
    const began = Date.now()
    assert.equal((await rig.call('edit', edit('f.txt', 'v', 'w'))).applied, true)
    assert.ok(Date.now() - began < 1500, `${Date.now() - began} ms`)
    assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'w')
    assert.deepEqual(locksOf(rig), [])
    await sleep(0)
  })
})
