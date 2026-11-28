// The pure part of the approval on a 2026-07-28 connection (src/core/state.ts, issue #154, P3-1): the hashes that bind a state to one
// program, one set of tools and one policy, the fields of a state, and the answer of the client. The seal (the key, the used-once
// table, the expiry) is the sealer of src/host/workspace/rootsstate.ts, which tests/workspace-roots-modern.test.ts and
// tests/modern-approval-fold.test.ts hold.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MAX_ROUNDS,
  answerOf,
  argsHash,
  canonicalJson,
  nextRound,
  parseFields,
  policyHash,
  toolsHash,
} from '../src/core/state.ts'

const sha = (text: string): string => createHash('sha256').update(text).digest('base64url')
const fields = (over: Record<string, unknown> = {}) => ({ s: 'tools', r: 1, a: 'a', t: 't', p: 'p', ...over })

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

describe('the fields of a state', () => {
  test('they are exactly the stage, the round and the three hashes', () => {
    assert.deepEqual(parseFields(fields()), { k: 'tools', r: 1, a: 'a', t: 't', p: 'p' })
    assert.deepEqual(parseFields(fields({ s: 'policy', r: MAX_ROUNDS })), {
      k: 'policy',
      r: MAX_ROUNDS,
      a: 'a',
      t: 't',
      p: 'p',
    })
    for (const bad of [
      { ...fields(), extra: 1 },
      fields({ s: 'other' }),
      fields({ s: 'roots' }),
      fields({ r: 0 }),
      fields({ r: MAX_ROUNDS + 1 }),
      fields({ r: 1.5 }),
      fields({ r: '1' }),
      fields({ a: '' }),
      fields({ a: 5 }),
      fields({ t: 'x'.repeat(65) }),
    ])
      assert.equal(parseFields(bad), undefined, JSON.stringify(bad))
    const { p, ...missing } = fields()
    void p
    assert.equal(parseFields(missing), undefined)
  })

  test('the next round is one more than the round that was presented', () => {
    assert.equal(nextRound({ k: 'tools', r: 3, a: 'a', t: 't', p: 'p' }), 4)
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
