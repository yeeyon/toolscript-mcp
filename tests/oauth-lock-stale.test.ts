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
  test('a dead pid: 6 waiters take it over with no wait for the age in each of 2 rounds, with one request and no revocation', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    // The refresh time is 20 s, and a lock that is 0 s old goes stale by age only after 31 s. So a waiter that waited for
    // the age would fail its refresh first. The answer `pong` of all 6 proves the takeover with no wait, on any runner.
    // The races of the takeover itself are proven in tests/oauthlock.test.ts, with no process.
    const children = await group(s, 6)
    for (let i = 0; i < 2; i++) {
      putLock(s, lockText(await deadPid()), 0)
      const before = requests(fake)
      const { lines } = await round(s, children)
      assert.equal(revocations(s), 0, `round ${i}: the server revoked the grant`)
      assert.deepEqual(
        lines.map(l => l.text),
        Array(6).fill(PONG),
        `round ${i}`,
      )
      assert.equal(requests(fake) - before, 1, `round ${i}`)
      assert.deepEqual(s.leftovers(), [], `round ${i}`)
    }
    await stop(children)
  })

  test('a live pid, garbage, an empty file and a folder: young, the refresh fails at its time with no request. Old, 6 waiters take over a file with one request', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 6, 1000)
    // Both groups start before any lock or expiry: the warm-up round of a group must not meet a lock.
    const takers = await group(s, 6, SLOW_WAIT_MS)
    // One store and two groups for the three kinds of lock: each start of 12 processes costs more than a round.
    for (const [name, text] of [
      ['a live pid', lockText(process.pid)],
      ['garbage', 'this is not a lock'],
      ['an empty file', ''],
    ] as const) {
      const before = requests(fake)
      // After the start of the processes: on a slow machine it takes longer than the age of a lock (12 s here).
      putLock(s, text, 0)
      const young = await round(s, children)
      assert.equal(young.lines.length, 6, name)
      // The reason names the refresh time of these waiters (1 s), not the age of the lock (12 s): they gave up at their
      // own time and did not wait for the age. No clock bound is needed, and a busy runner cannot break the proof.
      for (const l of young.lines)
        assert.match(
          l.text,
          /another toolscript-mcp process is refreshing.*did not finish in 1 s.*No login is needed/,
          `${name}: ${l.text}`,
        )
      assert.equal(requests(fake) - before, 0, name)
      // The proof by order: a waiter that took the lock over would have removed this file, so the same text is still
      // there only when no waiter took it over before its refresh time ended. The text above does not prove it.
      assert.equal(fs.readFileSync(`${s.files[0]}.lock`, 'utf8'), text, `${name}: no waiter took the young lock over`)
      // The old phase: one process takes over and refreshes while the others wait for it, and on a slow machine
      // that takes more than the 1 s that the young phase gives a waiter. So these waiters wait longer.
      putLock(s, text, 600)
      const old = await round(s, takers)
      assert.deepEqual(
        old.lines.map(l => l.text),
        Array(6).fill(PONG),
        name,
      )
      assert.equal(requests(fake) - before, 1, name)
      assert.equal(revocations(s), 0, name)
      assert.deepEqual(s.leftovers(), [], name)
    }
    // A folder where the lock goes: no crash, and no hang past the time of each waiter.
    const lock = `${s.files[0]}.lock`
    fs.mkdirSync(lock)
    const aged = new Date(Date.now() - 600_000)
    fs.utimesSync(lock, aged, aged)
    const folder = await round(s, children)
    assert.equal(folder.lines.length, 6, 'a folder')
    // No crash is all that this case proves. The deadline of a waiter is proven in tests/oauthlock.test.ts.
    for (const l of folder.lines) assert.match(l.text, /another toolscript-mcp process is refreshing/, l.text)
    assert.ok(
      children.every(c => c.proc.exitCode === null),
      'a process died',
    )
    await stop(children)
    await stop(takers)
  })
})

describe('a holder that dies', { timeout: 180_000 }, () => {
  test('SIGKILL while the endpoint holds the answer: the others take over with no wait for the age, with one more request', async () => {
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
    // The lock holds a dead pid, so it is stale at once. The refresh time of the others is 20 s, and the age is 31 s: a
    // wait for the age would fail their refresh, so 5 answers of `pong` prove the takeover with no wait for the age.
    await until('the second request', () => requests(fake) === 2)
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
