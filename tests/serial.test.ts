import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SCAN_CHARS,
  MAX_SCAN_WORK,
  VALUE_COST,
  serialStreak,
  usesResult,
  type TimedCall,
} from '../src/core/serial.ts'

// Calls of one tool, each sent `gap` ms after the reply before it, as a loop that awaits each call.
const loop = (ms: readonly number[], gap = 5): TimedCall[] => {
  const calls: TimedCall[] = []
  let at = 0
  ms.forEach((m, i) => {
    calls.push({
      id: i + 1,
      tool: 'mcp__x__get',
      key: `mcp__x__get\n{"id":"item-${i}"}`,
      sentAt: at,
      repliedAt: at + m,
      ok: true,
      plain: true,
      ...(i === 0 ? {} : { previous: { id: i, usesResult: false } }),
    })
    at += m + gap
  })
  return calls
}

const SIX = [1900, 2600, 4100, 2500, 3000, 2400]

describe('serialStreak', () => {
  test('six reads of one tool in a loop: the time they took and what parallel calls save', () => {
    const streak = serialStreak(loop(SIX))
    const sum = SIX.reduce((a, b) => a + b, 0)
    assert.deepEqual(streak, { tool: 'mcp__x__get', calls: 6, ms: sum + 5 * 5, savedMs: sum + 5 * 5 - 4100 })
  })

  test('no streak when parallel calls save less than 3 s', () => {
    assert.equal(serialStreak(loop([1400, 1500])), undefined)
    assert.deepEqual(serialStreak(loop([1400, 1500]), { gapMs: 100, minSavedMs: 1000 }), {
      tool: 'mcp__x__get',
      calls: 2,
      ms: 2905,
      savedMs: 1405,
    })
  })

  test('calls sent together, as Promise.all sends them, are no streak', () => {
    const together = loop(SIX).map(
      (c, i): TimedCall => ({ ...c, sentAt: i, repliedAt: i + SIX[i]!, previous: undefined }),
    )
    assert.equal(serialStreak(together), undefined)
  })

  test('a call whose arguments hold a value of the previous result is no streak: cursor paging', () => {
    const paged = loop(SIX).map(c =>
      c.previous === undefined ? c : { ...c, previous: { ...c.previous, usesResult: true } },
    )
    assert.equal(serialStreak(paged), undefined)
  })

  test('the same call again is no streak: polling', () => {
    const polls = loop(SIX).map(c => ({ ...c, key: 'mcp__x__get\n{"id":"job-1"}' }))
    assert.equal(serialStreak(polls), undefined)
  })

  test('a call the person approved breaks the streak', () => {
    const four = [1600, 1600, 1600, 1600]
    assert.equal(serialStreak(loop(four))?.calls, 4)
    const approved = loop(four).map(c => (c.id === 3 ? { ...c, plain: false } : c))
    assert.equal(serialStreak(approved), undefined)
  })

  test('calls of different tools are no streak', () => {
    const mixed = loop(SIX).map(c =>
      c.id % 2 === 0 ? { ...c, tool: 'mcp__x__list', key: `mcp__x__list\n${c.id}` } : c,
    )
    assert.equal(serialStreak(mixed), undefined)
  })

  test('a wait between the calls, as from sleep, is no streak', () => {
    assert.equal(serialStreak(loop(SIX, 150))?.calls, 6)
    assert.equal(serialStreak(loop(SIX, 250)), undefined)
    assert.equal(serialStreak(loop(SIX, 250), { gapMs: 300 })?.calls, 6)
  })

  test('a failed call or one that did not finish ends the streak', () => {
    const four = [1600, 1600, 1600, 1600]
    assert.equal(serialStreak(loop(four).map(c => (c.id === 2 ? { ...c, ok: false } : c))), undefined)
    assert.equal(serialStreak(loop(four).map(c => (c.id === 3 ? { ...c, repliedAt: undefined } : c))), undefined)
  })

  test('a call sent after the reply of another call does not follow the call before it', () => {
    const calls = loop(SIX).map(c => (c.id === 4 ? { ...c, previous: { id: 99, usesResult: false } } : c))
    assert.equal(serialStreak(calls)?.calls, 3)
  })

  test('of two streaks, the one that saves more counts', () => {
    const first = loop([2000, 2000, 2000])
    const second = loop([3000, 3000, 3000, 3000]).map(c => ({
      ...c,
      id: c.id + 3,
      tool: 'mcp__x__list',
      key: `mcp__x__list\n${c.id}`,
      sentAt: c.sentAt + 10_000,
      repliedAt: c.repliedAt! + 10_000,
      previous: { id: c.id + 2, usesResult: false },
    }))
    assert.deepEqual(serialStreak([...first, ...second]), {
      tool: 'mcp__x__list',
      calls: 4,
      ms: 12_015,
      savedMs: 9015,
    })
  })
})

describe('usesResult', () => {
  test('a cursor or link from the previous result', () => {
    const json = JSON.stringify({ items: [1, 2], next_cursor: 'eyJwYWdlIjoyfQ', next: 'https://example.com/a?page=2' })
    assert.equal(usesResult({ cursor: 'eyJwYWdlIjoyfQ' }, {}, json), true)
    assert.equal(usesResult({ url: 'https://example.com/a?page=2' }, { url: 'https://example.com/a' }, json), true)
  })

  test('a number from the previous result counts only as a whole number', () => {
    const json = JSON.stringify({ offset: 0, limit: 50, total: 1234 })
    assert.equal(usesResult({ offset: 50 }, { offset: 0 }, json), true)
    assert.equal(usesResult({ offset: 123 }, { offset: 0 }, json), false)
    assert.equal(usesResult({ offset: 5 }, { offset: 0 }, json), false)
  })

  test('a value that the previous call also sent does not count', () => {
    const json = JSON.stringify({ repo: 'fake-repo', number: 5, title: 'a fake issue' })
    assert.equal(usesResult({ repo: 'fake-repo', number: 6 }, { repo: 'fake-repo', number: 5 }, json), false)
  })

  test('short strings do not count, and nested values do', () => {
    const json = JSON.stringify({ state: 'ok', parent: { key: 'FAKE-12' } })
    assert.equal(usesResult({ state: 'ok' }, {}, json), false)
    assert.equal(usesResult({ filter: { parents: ['FAKE-12'] } }, {}, json), true)
  })

  test('a string with a quote matches its JSON text', () => {
    const json = JSON.stringify({ next: 'say "hi"' })
    assert.equal(usesResult({ after: 'say "hi"' }, {}, json), true)
  })

  test('a result too large to scan, or too many new values for its length, counts as used: the calls get no note', () => {
    const ids = (n: number) => ({ ids: Array.from({ length: n }, (_, i) => `fake-id-${i}`) })
    const text = (length: number) => JSON.stringify('x'.repeat(length - 2))
    assert.equal(usesResult(ids(1), {}, text(MAX_SCAN_CHARS)), false)
    assert.equal(usesResult(ids(1), {}, text(MAX_SCAN_CHARS + 1)), true)
    // A batch of 100 ids against a small result scans.
    assert.equal(usesResult(ids(100), {}, text(1000)), false)
    const most20 = MAX_SCAN_WORK / 20 - VALUE_COST
    assert.equal(usesResult(ids(20), {}, text(most20)), false)
    assert.equal(usesResult(ids(21), {}, text(most20)), true)
    assert.equal(usesResult(ids(21), ids(1), text(most20)), false)
  })

  test('a call with thousands of new values counts as used, even against a tiny result', () => {
    const numbers = (n: number) => ({ n: Array.from({ length: n }, (_, i) => i) })
    assert.equal(usesResult(numbers(1000), {}, '{}'), false)
    assert.equal(usesResult(numbers(MAX_SCAN_WORK / VALUE_COST), {}, '{}'), true)
  })
})
