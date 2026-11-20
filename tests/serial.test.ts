import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_NEEDLE,
  MAX_REPLY_CHARS,
  MAX_SCAN_CHARS,
  MAX_SCAN_WORK,
  VALUE_COST,
  serialStreak,
  usesResult,
  type TimedCall,
} from '../src/core/serial.ts'
import { callKey } from '../src/core/protocol.ts'

// Calls of one tool, each sent `gap` ms after the reply before it, as a loop that awaits each call.
const loop = (ms: readonly number[], gap = 5): TimedCall[] => {
  const calls: TimedCall[] = []
  let at = 0
  ms.forEach((m, i) => {
    calls.push({
      id: i + 1,
      tool: 'mcp__x__get',
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

  test('a call the person approved breaks the streak', () => {
    const four = [1600, 1600, 1600, 1600]
    assert.equal(serialStreak(loop(four))?.calls, 4)
    const approved = loop(four).map(c => (c.id === 3 ? { ...c, plain: false } : c))
    assert.equal(serialStreak(approved), undefined)
  })

  test('calls of different tools are no streak', () => {
    const mixed = loop(SIX).map(c => (c.id % 2 === 0 ? { ...c, tool: 'mcp__x__list' } : c))
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
  const sent = (args: Record<string, unknown>) => ({ args, key: callKey('mcp__x__get', args) })
  const uses = (args: Record<string, unknown>, previousArgs: Record<string, unknown>, json: string) =>
    usesResult(sent(args), { ...sent(previousArgs), json })

  test('the same call again needs the reply: polling', () => {
    assert.equal(uses({ id: 'job-1' }, { id: 'job-1' }, JSON.stringify({ state: 'running' })), true)
  })

  test('a cursor or link from the previous result', () => {
    const json = JSON.stringify({ items: [1, 2], next_cursor: 'eyJwYWdlIjoyfQ', next: 'https://example.com/a?page=2' })
    assert.equal(uses({ cursor: 'eyJwYWdlIjoyfQ' }, {}, json), true)
    assert.equal(uses({ url: 'https://example.com/a?page=2' }, { url: 'https://example.com/a' }, json), true)
  })

  test('a number from the previous result counts only as a whole number', () => {
    const json = JSON.stringify({ offset: 0, limit: 50, total: 1234 })
    assert.equal(uses({ offset: 50 }, { offset: 0 }, json), true)
    assert.equal(uses({ offset: 123 }, { offset: 0 }, json), false)
    assert.equal(uses({ offset: 5 }, { offset: 0 }, json), false)
  })

  test('a value that the previous call also sent does not count', () => {
    const json = JSON.stringify({ repo: 'fake-repo', number: 5, title: 'a fake issue' })
    assert.equal(uses({ repo: 'fake-repo', number: 6 }, { repo: 'fake-repo', number: 5 }, json), false)
  })

  test('short strings do not count, and nested values do', () => {
    const json = JSON.stringify({ state: 'ok', parent: { key: 'FAKE-12' } })
    assert.equal(uses({ state: 'ok' }, {}, json), false)
    assert.equal(uses({ filter: { parents: ['FAKE-12'] } }, {}, json), true)
  })

  test('a long value counts as taken from the reply when its start is in the reply', () => {
    const body = 'x'.repeat(MAX_NEEDLE)
    assert.equal(uses({ body: `${body}-new-end` }, {}, JSON.stringify({ body: `${body}-old-end` })), true)
    assert.equal(uses({ body: `y${body}` }, {}, JSON.stringify({ body })), false)
  })

  test('a string with a quote matches its JSON text', () => {
    const json = JSON.stringify({ next: 'say "hi"' })
    assert.equal(uses({ after: 'say "hi"' }, {}, json), true)
  })

  test('a result too large to scan, or too many new values for its length, counts as used: the calls get no note', () => {
    const ids = (n: number) => ({ ids: Array.from({ length: n }, (_, i) => `fake-id-${i}`) })
    const text = (length: number) => JSON.stringify('x'.repeat(length - 2))
    assert.equal(uses(ids(1), {}, text(MAX_REPLY_CHARS)), false)
    assert.equal(uses(ids(1), {}, text(MAX_REPLY_CHARS + 1)), true)
    // A batch of 100 ids against a small result scans.
    assert.equal(uses(ids(100), {}, text(1000)), false)
    const most20 = MAX_SCAN_WORK / 20 - VALUE_COST
    assert.equal(uses(ids(20), {}, text(most20)), false)
    assert.equal(uses(ids(21), {}, text(most20)), true)
    assert.equal(uses(ids(21), ids(1), text(most20)), false)
  })

  test('a call with thousands of new values counts as used, even against a tiny result', () => {
    const numbers = (n: number) => ({ n: Array.from({ length: n }, (_, i) => i) })
    assert.equal(uses(numbers(1000), {}, '{}'), false)
    assert.equal(uses(numbers(MAX_SCAN_WORK / VALUE_COST), {}, '{}'), true)
  })

  test('arguments of a million values, and a streak of 150,000 calls, stay fast and do not throw', () => {
    const million = 1_000_000
    const large = [
      { n: Array.from({ length: million }, (_, i) => i) },
      Object.fromEntries(Array.from({ length: million }, (_, i) => [`k${i}`, i])),
      { s: Array<string>(million).fill('abcd') },
      { s: Array<null>(million).fill(null) },
    ].map(sent)
    // The largest arguments that the check walks: many small values, as many keys as fit.
    const walked = [
      Object.fromEntries(Array.from({ length: 16_000 }, (_, i) => [`k${i}`, i])),
      { s: Array<string>(35_000).fill('abcd') },
      { s: Array.from({ length: 80_000 }, () => []) },
      { s: Array.from({ length: 35_000 }, (_, i) => i) },
    ].map(sent)
    for (const call of walked) assert.ok(call.key.length <= MAX_SCAN_CHARS, `${call.key.length}`)
    const timed = (call: ReturnType<typeof sent>, previous: ReturnType<typeof sent>) => {
      const began = performance.now()
      const used = usesResult(call, { ...previous, json: '{}' })
      const ms = performance.now() - began
      assert.ok(ms < 300, `${call.key.slice(0, 40)}: ${ms} ms`)
      return used
    }
    const small = sent({ id: 'item-1' })
    for (const call of large) {
      assert.equal(timed(call, small), true)
      assert.equal(timed(small, call), true)
    }
    for (const call of walked) timed(call, walked.find(w => w !== call)!)
    // The slowest scans: short values that share their start with a reply of one repeated character, and long
    // values against a reply of long runs, which V8 scans one character at a time.
    const scan = (values: string[], text: string) => {
      const began = performance.now()
      assert.equal(usesResult(sent({ s: values }), { ...small, json: JSON.stringify(text) }), false)
      const ms = performance.now() - began
      assert.ok(ms < 300, `${values[0]!.length} characters: ${ms} ms`)
    }
    const letter = (i: number) => String.fromCharCode(99 + i)
    scan(
      Array.from({ length: 19 }, (_, i) => `aaaaa${letter(i)}`),
      'a'.repeat(MAX_SCAN_CHARS - 2),
    )
    scan(
      Array.from({ length: 19 }, (_, i) => `a${letter(i)}${'a'.repeat(12_000)}`),
      `b${'a'.repeat(11_999)}`.repeat(21).slice(0, MAX_SCAN_CHARS - 2),
    )
    assert.equal(serialStreak(loop(Array.from({ length: 150_000 }, () => 20)))?.calls, 150_000)
  })
})
