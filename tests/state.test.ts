// The pure part of the approval on a 2026-07-28 connection (src/core/state.ts, issue #154, P3-1): the hashes that bind a state to one
// program, one set of tools and one policy, the payload check, the table of open states and the answer of the client.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MAX_OPEN,
  MAX_ROUNDS,
  OpenStates,
  answerOf,
  argsHash,
  canonicalJson,
  checkPayload,
  nextRound,
  parsePayload,
  policyHash,
  toolsHash,
  type StatePayload,
} from '../src/core/state.ts'

const sha = (text: string): string => createHash('sha256').update(text).digest('base64url')
const payload = (over: Partial<StatePayload> = {}): StatePayload => ({
  v: 1,
  k: 'tools',
  r: 1,
  n: 'nonce',
  a: 'a',
  t: 't',
  p: 'p',
  ...over,
})

describe('the hashes', () => {
  test('canonical JSON sorts the keys of each object and keeps the order of an array', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }),
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    )
  })

  test('the arguments hash changes with one byte of the tool name or of the arguments, and not with the order of keys', () => {
    const base = argsHash(sha, 'run_code', { code: 'return 1' })
    assert.equal(argsHash(sha, 'run_code', { code: 'return 1' }), base)
    assert.notEqual(argsHash(sha, 'run_code', { code: 'return 1 ' }), base)
    assert.notEqual(argsHash(sha, 'run_codf', { code: 'return 1' }), base)
    assert.notEqual(argsHash(sha, 'run_code', { code: 'return 1', extra: 1 }), base)
    assert.equal(argsHash(sha, 'x', { a: 1, b: 2 }), argsHash(sha, 'x', { b: 2, a: 1 }))
  })

  test('the tools hash does not depend on the order or on a repeat, and changes with any tool', () => {
    const base = toolsHash(sha, ['mcp__a__x', 'mcp__b__y'])
    assert.equal(toolsHash(sha, ['mcp__b__y', 'mcp__a__x', 'mcp__a__x']), base)
    assert.notEqual(toolsHash(sha, ['mcp__a__x']), base)
    assert.notEqual(toolsHash(sha, ['mcp__a__x', 'mcp__b__z']), base)
    assert.notEqual(toolsHash(sha, []), base)
  })

  test('the policy hash follows the rules in order, with their match, action and index', () => {
    const a = { match: 'mcp__a__*', action: 'allow', index: 0 } as const
    const b = { match: 'mcp__b__*', action: 'ask', index: 1 } as const
    assert.equal(policyHash(sha, [a, b]), policyHash(sha, [a, b]))
    assert.notEqual(policyHash(sha, [b, a]), policyHash(sha, [a, b]))
    assert.notEqual(policyHash(sha, [a, { ...b, action: 'deny' }]), policyHash(sha, [a, b]))
    assert.notEqual(policyHash(sha, [a]), policyHash(sha, [a, b]))
  })
})

describe('the payload', () => {
  test('a payload is exactly the fields of the bar, in a plain object', () => {
    assert.deepEqual(parsePayload(payload()), payload())
    for (const bad of [
      null,
      [],
      'text',
      { ...payload(), extra: 1 },
      { ...payload(), v: 2 },
      { ...payload(), k: 'other' },
      { ...payload(), r: 0 },
      { ...payload(), r: MAX_ROUNDS + 1 },
      { ...payload(), r: 1.5 },
      { ...payload(), n: '' },
      { ...payload(), a: 5 },
      { ...payload(), t: 'x'.repeat(65) },
    ])
      assert.equal(parsePayload(bad), undefined, JSON.stringify(bad))
    const { p, ...missing } = payload()
    void p
    assert.equal(parsePayload(missing), undefined)
  })

  test('the checks name the first failure: the kind, then the arguments', () => {
    assert.equal(checkPayload(payload(), 'tools', 'a'), undefined)
    assert.equal(checkPayload(payload(), 'policy', 'a'), 'kind')
    assert.equal(checkPayload(payload(), 'tools', 'b'), 'program')
  })

  test('the next round is one more than the round that was presented', () => {
    assert.equal(nextRound(undefined), 1)
    assert.equal(nextRound(payload({ r: 3 })), 4)
  })
})

describe('the open states', () => {
  test('a number is used one time, whatever the answer', () => {
    const open = new OpenStates()
    open.add('n1', 1000)
    assert.equal(open.take('n1', 2000), true)
    assert.equal(open.take('n1', 2001), false, 'the second use')
    assert.equal(open.take('never-made', 2000), false)
    open.add('n2', 1000)
    assert.equal(open.take('n2', 1000 + 600_001), false, 'an expired number')
    assert.equal(open.take('n2', 1000 + 1), false, 'and it is gone')
  })

  test('at most 256 are open: the oldest is dropped, and an expired one is swept on use', () => {
    const open = new OpenStates()
    for (let i = 0; i < MAX_OPEN + 5; i++) open.add(`n${i}`, 1000)
    assert.equal(open.size, MAX_OPEN)
    assert.equal(open.take('n0', 1001), false, 'the oldest was dropped')
    assert.equal(open.take(`n${MAX_OPEN + 4}`, 1001), true)
    open.add('late', 1000 + 700_000)
    assert.equal(open.size, 1, 'the expired numbers were swept when another was made')
  })
})

describe('the answer of the client', () => {
  test('accept is an accept, decline and cancel are a decline, anything else is no answer', () => {
    assert.equal(answerOf({ approve: { action: 'accept', content: {} } }), 'accept')
    assert.equal(answerOf({ approve: { action: 'decline' } }), 'decline')
    assert.equal(answerOf({ approve: { action: 'cancel' } }), 'decline')
    for (const bad of [
      undefined,
      {},
      { approve: 'accept' },
      { approve: null },
      { approve: [] },
      { approve: {} },
      { approve: { action: 'ACCEPT' } },
      { other: { action: 'accept' } },
    ])
      assert.equal(answerOf(bad as never), 'none', JSON.stringify(bad))
  })
})
