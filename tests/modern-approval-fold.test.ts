// The fold of the approval states (P3-1) with the roots round (P3-2): one sealer for every kind, the roots round reads the kind of a
// state before it uses anything, and a state of the approval is never used up by it. The built server holds the call that needs both
// rounds (tests/modern-approval.e2e.mjs).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRootsRound } from '../src/host/workspace/rootsround.ts'
import { createRootsState, createSealer } from '../src/host/workspace/rootsstate.ts'

const ARGS = { code: 'return 1' }
const CAPS = { roots: {} }

/** A roots round on a sealer, with a fake list of roots that records what the round did to it. */
const rig = () => {
  const sealer = createSealer()
  const events: string[] = []
  let settled = false
  const roots = {
    isSettled: () => settled,
    answer: (uris: readonly string[]) => {
      settled = true
      events.push(`answer ${uris.join(',')}`)
    },
    modern: () => {
      settled = true
      events.push('modern')
    },
  }
  const logs: string[] = []
  const state = createRootsState(sealer)
  const round = createRootsRound({ roots, log: line => logs.push(line), state })
  return { sealer, round, events, logs, settle: () => (settled = true) }
}

describe('a state of another kind in the roots round', () => {
  test('while the roots are not settled it is refused, settles nothing, and is not used up', () => {
    const r = rig()
    const approval = r.sealer.seal('approval', { s: 'tools', r: 2, a: 'a', t: 't', p: 'p' })
    const step = r.round.round('run_code', ARGS, { requestState: approval, capabilities: CAPS })
    assert.deepEqual(step, { kind: 'refused' })
    assert.deepEqual(r.events, [], 'nothing settled')
    assert.equal(r.sealer.count(), 1, 'the state is still open')
    assert.equal(r.sealer.open('approval', approval).ok, true, 'and its own round can still use it')
  })

  test('once the roots are settled it goes on, and the state is not used up by the roots round', () => {
    const r = rig()
    r.settle()
    const approval = r.sealer.seal('approval', { s: 'tools', r: 2, a: 'a', t: 't', p: 'p' })
    assert.deepEqual(r.round.round('run_code', ARGS, { requestState: approval }), { kind: 'go' })
    assert.equal(r.sealer.count(), 1)
    assert.equal(r.sealer.open('approval', approval).ok, true)
  })

  test('a forged state or one of another process is refused by the kind read, and nothing is used up', () => {
    const r = rig()
    const other = createSealer().seal('approval', { s: 'tools', r: 1, a: 'a', t: 't', p: 'p' })
    const kept = r.sealer.seal('approval', { s: 'tools', r: 1, a: 'a', t: 't', p: 'p' })
    for (const bad of [other, 'junk', `${kept}x`, kept.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))]) {
      assert.deepEqual(r.round.round('run_code', ARGS, { requestState: bad }), { kind: 'refused' }, bad)
    }
    assert.equal(r.sealer.count(), 1, 'the open state of the approval was not touched')
  })
})

describe('the roots state and the approval state of one call', () => {
  test('the roots round takes its own state, then the approval state of the same call goes on with the roots settled', () => {
    const r = rig()
    const asked = r.round.round('run_code', ARGS, { capabilities: CAPS })
    assert.equal(asked.kind, 'ask')
    const state = asked.kind === 'ask' ? asked.state : ''
    const done = r.round.round('run_code', ARGS, {
      requestState: state,
      inputResponses: { roots: { roots: [{ uri: 'file:///x' }] } },
    })
    assert.deepEqual(done, { kind: 'go' })
    assert.deepEqual(r.events, ['answer file:///x'])
    // The approval round of the call: sealed in the same table, left alone by the roots round.
    const approval = r.sealer.seal('approval', { s: 'tools', r: 2, a: 'a', t: 't', p: 'p' })
    assert.deepEqual(r.round.round('run_code', ARGS, { requestState: approval }), { kind: 'go' })
    assert.equal(r.sealer.open('approval', approval).ok, true)
    // The roots state is used up, and cannot be used as an approval.
    assert.equal(r.sealer.open('approval', state).ok, false)
  })

  test('a roots state is never an approval: the approval round opens only its own kind, and uses the state up', () => {
    const r = rig()
    const roots = r.sealer.seal('roots', { c: 'x' })
    const opened = r.sealer.open('approval', roots)
    assert.equal(opened.ok, false)
    assert.equal(r.sealer.open('roots', roots).ok, false, 'used up by the attempt, as the sealer does for every kind')
  })
})
