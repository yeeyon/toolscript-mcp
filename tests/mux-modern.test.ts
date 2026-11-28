// The router on a child of the 2026-07-28 era (src/core/mux.ts, muxmodern.ts): the era rule, rules 1 to 7 of the bar, and a
// property test with 2 to 4 links. The router is pure, so the tests call it with messages and read the effects.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DIED_CODE, createRouter, type Effect, type Router } from '../src/core/mux.ts'

const STAMP = 'io.modelcontextprotocol/subscriptionId'
const frozen = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) frozen(v)
  return Object.freeze(value)
}
const req = (id: unknown, method: string, params?: unknown) =>
  frozen({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })
const reply = (id: unknown, result: unknown = {}) => frozen({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code = -32603) => frozen({ jsonrpc: '2.0', id, error: { code, message: 'no' } })
const note = (method: string, params?: unknown) =>
  frozen({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) })
const MODERN = { supportedVersions: ['2026-07-28'], capabilities: {} }

type M = Record<string, any>
// Every router id that went to the child, so a refusal can be checked against all of them.
const seenRids = new Set<number>()
const toChild = (effects: readonly Effect[]) =>
  effects.flatMap(e => {
    if (e.to !== 'child') return []
    const m = e.msg as M
    if (typeof m.id === 'number') seenRids.add(m.id)
    return [m]
  })
const toLink = (effects: readonly Effect[], link: string) =>
  effects.flatMap(e => (e.to === 'link' && e.link === link ? [e.msg as M] : []))
const rig = (...names: string[]): Router => {
  const router = createRouter()
  for (const name of names) router.attach(name)
  return router
}
/** A router whose child answered a discover with a modern result, so its era is modern. */
const modern = (...names: string[]): Router => {
  const router = rig(...names)
  const [probe] = toChild(router.fromLink(names[0]!, req('probe', 'server/discover')))
  router.fromChild(reply(probe!.id, MODERN))
  assert.equal(router.era(), 'modern')
  return router
}
const send = (router: Router, link: string, id: unknown, method = 'tools/call', params?: unknown): number => {
  const [m] = toChild(router.fromLink(link, req(id, method, params)))
  assert.ok(m, `${method} reached the child`)
  return m.id as number
}
const refusal = (effects: readonly Effect[], link: string, id: unknown, code: number) => {
  assert.deepEqual(toChild(effects), [])
  const [m] = toLink(effects, link)
  assert.equal(m?.id, id)
  assert.equal(m?.error.code, code)
  for (const rid of seenRids)
    assert.ok(!new RegExp(`\\b${rid}\\b`).test(String(m?.error.message)), `router id ${rid} in the text`)
}

describe('the era', () => {
  test('is undefined at the start; a modern discover result fixes it, and the answer goes back to its link', () => {
    const router = rig('a')
    assert.equal(router.era(), undefined)
    const rid = send(router, 'a', 1, 'server/discover')
    const out = router.fromChild(reply(rid, { ...MODERN, supportedVersions: ['2025-06-18', '2027-01-15'] }))
    assert.deepEqual(out, [
      {
        to: 'link',
        link: 'a',
        msg: { jsonrpc: '2.0', id: 1, result: { ...MODERN, supportedVersions: ['2025-06-18', '2027-01-15'] } },
      },
    ])
    assert.equal(router.era(), 'modern')
  })

  test('a probe error fixes nothing, and the link then opens with initialize: legacy', () => {
    const router = rig('a')
    const rid = send(router, 'a', 1, 'server/discover')
    const out = router.fromChild(fail(rid, -32601))
    assert.deepEqual(toLink(out, 'a'), [{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } }])
    assert.equal(router.era(), undefined)
    const [init] = toChild(
      router.fromLink('a', req(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: { x: 1 } })),
    )
    assert.equal(init!.method, 'initialize')
    assert.equal(router.era(), 'legacy')
    assert.deepEqual(init!.params.capabilities, {})
  })

  test('a result that is not a discover result fixes nothing: no list, a list of old dates, a bad date, a string, an error with a list', () => {
    for (const result of [
      {},
      { supportedVersions: 'x' },
      { supportedVersions: ['2025-06-18', '2026-07-27'] },
      { supportedVersions: ['2099'] },
      { supportedVersions: [5, null, {}] },
      'x',
      null,
      { garbage: true },
    ]) {
      const router = rig('a')
      const rid = send(router, 'a', 1, 'server/discover')
      router.fromChild(reply(rid, result))
      assert.equal(router.era(), undefined, JSON.stringify(result))
    }
    const router = rig('a')
    const rid = send(router, 'a', 1, 'server/discover')
    router.fromChild(frozen({ jsonrpc: '2.0', id: rid, result: MODERN, error: { code: 1, message: 'x' } }))
    assert.equal(router.era(), undefined)
    // Only a discover can fix it: another method with such a result does not.
    const other = rig('a')
    other.fromChild(reply(send(other, 'a', 1, 'tools/list'), MODERN))
    assert.equal(other.era(), undefined)
  })

  test('two links that probe at once: the first modern result fixes the era, the second answer still goes to its link', () => {
    const router = rig('a', 'b')
    const ra = send(router, 'a', 1, 'server/discover')
    const rb = send(router, 'b', 1, 'server/discover')
    assert.notEqual(ra, rb)
    router.fromChild(reply(rb, MODERN))
    assert.equal(router.era(), 'modern')
    assert.deepEqual(toLink(router.fromChild(reply(ra, MODERN)), 'a'), [{ jsonrpc: '2.0', id: 1, result: MODERN }])
    assert.equal(router.open(), 0)
  })

  test('an initialize that was forwarded before a late probe result keeps the child legacy', () => {
    const router = rig('a', 'b')
    const probe = send(router, 'b', 1, 'server/discover')
    send(router, 'a', 1, 'initialize', { capabilities: {} })
    assert.equal(router.era(), 'legacy')
    const out = router.fromChild(reply(probe, MODERN))
    assert.deepEqual(toLink(out, 'b'), [{ jsonrpc: '2.0', id: 1, result: MODERN }])
    assert.equal(router.era(), 'legacy')
    // Legacy rules stay: ping is answered by the router.
    assert.deepEqual(router.fromLink('b', req(9, 'ping')), [
      { to: 'link', link: 'b', msg: { jsonrpc: '2.0', id: 9, result: {} } },
    ])
  })

  test('a discover on a legacy child is a plain request: forwarded with a router id, never cached', () => {
    const router = rig('a', 'b')
    send(router, 'a', 1, 'initialize', {})
    const first = send(router, 'a', 2, 'server/discover')
    const second = send(router, 'b', 2, 'server/discover')
    assert.notEqual(first, second)
    router.fromChild(fail(first, -32601))
    router.fromChild(fail(second, -32601))
    assert.equal(router.era(), 'legacy')
  })

  test('initialize after modern is -32601 from the router and reaches no child; notifications/initialized is dropped', () => {
    const router = modern('a')
    refusal(router.fromLink('a', req(5, 'initialize', { capabilities: {} })), 'a', 5, -32601)
    assert.deepEqual(router.fromLink('a', note('notifications/initialized')), [])
    assert.equal(router.open(), 0)
  })
})

describe('modern rules', () => {
  test('rule 1: the id and the progress token are swapped, progress goes back with the link token, every _meta key goes through', () => {
    const router = modern('a', 'b')
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': { roots: {} },
      'io.modelcontextprotocol/logLevel': 'info',
      traceparent: '00-abc',
      progressToken: 'tok',
    }
    const [m] = toChild(router.fromLink('a', req('x', 'tools/call', { name: 'n', _meta: meta })))
    assert.equal(typeof m!.id, 'number')
    assert.deepEqual(m!.params._meta, { ...meta, progressToken: m!.id })
    assert.equal(m!.params.name, 'n')
    const progress = router.fromChild(note('notifications/progress', { progressToken: m!.id, progress: 3 }))
    assert.deepEqual(progress, [
      {
        to: 'link',
        link: 'a',
        msg: { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok', progress: 3 } },
      },
    ])
    assert.deepEqual(toLink(router.fromChild(reply(m!.id, { v: 1 })), 'a'), [
      { jsonrpc: '2.0', id: 'x', result: { v: 1 } },
    ])
  })

  test('rule 1: a _meta of 8,192 characters passes, one of 8,193 is -32602 and reaches no child', () => {
    const router = modern('a')
    const sized = (chars: number) => ({ k: 'x'.repeat(chars - JSON.stringify({ k: '' }).length) })
    assert.equal(JSON.stringify(sized(8192)).length, 8192)
    assert.equal(toChild(router.fromLink('a', req(1, 'tools/list', { _meta: sized(8192) }))).length, 1)
    refusal(router.fromLink('a', req(2, 'tools/list', { _meta: sized(8193) })), 'a', 2, -32602)
    assert.equal(router.open(), 1)
  })

  test('rule 2: ping is forwarded, and nothing is cached: two discovers reach the child', () => {
    const router = modern('a', 'b')
    assert.equal(toChild(router.fromLink('a', req(1, 'ping'))).length, 1)
    assert.equal(toLink(router.fromLink('a', req(2, 'ping')), 'a').length, 0)
    const d1 = send(router, 'a', 3, 'server/discover')
    const d2 = send(router, 'b', 3, 'server/discover')
    assert.notEqual(d1, d2)
    router.fromChild(reply(d1, MODERN))
    assert.equal(toChild(router.fromLink('b', req(4, 'server/discover'))).length, 1)
  })

  test('rule 3: a listen is an open request; the ack and each stamped notice go to its link only, with the id that it sent', () => {
    const router = modern('a', 'b')
    const la = send(router, 'a', 'listen:1', 'subscriptions/listen', { notifications: { toolsListChanged: true } })
    const lb = send(router, 'b', 'listen:1', 'subscriptions/listen', { notifications: { toolsListChanged: true } })
    assert.notEqual(la, lb)
    const ack = router.fromChild(
      note('notifications/subscriptions/acknowledged', {
        _meta: { [STAMP]: la },
        notifications: { toolsListChanged: true },
      }),
    )
    assert.deepEqual(ack, [
      {
        to: 'link',
        link: 'a',
        msg: {
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { _meta: { [STAMP]: 'listen:1' }, notifications: { toolsListChanged: true } },
        },
      },
    ])
    const changed = router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: lb } }))
    assert.deepEqual(
      changed.map(e => e.to === 'link' && e.link),
      ['b'],
    )
    assert.equal(toLink(changed, 'b')[0]!.params._meta[STAMP], 'listen:1')
    assert.equal(router.open(), 2)
  })

  test('rule 3: a second stream for a link is -32602 and reaches no child; another link may open one', () => {
    const router = modern('a', 'b')
    send(router, 'a', 'listen:1', 'subscriptions/listen', { notifications: {} })
    refusal(
      router.fromLink('a', req('listen:2', 'subscriptions/listen', { notifications: {} })),
      'a',
      'listen:2',
      -32602,
    )
    assert.equal(
      toChild(router.fromLink('b', req('listen:1', 'subscriptions/listen', { notifications: {} }))).length,
      1,
    )
  })

  test('rule 3: a notice with no stamp, an unknown stamp, the string form of a router id or the stamp of a closed stream is dropped', () => {
    const router = modern('a')
    const rid = send(router, 'a', 'listen:1', 'subscriptions/listen', { notifications: {} })
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed')), [])
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', {})), [])
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: rid + 100 } })), [])
    assert.deepEqual(
      router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: String(rid) } })),
      [],
    )
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: 'listen:1' } })), [])
    const call = send(router, 'a', 5)
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: call } })), [])
    router.fromChild(reply(rid, { _meta: { [STAMP]: rid } }))
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: rid } })), [])
  })

  test('rule 3: the result that ends a stream gets its id and its stamp set back, and closes it', () => {
    const router = modern('a')
    const rid = send(router, 'a', 'listen:7', 'subscriptions/listen', { notifications: {} })
    const out = router.fromChild(reply(rid, { _meta: { [STAMP]: rid, keep: 1 } }))
    assert.deepEqual(out, [
      {
        to: 'link',
        link: 'a',
        msg: { jsonrpc: '2.0', id: 'listen:7', result: { _meta: { [STAMP]: 'listen:7', keep: 1 } } },
      },
    ])
    assert.equal(router.open(), 0)
    // The link may open a new stream now.
    assert.equal(
      toChild(router.fromLink('a', req('listen:8', 'subscriptions/listen', { notifications: {} }))).length,
      1,
    )
  })

  test('rule 4: a cancel or a detach ends a stream: the child hears the router id, and no later effect names the link', () => {
    const router = modern('a', 'b')
    const rid = send(router, 'a', 'listen:1', 'subscriptions/listen', { notifications: {} })
    const out = router.fromLink('a', note('notifications/cancelled', { requestId: 'listen:1', reason: 'done' }))
    assert.deepEqual(out, [
      {
        to: 'child',
        msg: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: rid, reason: 'done' } },
      },
    ])
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: rid } })), [])
    const second = send(router, 'b', 'listen:1', 'subscriptions/listen', { notifications: {} })
    const call = send(router, 'b', 2)
    const detach = router.detach('b')
    assert.deepEqual(detach, [
      { to: 'child', msg: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: second } } },
      { to: 'child', msg: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call } } },
    ])
    assert.deepEqual(router.fromChild(reply(call)), [])
    assert.equal(router.open(), 0)
  })

  test('rule 4: a cancel of the child for a stream (server-side teardown) closes it and goes to its link, with the link id', () => {
    const router = modern('a', 'b')
    const rid = send(router, 'a', 'listen:1', 'subscriptions/listen', { notifications: { toolsListChanged: true } })
    const other = send(router, 'b', 'listen:1', 'subscriptions/listen', { notifications: {} })
    router.fromChild(note('notifications/subscriptions/acknowledged', { _meta: { [STAMP]: rid }, notifications: {} }))
    const out = router.fromChild(note('notifications/cancelled', { requestId: rid, reason: 'server closing' }))
    assert.deepEqual(out, [
      {
        to: 'link',
        link: 'a',
        msg: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 'listen:1', reason: 'server closing' },
        },
      },
    ])
    assert.equal(router.open(), 1)
    // Nothing more for that stream, and the link may open a new one.
    assert.deepEqual(router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: rid } })), [])
    assert.deepEqual(router.fromChild(note('notifications/cancelled', { requestId: rid })), [])
    assert.equal(
      toChild(router.fromLink('a', req('listen:2', 'subscriptions/listen', { notifications: {} }))).length,
      1,
    )
    // Any other cancel of the child is dropped: a call, a string form, an unknown id, no id.
    const call = send(router, 'a', 5)
    for (const requestId of [call, String(other), 9999, undefined, null]) {
      assert.deepEqual(
        router.fromChild(note('notifications/cancelled', requestId === undefined ? {} : { requestId })),
        [],
      )
    }
    assert.equal(router.open(), 3)
  })

  test('rule 4: a death gives each open request and each stream one error, then nothing', () => {
    const router = modern('a', 'b')
    send(router, 'a', 'listen:1', 'subscriptions/listen', { notifications: {} })
    send(router, 'a', 2)
    send(router, 'b', 3)
    const out = router.died()
    assert.deepEqual(
      out.map(e => e.to === 'link' && [e.link, (e.msg as M).id, (e.msg as M).error.code]),
      [
        ['a', 'listen:1', DIED_CODE],
        ['a', 2, DIED_CODE],
        ['b', 3, DIED_CODE],
      ],
    )
    assert.deepEqual(router.died(), [])
    assert.deepEqual(router.fromLink('a', req(5, 'tools/list')), [])
    assert.equal(router.open(), 0)
  })

  test('rule 5: a requestState of an input_required result is kept for that link; the retry goes through unchanged, another link is refused', () => {
    const router = modern('a', 'b')
    const rid = send(router, 'a', 1)
    router.fromChild(reply(rid, { resultType: 'input_required', requestState: 'state-A', inputRequests: { k: {} } }))
    const retry = { name: 'n', requestState: 'state-A', inputResponses: { k: { action: 'accept' } } }
    const [m] = toChild(router.fromLink('a', req(2, 'tools/call', retry)))
    assert.deepEqual(m!.params, retry)
    refusal(router.fromLink('b', req(3, 'tools/call', retry)), 'b', 3, -32602)
    refusal(router.fromLink('a', req(4, 'tools/call', { requestState: 'state-unknown' })), 'a', 4, -32602)
    refusal(router.fromLink('a', req(5, 'tools/call', { requestState: 5 })), 'a', 5, -32602)
    // A complete result keeps nothing, and a call with no requestState is plain.
    router.fromChild(reply(send(router, 'a', 6), { resultType: 'complete', requestState: 'state-C' }))
    refusal(router.fromLink('a', req(7, 'tools/call', { requestState: 'state-C' })), 'a', 7, -32602)
  })

  test('rule 5: at most 64 for each link (the oldest goes) and at most 8,192 characters each; a detach drops them', () => {
    const router = modern('a')
    const give = (state: string) =>
      router.fromChild(
        reply(send(router, 'a', state.length + Math.random(), 'tools/call'), {
          resultType: 'input_required',
          requestState: state,
        }),
      )
    for (let i = 0; i < 65; i++) give(`s${i}`)
    refusal(router.fromLink('a', req('r0', 'tools/call', { requestState: 's0' })), 'a', 'r0', -32602)
    assert.equal(toChild(router.fromLink('a', req('r1', 'tools/call', { requestState: 's1' }))).length, 1)
    assert.equal(toChild(router.fromLink('a', req('r64', 'tools/call', { requestState: 's64' }))).length, 1)
    give('y'.repeat(8192))
    assert.equal(toChild(router.fromLink('a', req('long', 'tools/call', { requestState: 'y'.repeat(8192) }))).length, 1)
    give('z'.repeat(8193))
    refusal(
      router.fromLink('a', req('toolong', 'tools/call', { requestState: 'z'.repeat(8193) })),
      'a',
      'toolong',
      -32602,
    )
    router.detach('a')
    router.attach('a')
    refusal(router.fromLink('a', req('again', 'tools/call', { requestState: 's64' })), 'a', 'again', -32602)
  })

  test('rule 6: a request of the child reaches no link: ping gets {}, any other -32601', () => {
    const router = modern('a')
    assert.deepEqual(router.fromChild(req(3, 'ping')), [{ to: 'child', msg: { jsonrpc: '2.0', id: 3, result: {} } }])
    const out = router.fromChild(req('s', 'sampling/createMessage', {}))
    assert.deepEqual(toChild(out)[0]!.error.code, -32601)
    assert.deepEqual(toLink(out, 'a'), [])
  })

  test('nothing throws on 10,000 stray notifications or a 1 MB _meta, and a message is never changed', () => {
    const router = modern('a')
    for (let i = 0; i < 10_000; i++) {
      router.fromChild(note('notifications/tools/list_changed', { _meta: { [STAMP]: i % 7 === 0 ? 'x' : i } }))
      router.fromChild(note(`notifications/n${i % 5}`, i % 3 === 0 ? 5 : { _meta: i % 2 === 0 ? null : [] }))
    }
    refusal(router.fromLink('a', req(1, 'tools/list', { _meta: { big: 'x'.repeat(1_000_000) } })), 'a', 1, -32602)
    let deep: unknown = {}
    for (let i = 0; i < 50_000; i++) deep = { d: deep }
    assert.doesNotThrow(() =>
      router.fromLink('a', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: deep } }),
    )
    assert.doesNotThrow(() =>
      router.fromChild({
        jsonrpc: '2.0',
        id: 1,
        result: { _meta: deep, resultType: 'input_required', requestState: 5 },
      }),
    )
  })
})

// ---- the property test: 2 to 4 links, random modern traffic, invariants after each step ----
const generator = (seed: number) => {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  return { int, pick: <T>(items: readonly T[]): T => items[int(items.length)]!, chance: (p: number) => next() < p }
}

describe('modern property test', () => {
  // What the seeds reached: the test fails when a kind of event never happened.
  const reached = { streams: 0, notices: 0, retries: 0, refusals: 0, states: 0, cancels: 0 }
  test('250 seeds of 200 steps: no router id, no cross-link stamp or requestState, streams end with their link, open() ends at 0', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const g = generator(seed)
      const names = ['a', 'b', 'c', 'd'].slice(0, 2 + g.int(3))
      const router = modern(...names)
      const where = (step: number, what: string) => `seed ${seed} step ${step}: ${what}`
      const gone = new Set<string>()
      let counter = 0
      // What each link may see: the ids, tokens and stamps that it sent (all strings, so a router id is a number and shows).
      const mine = new Map(
        names.map(n => [n, { ids: new Set<string>(), tokens: new Set<string>(), streams: new Set<string>() }]),
      )
      const stateOwner = new Map<string, string>()
      const rids = new Map<number, { link: string; stream: boolean }>()
      const check = (effects: readonly Effect[], step: number, what: string) => {
        for (const e of effects) {
          if (e.to === 'child') {
            const m = e.msg as M
            if (typeof m.id === 'number' && typeof m.method === 'string') {
              const owner = rids.get(m.id)
              const state = m.params?.requestState
              if (m.method === 'subscriptions/listen') reached.streams++
              if (typeof state === 'string') reached.retries++
              if (typeof state === 'string')
                assert.equal(stateOwner.get(state), owner?.link, where(step, 'a requestState crossed links'))
            }
            continue
          }
          const m = e.msg as M
          assert.ok(!gone.has(e.link), where(step, `${what}: an effect names the detached link ${e.link}`))
          const l = mine.get(e.link)!
          if (m.method === 'notifications/cancelled') {
            reached.cancels++
            assert.ok(
              typeof m.params?.requestId === 'string' && l.streams.has(m.params.requestId),
              where(step, 'a link got a cancel for an id it did not send'),
            )
          }
          if (m.error?.code === -32602) reached.refusals++
          if (m.params?._meta?.[STAMP] !== undefined) reached.notices++
          if (m.id !== undefined)
            assert.ok(typeof m.id === 'string' && l.ids.has(m.id), where(step, `a link got id ${String(m.id)}`))
          const tok = m.params?.progressToken
          if (tok !== undefined)
            assert.ok(typeof tok === 'string' && l.tokens.has(tok), where(step, 'a link got a router token'))
          for (const meta of [m.params?._meta, m.result?._meta]) {
            const stamp = meta?.[STAMP]
            if (stamp !== undefined)
              assert.ok(
                typeof stamp === 'string' && l.streams.has(stamp),
                where(step, `a link got stamp ${String(stamp)}`),
              )
          }
        }
      }
      const live = () => names.filter(n => !gone.has(n))
      for (let step = 1; step <= 200; step++) {
        const link = g.pick(names)
        const roll = g.int(100)
        if (roll < 40) {
          const id = `${link}-${++counter}`
          const listen = g.chance(0.2)
          const token = `t${counter}`
          const states = [...stateOwner.entries()].filter(([, o]) => o === link).map(([s]) => s)
          const foreign = [...stateOwner.keys()]
          const params: M = listen ? { notifications: { toolsListChanged: true } } : { name: 'x' }
          params._meta = g.chance(0.5) ? { progressToken: token, traceparent: 'tp' } : { traceparent: 'tp' }
          if (!listen && g.chance(0.3))
            params.requestState =
              g.chance(0.5) && states.length ? g.pick(states) : foreign.length ? g.pick(foreign) : 'nope'
          const msg = req(
            listen ? `${link}:listen:${counter}` : id,
            listen ? 'subscriptions/listen' : 'tools/call',
            params,
          )
          const effects = router.fromLink(link, msg)
          if (!gone.has(link)) {
            const l = mine.get(link)!
            l.ids.add(String((msg as M).id))
            if (params._meta.progressToken) l.tokens.add(token)
            if (listen) l.streams.add(String((msg as M).id))
          }
          for (const c of toChild(effects)) rids.set(c.id as number, { link, stream: listen })
          check(effects, step, 'request')
        } else if (roll < 48) {
          const l = mine.get(link)!
          const target = g.pick([...l.ids, 'unknown'])
          check(router.fromLink(link, note('notifications/cancelled', { requestId: target })), step, 'cancel')
        } else if (roll < 52) {
          const effects = router.fromLink(link, req(`${link}-i${++counter}`, 'initialize', {}))
          assert.deepEqual(toChild(effects), [], where(step, 'initialize reached the child'))
          mine.get(link)!.ids.add(`${link}-i${counter}`)
          check(effects, step, 'initialize')
        } else if (roll < 56) {
          check(router.fromLink(link, note('notifications/initialized')), step, 'initialized')
        } else if (roll < 74 && rids.size > 0) {
          const [rid, info] = g.pick([...rids.entries()])
          if (g.chance(0.5)) {
            const state = `state-${++counter}`
            const msg = reply(
              rid,
              info.stream
                ? { _meta: { [STAMP]: g.chance(0.5) ? rid : 999 } }
                : { resultType: 'input_required', requestState: state },
            )
            const effects = router.fromChild(msg)
            if (effects.length > 0 && !info.stream && !gone.has(info.link)) {
              stateOwner.set(state, info.link)
              reached.states++
            }
            check(effects, step, 'child result')
          } else {
            check(router.fromChild(fail(rid)), step, 'child error')
          }
        } else if (roll < 84 && rids.size > 0) {
          const [rid, info] = g.pick([...rids.entries()])
          const stamp = g.pick<unknown>([rid, rid, String(rid), rid + 1000, 'listen:1'])
          check(
            router.fromChild(
              note(
                g.pick([
                  'notifications/tools/list_changed',
                  'notifications/subscriptions/acknowledged',
                  'notifications/x',
                ]),
                { _meta: { [STAMP]: stamp } },
              ),
            ),
            step,
            `stamped notice for ${info.link}`,
          )
        } else if (roll < 88 && rids.size > 0) {
          const [rid] = g.pick([...rids.entries()])
          check(
            router.fromChild(
              note('notifications/progress', { progressToken: g.pick<unknown>([rid, String(rid), 5000]), progress: 1 }),
            ),
            step,
            'progress',
          )
        } else if (roll < 90 && rids.size > 0) {
          const streamRids = [...rids.entries()].filter(([, info]) => info.stream)
          const [rid] = streamRids.length > 0 && g.chance(0.8) ? g.pick(streamRids) : g.pick([...rids.entries()])
          const requestId = g.pick<unknown>([rid, rid, rid, String(rid), 4242])
          check(router.fromChild(note('notifications/cancelled', { requestId })), step, 'child cancel')
        } else if (roll < 92) {
          check(router.fromChild(note('notifications/tools/list_changed')), step, 'unstamped list change')
        } else if (roll < 94) {
          check(router.fromChild(req(g.pick([1, 'x']), g.pick(['ping', 'roots/list']))), step, 'child request')
        } else if (roll < 96 && live().length > 1) {
          const victim = g.pick(live())
          const effects = router.detach(victim)
          gone.add(victim)
          check(effects, step, 'detach')
          for (const [state, owner] of stateOwner) if (owner === victim) stateOwner.delete(state)
        }
      }
      // Every open request and stream ends: answer what is left, then check that nothing is held.
      for (const [rid, info] of rids) {
        router.fromChild(reply(rid))
      }
      for (const n of live()) router.detach(n)
      assert.equal(router.open(), 0, `seed ${seed}: open() after everything ended`)
      assert.deepEqual(router.died(), [], `seed ${seed}: a death after all ended`)
    }
    for (const [what, n] of Object.entries(reached)) assert.ok(n >= 100, `the seeds reached ${what} only ${n} times`)
  })
})
