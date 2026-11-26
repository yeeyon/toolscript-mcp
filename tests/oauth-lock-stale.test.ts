// The lock of an OAuth refresh across processes: a lock that is already there, and a holder that dies.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  PONG,
  cleanup,
  until,
  setup,
  group,
  round,
  requests,
  revocations,
  stop,
  putLock,
  lockText,
  deadPid,
  type Fake,
} from './oauth-lock-util.ts'

after(cleanup)

/** The time a waiter gives a refresh in a phase that must succeed: far past what a busy runner needs. */
const SLOW_WAIT_MS = 15_000

describe('a lock that is already there', { timeout: 180_000 }, () => {
  test('a dead pid: 6 waiters take it over at once in each of 5 rounds, with one request and no revocation', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 6)
    for (let i = 0; i < 5; i++) {
      putLock(s, lockText(await deadPid()), 0)
      const before = requests(fake)
      const { lines, ms } = await round(s, children)
      assert.equal(revocations(s), 0, `round ${i}: the server revoked the grant`)
      assert.deepEqual(
        lines.map(l => l.text),
        Array(6).fill(PONG),
        `round ${i}`,
      )
      assert.equal(requests(fake) - before, 1, `round ${i}`)
      assert.ok(ms < 5000, `${ms} ms: no wait for the age`)
      assert.deepEqual(s.leftovers(), [], `round ${i}`)
    }
    await stop(children)
  })

  test('a live pid that is not a holder: young, the refresh fails at its time with no request. Old, it is taken over', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 6, 1000)
    // Both groups start before any lock or expiry: the warm-up round of a group must not meet a lock.
    const takers = await group(s, 6, SLOW_WAIT_MS)
    // After the start of the processes: on a slow machine it takes longer than the age of a lock (12 s here).
    putLock(s, lockText(process.pid), 0)
    const young = await round(s, children)
    assert.equal(young.lines.length, 6)
    for (const l of young.lines)
      assert.match(l.text, /another toolscript-mcp process is refreshing.*No login is needed/, l.text)
    assert.ok(young.ms < 1000 + 2000, `${young.ms} ms`)
    assert.equal(requests(fake), 0)
    await stop(children)
    // The old phase: one process takes over and refreshes while the others wait for it, and on a slow machine
    // that takes more than the 1 s that the young phase gives a waiter. So these waiters wait longer.
    putLock(s, lockText(process.pid), 600)
    const old = await round(s, takers)
    assert.deepEqual(
      old.lines.map(l => l.text),
      Array(6).fill(PONG),
    )
    assert.equal(requests(fake), 1)
    assert.equal(revocations(s), 0)
    assert.deepEqual(s.leftovers(), [])
    await stop(takers)
  })

  for (const [name, text] of [
    ['garbage', 'this is not a lock'],
    ['an empty file', ''],
  ] as const)
    test(`${name}: waits for the age, and then 6 waiters take it over with one request`, async () => {
      const s = await setup()
      const [fake] = s.fakes as [Fake]
      const children = await group(s, 6, 1000)
      const takers = await group(s, 6, SLOW_WAIT_MS)
      putLock(s, text, 0)
      const young = await round(s, children)
      for (const l of young.lines) assert.match(l.text, /another toolscript-mcp process is refreshing/, l.text)
      assert.equal(requests(fake), 0)
      await stop(children)
      putLock(s, text, 600)
      const old = await round(s, takers)
      assert.deepEqual(
        old.lines.map(l => l.text),
        Array(6).fill(PONG),
      )
      assert.equal(requests(fake), 1)
      assert.equal(revocations(s), 0)
      await stop(takers)
    })

  test('a folder where the lock goes: no crash and no hang past the time', async () => {
    const s = await setup()
    const lock = `${s.files[0]}.lock`
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 600_000)
    fs.utimesSync(lock, old, old)
    const children = await group(s, 2, 1000)
    const { lines, ms } = await round(s, children)
    assert.equal(lines.length, 2)
    for (const l of lines) assert.match(l.text, /another toolscript-mcp process is refreshing/, l.text)
    assert.ok(ms < 1000 + 2000, `${ms} ms`)
    assert.ok(
      children.every(c => c.proc.exitCode === null),
      'a process died',
    )
    await stop(children)
  })
})

describe('a holder that dies', { timeout: 180_000 }, () => {
  test('SIGKILL while the endpoint holds the answer: the others take over within 1 s, with one more request', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 6)
    let release = () => {}
    fake.change.gate = new Promise<void>(resolve => (release = resolve))
    // The holder dies with its request open: the server finishes none of it, and uses up no token.
    fake.change.abandon = 1
    fake.expire()
    for (const c of children) c.go()
    await until('the first request', () => requests(fake) === 1)
    const held = JSON.parse(fs.readFileSync(`${s.files[0]}.lock`, 'utf8')) as { pid: number }
    const holder = children.find(c => c.proc.pid === held.pid)
    assert.ok(holder, 'the lock holds the pid of one of the children')
    holder.proc.kill('SIGKILL')
    const killed = Date.now()
    await until('the second request', () => requests(fake) === 2, 1500)
    assert.ok(Date.now() - killed < 1000, `${Date.now() - killed} ms after the kill`)
    release()
    const others = children.filter(c => c !== holder)
    await Promise.all(others.map(c => c.ended()))
    assert.deepEqual(
      others.flatMap(c => c.lines().map(l => l.text)),
      Array(5).fill(PONG),
    )
    assert.equal(requests(fake), 2)
    assert.equal(revocations(s), 0)
    assert.deepEqual(s.leftovers(), [])
    await stop(others)
  })
})
