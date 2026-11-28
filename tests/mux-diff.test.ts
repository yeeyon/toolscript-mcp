// The legacy router, value for value: the file of b38ab16 (tests/fixtures/mux-1.0.5.ts, copied unchanged) and the new router get the
// same random legacy sequences, and each step must give deep-equal effects. A sequence never gives the child a modern discover
// result, so the era never turns modern: a probe that the child refuses is the case of the bar. The seed is in each failure.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, type Effect, type Router } from '../src/core/mux.ts'
import { createRouter as createOld } from './fixtures/mux-1.0.5.ts'

const SEEDS = 250
const STEPS = 200

/** mulberry32: a small seeded generator, the same on every system. */
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
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!
  return { next, int, pick, chance: (p: number) => next() < p }
}

const frozen = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) frozen(v)
  return Object.freeze(value)
}

const LINKS = ['a', 'b', 'c']
const IDS: readonly unknown[] = [1, 2, 3, 4, '1', '2', '3', 'x', 1.5, null, true, {}, []]
const METHODS = [
  'tools/call',
  'tools/list',
  'ping',
  'initialize',
  'initialize',
  'server/discover',
  'subscriptions/listen',
  'resources/read',
]

describe('the legacy router, value for value', () => {
  test(`${SEEDS} seeds of ${STEPS} steps give the effects of 1.0.5`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = generator(seed)
      const fresh: Router = createRouter()
      const old: Router = createOld()
      // The requests that the child saw: (router id, method). Both routers give the same ones while they are equal.
      const sent: { rid: unknown; method: unknown }[] = []
      const both = (label: string, run: (r: Router) => readonly Effect[], step: number) => {
        const a = run(old)
        const b = run(fresh)
        assert.deepEqual(b, a, `seed ${seed} step ${step}: ${label}`)
        for (const e of a) {
          if (e.to === 'child' && typeof e.msg === 'object' && e.msg !== null) {
            const m = e.msg as Record<string, unknown>
            if (typeof m.id === 'number' && typeof m.method === 'string') sent.push({ rid: m.id, method: m.method })
          }
        }
        assert.equal(fresh.open(), old.open(), `seed ${seed} step ${step}: open() after ${label}`)
        assert.notEqual(fresh.era(), 'modern', `seed ${seed} step ${step}: the era turned modern`)
      }
      const params = (): unknown => {
        switch (g.int(6)) {
          case 0:
            return undefined
          case 1:
            return {}
          case 2:
            return { _meta: { progressToken: g.pick(IDS), other: 1 } }
          case 3:
            return { name: 'x', arguments: { n: g.int(9) }, _meta: { progressToken: g.pick(IDS) } }
          case 4:
            return { requestState: 'x', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }
          default:
            return g.pick<unknown>(['junk', 7, null, [1]])
        }
      }
      for (let step = 1; step <= STEPS; step++) {
        const link = g.pick(LINKS)
        const roll = g.int(100)
        if (roll < 6) both(`attach ${link}`, r => r.attach(link), step)
        else if (roll < 10) both(`detach ${link}`, r => r.detach(link), step)
        else if (roll < 38) {
          const msg = frozen({ jsonrpc: '2.0', id: g.pick(IDS), method: g.pick(METHODS), params: params() })
          both(`request ${JSON.stringify(msg)} from ${link}`, r => r.fromLink(link, msg), step)
        } else if (roll < 46) {
          const msg = frozen({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: g.chance(0.8)
              ? { requestId: g.pick(IDS), ...(g.chance(0.5) && { reason: 'r' }) }
              : g.pick<unknown>([{}, 'x', null]),
          })
          both(`cancel from ${link}`, r => r.fromLink(link, msg), step)
        } else if (roll < 52) {
          const msg = frozen({
            jsonrpc: '2.0',
            method: g.pick(['notifications/initialized', 'notifications/other', 'notifications/initialized']),
          })
          both(`notice from ${link}`, r => r.fromLink(link, msg), step)
        } else if (roll < 74) {
          const known = sent.length > 0 && g.chance(0.85)
          const target = known ? g.pick(sent) : { rid: g.pick<unknown>([999, '1', 1.5, null, 0]), method: 'x' }
          const refusedProbe = target.method === 'server/discover'
          const msg = frozen(
            refusedProbe || g.chance(0.2)
              ? { jsonrpc: '2.0', id: target.rid, error: { code: -32601, message: 'Method not found' } }
              : {
                  jsonrpc: '2.0',
                  id: target.rid,
                  result: g.pick<unknown>([{}, { ok: 1 }, { protocolVersion: '2025-06-18' }, 'x', null]),
                },
          )
          both(`child answer ${JSON.stringify(msg)}`, r => r.fromChild(msg), step)
        } else if (roll < 82) {
          const target = sent.length > 0 ? g.pick(sent).rid : 1
          const token = g.chance(0.7) ? target : g.pick<unknown>(['1', 999, null, 'x'])
          const msg = frozen({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: token, progress: 1 },
          })
          both('child progress', r => r.fromChild(msg), step)
        } else if (roll < 87) {
          const msg = frozen({
            jsonrpc: '2.0',
            method: g.pick([
              'notifications/tools/list_changed',
              'notifications/message',
              'notifications/subscriptions/acknowledged',
            ]),
            params: g.chance(0.5)
              ? { _meta: { 'io.modelcontextprotocol/subscriptionId': g.pick<unknown>([1, 2, '1', 'x']) } }
              : undefined,
          })
          both('child notification', r => r.fromChild(msg), step)
        } else if (roll < 93) {
          const msg = frozen({
            jsonrpc: '2.0',
            id: g.pick(IDS),
            method: g.pick(['ping', 'roots/list', 'sampling/createMessage']),
          })
          both('child request', r => r.fromChild(msg), step)
        } else if (roll < 98) {
          const msg = g.pick<unknown>([
            null,
            7,
            'x',
            [],
            {},
            { id: 1 },
            { jsonrpc: '2.0', id: 1, method: 5 },
            { result: 1 },
            { id: 1, result: {}, error: {} },
          ])
          const viaChild = g.chance(0.5)
          both('junk', r => (viaChild ? r.fromChild(msg) : r.fromLink(link, msg)), step)
        } else if (step > STEPS / 2) {
          both('died', r => r.died(), step)
        }
      }
    }
  })
})
