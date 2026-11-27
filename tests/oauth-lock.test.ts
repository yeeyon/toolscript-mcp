// The lock of an OAuth refresh across processes: rounds of 2 and 6 processes over one and two stores, slow and silent endpoints.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PONG, cleanup, until, setup, group, round, requests, revocations, stop, type Fake } from './oauth-lock-util.ts'

after(cleanup)

// The races of a takeover are proven in tests/oauthlock.test.ts with no process. Here a round is the plain contention
// of N live processes, so a few rounds show it.
const ROUNDS = 4

describe('processes that share one store', { timeout: 180_000 }, () => {
  for (const n of [2, 6]) {
    test(`${n} processes, ${ROUNDS} rounds: one refresh request each round, no revocation, the store keeps the newest tokens`, async () => {
      const s = await setup()
      const [fake] = s.fakes as [Fake]
      const children = await group(s, n)
      for (let i = 0; i < ROUNDS; i++) {
        const before = requests(fake)
        const { lines } = await round(s, children)
        assert.equal(revocations(s), 0, `round ${i}: the server revoked the grant ${revocations(s)} times`)
        assert.deepEqual(
          lines.map(l => l.text),
          Array(n).fill(PONG),
          `round ${i}`,
        )
        assert.equal(requests(fake) - before, 1, `round ${i}: one refresh request`)
        assert.equal(s.storedRefresh(), fake.seen.lastRefresh, `round ${i}: the store holds the newest tokens`)
        assert.deepEqual(s.leftovers(), [], `round ${i}: a lock file stayed`)
      }
      await stop(children)
    })
  }

  test('a call with a working token sends no refresh and makes no lock file', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 2)
    for (const c of children) c.go()
    await Promise.all(children.map(c => c.ended()))
    assert.equal(requests(fake), 0)
    assert.deepEqual(s.leftovers(), [])
    await stop(children)
  })

  test('6 processes over 2 stores: one request for each store, and a store never waits for the other', async () => {
    const s = await setup(2)
    const [a, b] = s.fakes as [Fake, Fake]
    const children = await group(s, 6)
    for (let i = 0; i < 3; i++) {
      const before = [requests(a), requests(b)]
      const { lines } = await round(s, children)
      assert.deepEqual(
        lines.map(l => l.text),
        Array(12).fill(PONG),
      )
      assert.deepEqual([requests(a) - before[0]!, requests(b) - before[1]!], [1, 1])
    }
    assert.equal(revocations(s), 0)
    let release = () => {}
    a.change.gate = new Promise<void>(resolve => (release = resolve))
    for (const f of s.fakes) f.expire()
    for (const c of children) c.go()
    await until(
      'the 6 calls of store b',
      () => children.flatMap(c => c.lines()).filter(l => l.key === 'b').length === 6,
    )
    assert.equal(children.flatMap(c => c.lines()).filter(l => l.key === 'a').length, 0, 'store a waits for its answer')
    release()
    await Promise.all(children.map(c => c.ended()))
    assert.deepEqual(
      children.flatMap(c => c.lines().map(l => l.text)),
      Array(12).fill(PONG),
    )
    assert.equal(revocations(s), 0)
    await stop(children)
  })

  test('an endpoint that answers after half of the refresh time gets one request, and all 6 go on', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 6, 3000)
    let release = () => {}
    fake.change.gate = new Promise<void>(resolve => (release = resolve))
    setTimeout(() => release(), 1500)
    const { lines } = await round(s, children)
    assert.deepEqual(
      lines.map(l => l.text),
      Array(6).fill(PONG),
    )
    assert.equal(requests(fake), 1)
    assert.equal(revocations(s), 0)
    await stop(children)
  })

  test('an endpoint that never answers fails all 6 within the refresh time, and the next use goes on', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 6, 2000)
    fake.change.stallRefreshes = true
    const failed = await round(s, children)
    assert.equal(failed.lines.length, 6)
    // `requests(fake) <= 2` below proves that the waiters did not send one request after another. The bound of the time
    // that each waiter had is proven in tests/oauthlock.test.ts.
    for (const l of failed.lines)
      assert.match(l.text, /could not refresh the OAuth token: .*No login is needed/, l.text)
    assert.ok(requests(fake) <= 2, `${requests(fake)} requests`)
    assert.deepEqual(s.leftovers(), [])
    fake.change.stallRefreshes = false
    const before = requests(fake)
    const { lines } = await round(s, children)
    assert.deepEqual(
      lines.map(l => l.text),
      Array(6).fill(PONG),
    )
    assert.equal(requests(fake) - before, 1)
    assert.equal(revocations(s), 0)
    await stop(children)
  })

  test('the holder gets 503: it fails with the reason, and a waiter may send its own request', async () => {
    const s = await setup()
    const [fake] = s.fakes as [Fake]
    const children = await group(s, 3, 5000)
    fake.change.refreshAnswer = { status: 503, type: 'text/plain', body: 'down' }
    const { lines } = await round(s, children)
    for (const l of lines)
      assert.match(l.text, /could not refresh the OAuth token: HTTP 503\. No login is needed/, l.text)
    assert.ok(requests(fake) <= 3)
    fake.change.refreshAnswer = undefined
    const { lines: after } = await round(s, children)
    assert.deepEqual(
      after.map(l => l.text),
      Array(3).fill(PONG),
    )
    assert.equal(revocations(s), 0)
    await stop(children)
  })
})
