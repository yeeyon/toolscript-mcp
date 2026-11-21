// The router of a shared child process (src/core/mux.ts): one test for each case of the table, then a property test
// with a seeded generator. The router is pure, so the tests call it with messages and read the effects.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DIED_CODE, createRouter, type Effect, type Router } from '../src/core/mux.ts'

/** A frozen copy: a router that changes an input message throws in strict mode. */
const frozen = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) frozen(v)
  return Object.freeze(value)
}

const call = (id: unknown, params: unknown = {}) => frozen({ jsonrpc: '2.0', id, method: 'tools/call', params })
const reply = (id: unknown, result: unknown = {}) => frozen({ jsonrpc: '2.0', id, result })
const note = (method: string, params?: unknown) =>
  frozen({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) })

const toChild = (effects: readonly Effect[]) =>
  effects.flatMap(e => (e.to === 'child' ? [e.msg as Record<string, any>] : []))
const toLink = (effects: readonly Effect[], link: string) =>
  effects.flatMap(e => (e.to === 'link' && e.link === link ? [e.msg as Record<string, any>] : []))

/** A router with these links attached. */
const rig = (...names: string[]): Router => {
  const router = createRouter()
  for (const name of names) router.attach(name)
  return router
}

/** Sends a request of a link and returns the id that the child saw. */
const send = (router: Router, link: string, id: unknown, params?: unknown): number => {
  const [forwarded] = toChild(router.fromLink(link, call(id, params)))
  assert.ok(forwarded, 'the request went to the child')
  return forwarded.id as number
}

describe('mux table', () => {
  test('(a) a request goes to the child with a fresh numeric id that is never reused', () => {
    const router = rig('a', 'b')
    const seen = new Set<number>()
    for (let i = 0; i < 5; i++) {
      const rid = send(router, i % 2 === 0 ? 'a' : 'b', 7)
      assert.equal(typeof rid, 'number')
      assert.ok(!seen.has(rid), 'fresh')
      seen.add(rid)
      router.fromChild(reply(rid))
    }
    const forwarded = toChild(router.fromLink('a', call(1, { name: 'x' })))[0]!
    assert.equal(forwarded.method, 'tools/call')
    assert.deepEqual(forwarded.params, { name: 'x' })
    assert.ok(!seen.has(forwarded.id))
  })

  test('(b) a response goes to the one link that asked, with its own id, once', () => {
    const router = rig('a', 'b')
    const num = send(router, 'a', 7)
    const str = send(router, 'b', '7')
    const out = router.fromChild(reply(str, { v: 1 }))
    assert.deepEqual(out, [{ to: 'link', link: 'b', msg: { jsonrpc: '2.0', id: '7', result: { v: 1 } } }])
    const first = router.fromChild(reply(num, { v: 2 }))
    assert.equal(toLink(first, 'a')[0]!.id, 7)
    assert.equal(typeof toLink(first, 'a')[0]!.id, 'number')
    assert.deepEqual(router.fromChild(reply(num, { v: 3 })), [])
    assert.deepEqual(router.fromChild(reply(str)), [])
    assert.equal(router.open(), 0)
  })

  test('(b) an error response goes back the same way', () => {
    const router = rig('a')
    const rid = send(router, 'a', 'x')
    const out = router.fromChild(frozen({ jsonrpc: '2.0', id: rid, error: { code: -1, message: 'no' } }))
    assert.deepEqual(toLink(out, 'a'), [{ jsonrpc: '2.0', id: 'x', error: { code: -1, message: 'no' } }])
  })

  test('(c) 7 and "7", and the same id on two links, are 4 open requests', () => {
    const router = rig('a', 'b')
    const ids = [send(router, 'a', 7), send(router, 'a', '7'), send(router, 'b', 7), send(router, 'b', '7')]
    assert.equal(new Set(ids).size, 4)
    assert.equal(router.open(), 4)
    const want: [string, unknown][] = [
      ['a', 7],
      ['a', '7'],
      ['b', 7],
      ['b', '7'],
    ]
    for (const i of [3, 0, 2, 1]) {
      const out = router.fromChild(reply(ids[i]!))
      assert.equal(out.length, 1)
      const [link, id] = want[i]!
      const got = toLink(out, link)
      assert.equal(got.length, 1)
      assert.ok(got[0]!.id === id && typeof got[0]!.id === typeof id)
    }
    assert.equal(router.open(), 0)
  })

  test('(c) no key joins a link and an id: a string id that holds a separator collides with nothing', () => {
    const router = rig('a', 'a:1', 'a|1', 'a,1')
    for (const sep of [':', '|', ',', '/', '\u0000', '"', '","']) {
      const left = createRouter()
      for (const link of [`a${sep}1`, 'a', `a${sep}`, 'a1']) left.attach(link)
      const first = send(left, 'a', `1${sep}b`)
      const second = send(left, `a${sep}1`, 'b')
      const third = send(left, `a${sep}`, `1${sep}b`)
      assert.equal(left.open(), 3)
      assert.equal(toLink(left.fromChild(reply(second)), `a${sep}1`)[0]!.id, 'b')
      assert.equal(toLink(left.fromChild(reply(first)), 'a')[0]!.id, `1${sep}b`)
      assert.equal(toLink(left.fromChild(reply(third)), `a${sep}`)[0]!.id, `1${sep}b`)
    }
    assert.equal(router.open(), 0)
  })

  test('(c) a cancel of 7 does not touch "7" of the same link', () => {
    const router = rig('a')
    const num = send(router, 'a', 7)
    const str = send(router, 'a', '7')
    const out = router.fromLink('a', note('notifications/cancelled', { requestId: '7' }))
    assert.equal(toChild(out)[0]!.params.requestId, str)
    assert.equal(router.fromChild(reply(str)).length, 0)
    assert.equal(toLink(router.fromChild(reply(num)), 'a')[0]!.id, 7)
  })

  test('(d) a progress token is replaced, and the progress goes back to its link with the original token', () => {
    const router = rig('a', 'b')
    const input = call(1, { _meta: { progressToken: 7, other: 1 }, name: 'x' })
    const [forwarded] = toChild(router.fromLink('a', input))
    assert.equal(typeof forwarded!.params._meta.progressToken, 'number')
    assert.notEqual(forwarded!.params._meta.progressToken, 7)
    assert.equal(forwarded!.params._meta.other, 1)
    assert.equal(forwarded!.params.name, 'x')
    const [other] = toChild(router.fromLink('b', call(1, { _meta: { progressToken: 7 } })))
    assert.notEqual(other!.params._meta.progressToken, forwarded!.params._meta.progressToken)
    const [str] = toChild(router.fromLink('b', call(2, { _meta: { progressToken: '7' } })))

    const out = router.fromChild(
      note('notifications/progress', { progressToken: forwarded!.params._meta.progressToken, progress: 5 }),
    )
    assert.deepEqual(out, [
      {
        to: 'link',
        link: 'a',
        msg: { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 7, progress: 5 } },
      },
    ])
    const text = router.fromChild(note('notifications/progress', { progressToken: str!.params._meta.progressToken }))
    assert.equal(toLink(text, 'b')[0]!.params.progressToken, '7')
    assert.deepEqual(router.fromChild(note('notifications/progress', { progressToken: 'nope' })), [])
    assert.deepEqual(router.fromChild(note('notifications/progress', { progressToken: 99_999 })), [])
    router.fromChild(reply(forwarded!.id))
    const late = note('notifications/progress', { progressToken: forwarded!.params._meta.progressToken })
    assert.deepEqual(router.fromChild(late), [], 'after the response')
  })

  test('(d) progress after a cancel is dropped', () => {
    const router = rig('a')
    const [forwarded] = toChild(router.fromLink('a', call(1, { _meta: { progressToken: 'p' } })))
    router.fromLink('a', note('notifications/cancelled', { requestId: 1 }))
    const late = note('notifications/progress', { progressToken: forwarded!.params._meta.progressToken })
    assert.deepEqual(router.fromChild(late), [])
  })

  const init = (id: unknown = 1) =>
    frozen({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 'v', capabilities: { roots: {} } } })
  const initialized = note('notifications/initialized')

  test('(e) the first initialize goes to the child with no capabilities, a waiting one gets the same answer', () => {
    const router = rig('a', 'b', 'c')
    const sent = toChild(router.fromLink('a', init(1)))
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.method, 'initialize')
    assert.deepEqual(sent[0]!.params, { protocolVersion: 'v', capabilities: {} })
    assert.deepEqual(router.fromLink('b', init('x')), [])
    assert.deepEqual(router.fromLink('c', init(5)), [])
    assert.equal(router.open(), 3)
    const out = router.fromChild(reply(sent[0]!.id, { protocolVersion: 'v', serverInfo: { name: 'fake' } }))
    assert.deepEqual(
      out.map(e => (e as { link: string }).link),
      ['a', 'b', 'c'],
    )
    assert.deepEqual(toLink(out, 'b')[0], {
      jsonrpc: '2.0',
      id: 'x',
      result: { protocolVersion: 'v', serverInfo: { name: 'fake' } },
    })
    assert.equal(toLink(out, 'c')[0]!.id, 5)
    assert.equal(router.open(), 0)
  })

  test('(e) after a result, later initializes are answered from the cache with nothing to the child', () => {
    const router = rig('a', 'b')
    const [first] = toChild(router.fromLink('a', init()))
    router.fromChild(reply(first!.id, { v: 1 }))
    const out = router.fromLink('b', init(9))
    assert.deepEqual(out, [{ to: 'link', link: 'b', msg: { jsonrpc: '2.0', id: 9, result: { v: 1 } } }])
    assert.equal(router.open(), 0)
  })

  test('(e) after an error nothing is cached and the next initialize is forwarded', () => {
    const router = rig('a', 'b')
    const [first] = toChild(router.fromLink('a', init()))
    assert.deepEqual(router.fromLink('b', init(2)), [])
    const out = router.fromChild(frozen({ jsonrpc: '2.0', id: first!.id, error: { code: -1, message: 'no' } }))
    assert.deepEqual(toLink(out, 'a'), [{ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'no' } }])
    assert.deepEqual(toLink(out, 'b'), [{ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'no' } }])
    const again = toChild(router.fromLink('a', init(3)))
    assert.equal(again.length, 1)
    assert.notEqual(again[0]!.id, first!.id)
  })

  test('(e) a cancel of a waiting initialize goes to the child only when no link still waits', () => {
    const router = rig('a', 'b')
    const [first] = toChild(router.fromLink('a', init(1)))
    router.fromLink('b', init(1))
    assert.deepEqual(router.fromLink('a', note('notifications/cancelled', { requestId: 1 })), [])
    const out = router.fromLink('b', note('notifications/cancelled', { requestId: 1 }))
    assert.equal(toChild(out)[0]!.params.requestId, first!.id)
    assert.equal(router.open(), 0)
  })

  test('(f) notifications/initialized goes to the child once, after the first result', () => {
    const router = rig('a', 'b')
    assert.deepEqual(router.fromLink('a', initialized), [], 'before a result')
    const [first] = toChild(router.fromLink('a', init()))
    router.fromChild(reply(first!.id))
    assert.deepEqual(router.fromLink('a', initialized), [{ to: 'child', msg: initialized }])
    assert.deepEqual(router.fromLink('b', initialized), [])
    assert.deepEqual(router.fromLink('a', initialized), [])
  })

  test('(g) tools/list_changed goes to each attached link once, and other child notices are dropped', () => {
    const router = rig('a', 'b', 'c')
    router.detach('c')
    const out = router.fromChild(note('notifications/tools/list_changed'))
    assert.deepEqual(
      out.map(e => (e as { link: string }).link),
      ['a', 'b'],
    )
    for (const method of [
      'notifications/message',
      'notifications/resources/list_changed',
      'notifications/cancelled',
      'x',
    ])
      assert.deepEqual(router.fromChild(note(method, { requestId: 1 })), [], method)
  })

  test('(h) a request of the child: ping gets {}, any other gets -32601, and no link sees it', () => {
    const router = rig('a')
    assert.deepEqual(router.fromChild(frozen({ jsonrpc: '2.0', id: 4, method: 'ping' })), [
      { to: 'child', msg: { jsonrpc: '2.0', id: 4, result: {} } },
    ])
    for (const method of ['roots/list', 'sampling/createMessage', 'elicitation/create']) {
      const out = router.fromChild(frozen({ jsonrpc: '2.0', id: 'q', method }))
      assert.equal(out.length, 1)
      assert.equal(out[0]!.to, 'child')
      assert.equal(toChild(out)[0]!.id, 'q')
      assert.equal(toChild(out)[0]!.error.code, -32601)
    }
  })

  test('(i) ping from a link is answered by the router', () => {
    const router = rig('a')
    const out = router.fromLink('a', frozen({ jsonrpc: '2.0', id: 'p', method: 'ping' }))
    assert.deepEqual(out, [{ to: 'link', link: 'a', msg: { jsonrpc: '2.0', id: 'p', result: {} } }])
  })

  test('(j) a cancel closes the request: the child hears the router id and the link gets nothing more', () => {
    const router = rig('a', 'b')
    const mine = send(router, 'a', 7)
    const theirs = send(router, 'b', 7)
    const out = router.fromLink('a', note('notifications/cancelled', { requestId: 7, reason: 'user' }))
    assert.deepEqual(out, [
      {
        to: 'child',
        msg: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: mine, reason: 'user' } },
      },
    ])
    assert.deepEqual(router.fromChild(reply(mine)), [], 'a late response')
    assert.equal(router.open(), 1)
    assert.deepEqual(router.fromLink('a', note('notifications/cancelled', { requestId: 7 })), [], 'again')
    assert.equal(toLink(router.fromChild(reply(theirs)), 'b')[0]!.id, 7)
  })

  test('(j) a cancel of an id that the link does not hold, also one of another link, has no effect', () => {
    const router = rig('a', 'b')
    send(router, 'b', 7)
    for (const requestId of [7, '7', 99, null, {}, [1]])
      assert.deepEqual(router.fromLink('a', note('notifications/cancelled', { requestId })), [])
    assert.equal(router.open(), 1)
  })

  test('(k) a detach cancels each open request of the link, and no later effect names it', () => {
    const router = rig('a', 'b')
    const first = send(router, 'a', 1)
    const second = send(router, 'a', '1')
    const other = send(router, 'b', 1)
    const [initial] = toChild(router.fromLink('a', init(3)))
    const out = router.detach('a')
    assert.deepEqual(
      toChild(out).map(m => m.params.requestId),
      [first, second, initial!.id],
    )
    assert.ok(out.every(e => e.to === 'child'))
    assert.equal(router.open(), 1)
    for (const rid of [first, second]) assert.deepEqual(router.fromChild(reply(rid)), [])
    assert.deepEqual(router.fromChild(reply(initial!.id)), [])
    assert.deepEqual(router.fromLink('a', call(1)), [])
    assert.deepEqual(
      router.fromChild(note('notifications/tools/list_changed')).map(e => (e as { link: string }).link),
      ['b'],
    )
    assert.equal(toLink(router.fromChild(reply(other)), 'b')[0]!.id, 1)
    assert.equal(router.detach('a').length, 0)
  })

  test('(k) the cache stays after a detach', () => {
    const router = rig('a', 'b')
    const [first] = toChild(router.fromLink('a', init()))
    router.fromChild(reply(first!.id, { v: 1 }))
    router.detach('a')
    assert.equal(toLink(router.fromLink('b', init(2)), 'b')[0]!.result.v, 1)
  })

  test('(l) a death gives one error to each open request and each waiting initialize, then nothing', () => {
    const router = rig('a', 'b')
    send(router, 'a', 1)
    send(router, 'b', '1')
    router.fromLink('a', init(8))
    router.fromLink('b', init(9))
    const out = router.died()
    const errs = out.map(e => ({ link: (e as { link: string }).link, id: (e.msg as { id: unknown }).id }))
    assert.deepEqual(errs, [
      { link: 'a', id: 1 },
      { link: 'b', id: '1' },
      { link: 'a', id: 8 },
      { link: 'b', id: 9 },
    ])
    assert.ok(out.every(e => (e.msg as { error: { code: number } }).error.code === DIED_CODE))
    assert.equal(router.open(), 0)
    assert.deepEqual(router.died(), [])
    assert.deepEqual(router.fromLink('a', call(1)), [])
    assert.deepEqual(router.fromChild(reply(1)), [])
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed')), [])
    assert.deepEqual(router.attach('c'), [])
    assert.deepEqual(router.fromLink('c', call(1)), [])
    assert.deepEqual(router.detach('a'), [])
  })

  test('(m) a response with an unknown id, a string id or a second response is dropped', () => {
    const router = rig('a')
    const rid = send(router, 'a', 1)
    for (const id of [999, String(rid), '1', null, 1.5, -1, {}, [rid]])
      assert.deepEqual(router.fromChild(frozen({ jsonrpc: '2.0', id, result: {} })), [], String(id))
    assert.equal(router.open(), 1)
    assert.equal(router.fromChild(reply(rid)).length, 1)
    assert.deepEqual(router.fromChild(reply(rid)), [])
  })

  test('(n) a message that is not a message throws nothing and reaches no other link', () => {
    const router = rig('a', 'b')
    const junk: unknown[] = [
      null,
      undefined,
      0,
      7,
      'x',
      true,
      [],
      [1, 2],
      {},
      { jsonrpc: '2.0' },
      { id: 1 },
      { method: 5, id: 1 },
      { method: 'tools/call', id: {} },
      { method: 'tools/call', id: 1, params: 'x' },
      { method: 'tools/call', id: 2, params: [1] },
      { method: 'tools/call', id: 3, params: null },
      { method: 'tools/call', id: 4, params: { _meta: 5 } },
      { method: 'tools/call', id: 5, params: { _meta: { progressToken: {} } } },
      { method: 'notifications/cancelled', params: 5 },
      { method: 'notifications/cancelled' },
      JSON.parse('{"__proto__": {"method": "tools/call", "id": 1}}'),
      JSON.parse('{"method": "tools/call", "id": 6, "params": {"__proto__": {"_meta": {"progressToken": 1}}}}'),
      JSON.parse('{"method": "tools/call", "id": 7, "__proto__": {"x": 1}, "params": {"_meta": {"__proto__": 1}}}'),
    ]
    for (const msg of junk) {
      for (const effects of [router.fromLink('a', msg), router.fromChild(msg), router.fromLink('nobody', msg)]) {
        for (const e of effects) assert.ok(e.to === 'child' || e.link === 'a', 'no effect on another link')
      }
    }
    assert.equal(({} as Record<string, unknown>).method, undefined, 'no prototype was changed')
    assert.equal(router.fromChild(frozen({ id: 1, result: {} })).length >= 0, true)
  })
})

/** A small seeded generator (mulberry32): a failure prints its seed. */
const generator = (seed: number) => {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    below: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  }
}

type Req = {
  readonly link: string
  readonly id: string | number
  readonly payload: string
  readonly rid: number
  readonly token?: { sent: number; original: string | number }
  /** The router must answer it: not cancelled, detached or ended. */
  live: boolean
  /** The child has not answered it yet. */
  pending: boolean
}

const IDS: (string | number)[] = [1, 2, 3, '1', '2', 'a', '1:2', '2:1']
const TOKENS: (string | number)[] = [1, 2, '1', 'p']

/** One run of the property test. Throws with the seed in the message. */
const play = (seed: number, steps: number): void => {
  const rnd = generator(seed)
  const router = createRouter()
  const reqs: Req[] = []
  const attached: string[] = []
  const used = new Set<number>()
  let links = 0
  let dead = false
  const fresh = () => {
    const name = `L${links++}`
    attached.push(name)
    router.attach(name)
  }
  const fail = (what: string): never => assert.fail(`seed ${seed}: ${what}`)
  const check = (cond: unknown, what: string) => cond || fail(what)
  const liveOf = (link: string) => reqs.filter(r => r.live && r.link === link)
  const noLinkEffects = (effects: readonly Effect[], what: string) =>
    check(
      effects.every(e => e.to === 'child'),
      `${what}: a message to a link`,
    )
  for (let i = 0, n = 2 + rnd.below(5); i < n; i++) fresh()

  const step = (): void => {
    if (dead) {
      const link = rnd.pick(attached.length > 0 ? attached : ['L0'])
      const quiet = [
        router.fromLink(link, call(1)),
        router.fromChild(reply(1)),
        router.fromChild(note('notifications/tools/list_changed')),
        router.detach(link),
      ]
      return void check(
        quiet.every(o => o.length === 0),
        'after a death every input gives no effect',
      )
    }
    const op = rnd.below(100)
    if (op < 35) {
      if (attached.length === 0) return
      const link = rnd.pick(attached)
      const id = rnd.pick(IDS)
      if (liveOf(link).some(r => r.id === id && typeof r.id === typeof id)) return
      const payload = `${link}|${typeof id}|${String(id)}|${reqs.length}`
      const token = rnd.chance(0.4) ? rnd.pick(TOKENS) : undefined
      const params = { payload, ...(token !== undefined && { _meta: { progressToken: token } }) }
      const out = router.fromLink(link, call(id, params))
      check(out.length === 1 && out[0]!.to === 'child', 'a request gives one message to the child')
      const sent = out[0]!.msg as { id: number; params: { payload: string; _meta?: { progressToken: number } } }
      check(typeof sent.id === 'number' && !used.has(sent.id), '(4) ids to the child are unique')
      used.add(sent.id)
      check(sent.params.payload === payload, 'the payload is forwarded')
      const tok = sent.params._meta?.progressToken
      check((token === undefined) === (tok === undefined), 'a progress token is replaced, not added or dropped')
      reqs.push({
        link,
        id,
        payload,
        rid: sent.id,
        ...(tok !== undefined && { token: { sent: tok, original: token! } }),
        live: true,
        pending: true,
      })
    } else if (op < 55) {
      const pending = reqs.filter(r => r.pending)
      if (pending.length === 0) return
      const r = rnd.pick(pending)
      r.pending = false
      const out = router.fromChild(reply(r.rid, { echo: r.payload }))
      if (!r.live) return void check(out.length === 0, 'nothing after a cancel or detach')
      check(out.length === 1, '(1) an answered request reaches its link once')
      const e = out[0]!
      check(e.to === 'link' && e.link === r.link, '(2) the answer goes to the link that asked')
      const msg = e.msg as { id: unknown; result: { echo: string } }
      check(msg.id === r.id && typeof msg.id === typeof r.id, '(1) the answer has its own id and type')
      check(msg.result.echo === r.payload, '(1) the answer has its own payload')
      r.live = false
    } else if (op < 65) {
      const withToken = reqs.filter(r => r.pending && r.token !== undefined)
      if (withToken.length === 0) return
      const r = rnd.pick(withToken)
      const out = router.fromChild(note('notifications/progress', { progressToken: r.token!.sent, progress: 1 }))
      if (!r.live) return void check(out.length === 0, 'no progress after a cancel or detach')
      check(out.length === 1 && out[0]!.to === 'link' && out[0]!.link === r.link, '(2) progress goes to its link only')
      const tok = (out[0]!.msg as { params: { progressToken: unknown } }).params.progressToken
      check(tok === r.token!.original && typeof tok === typeof r.token!.original, 'progress has the original token')
    } else if (op < 75) {
      if (attached.length === 0) return
      const link = rnd.pick(attached)
      const mine = liveOf(link)
      const id = mine.length > 0 && rnd.chance(0.7) ? rnd.pick(mine).id : rnd.pick(IDS)
      const r = mine.find(x => x.id === id && typeof x.id === typeof id)
      const out = router.fromLink(link, note('notifications/cancelled', { requestId: id }))
      noLinkEffects(out, 'a cancel')
      if (r === undefined) return
      r.live = false
      check(out.length === 1, 'a cancel of an open request goes to the child once')
      check(
        (out[0]!.msg as { params: { requestId: number } }).params.requestId === r.rid,
        'the cancel names the router id',
      )
    } else if (op < 80) {
      if (attached.length === 0) return
      const link = rnd.pick(attached)
      const mine = liveOf(link)
      const out = router.detach(link)
      noLinkEffects(out, 'a detach')
      check(out.length === mine.length, 'a detach cancels each open request of the link')
      for (const r of mine) r.live = false
      attached.splice(attached.indexOf(link), 1)
    } else if (op < 85) {
      fresh()
    } else if (op < 90) {
      const out = router.fromChild(note('notifications/tools/list_changed'))
      const names = out.map(e => (e.to === 'link' ? e.link : ''))
      check(
        out.length === attached.length && [...names].sort().join() === [...attached].sort().join(),
        '(6) a list change reaches each attached link once',
      )
    } else if (op < 97) {
      const junk: unknown[] = [
        null,
        7,
        'x',
        [],
        {},
        { id: 1 },
        { id: '1', result: {} },
        { id: 99_999, result: {} },
        { method: 'notifications/progress', params: { progressToken: 'nope' } },
        { method: 'notifications/progress', params: { progressToken: 99_999 } },
        { method: 'notifications/message', params: {} },
        JSON.parse('{"__proto__": {"id": 1, "result": {}}}'),
        ...(reqs.length > 0 ? [{ id: String(rnd.pick(reqs).rid), result: {} }] : []),
      ]
      check(router.fromChild(rnd.pick(junk)).length === 0, 'a junk message of the child has no effect')
    } else if (!dead && rnd.chance(0.15)) {
      dead = true
      const open = reqs.filter(r => r.live)
      const out = router.died()
      check(out.length === open.length, '(5) one error for each open request')
      const seen = new Set<string>()
      for (const e of out) {
        const id = (e.msg as { id: unknown }).id
        const key = e.to === 'link' ? JSON.stringify([e.link, typeof id, id]) : ''
        check(e.to === 'link' && !seen.has(key), '(5) each error goes to a link, once')
        seen.add(key)
        check(
          open.some(r => r.link === (e as { link: string }).link && r.id === id && typeof r.id === typeof id),
          '(5) the error goes to an open request',
        )
      }
      for (const r of reqs) r.live = false
    }
    check(router.open() === reqs.filter(r => r.live).length, 'the open count matches the model')
  }

  for (let i = 0; i < steps; i++) step()
  // Answer what the child still owes, then the count must be 0.
  for (const r of reqs.filter(x => x.pending)) {
    r.pending = false
    const out = router.fromChild(reply(r.rid, { echo: r.payload }))
    check(out.length === (r.live ? 1 : 0), 'the last answers')
    r.live = false
  }
  check(router.open() === 0, '(7) the open count ends at 0')
  for (const link of [...attached]) router.detach(link)
  check(router.open() === 0, '(7) the open count is 0 after the detaches')
}

describe('mux property', () => {
  test('250 seeds of 200 steps: no message crosses a link, none follows a cancel, every count ends at 0', () => {
    const started = performance.now()
    for (let seed = 1; seed <= 250; seed++) play(seed, 200)
    assert.ok(performance.now() - started < 3000, 'under 3 s')
  })
})
