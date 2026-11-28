// The conformance matrix of the 2026-07-28 revision (tests/conformance.json): a later PR cannot drop a row, or mark one
// covered with no test (issue #154, C0).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPENINGS } from './modern-client.mjs'
import { HTTP_KINDS, STDIO_KINDS } from './modern-core.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8')
const matrix = JSON.parse(read('conformance.json')) as { rows: Row[] }
type Row = {
  side: 'upstream' | 'downstream'
  kind: string
  link: string
  flag: string
  expect: string
  asRead?: string
  source?: string
  status: string
  owner?: string
  file?: string
  test?: string
  note?: string
}
const key = (r: Pick<Row, 'side' | 'kind' | 'link' | 'flag'>) => [r.side, r.kind, r.link, r.flag].join(' | ')

// What the peers offer: the lists that the peer files export (a peer refuses a kind that is not in them).
const STDIO = STDIO_KINDS
const HTTP = HTTP_KINDS
const FLAGS = ['legacy', 'auto']
const expected = (): string[] => [
  ...STDIO.flatMap(kind =>
    ['direct', 'lazy', 'shared'].flatMap(link => FLAGS.map(flag => key({ side: 'downstream', kind, link, flag }))),
  ),
  ...HTTP.flatMap(kind => FLAGS.map(flag => key({ side: 'downstream', kind, link: 'http', flag }))),
  ...[
    ['probe-401', 'http-oauth'],
    ['legacy', 'http-oauth'],
    ['modern', 'http-oauth'],
    ['legacy', 'http-sigv4'],
    ['modern', 'http-sigv4'],
    ['claude-mcp-serve', 'bridge'],
  ].flatMap(([kind, link]) => FLAGS.map(flag => key({ side: 'downstream', kind: kind!, link: link!, flag }))),
  ...Object.keys(OPENINGS).flatMap(kind =>
    FLAGS.map(flag => key({ side: 'upstream', kind, link: 'upstream-stdio', flag })),
  ),
]

describe('the matrix', () => {
  test('parses, and holds no two equal rows', () => {
    assert.ok(Array.isArray(matrix.rows) && matrix.rows.length > 0)
    const keys = matrix.rows.map(key)
    assert.deepEqual(
      keys.filter((k, i) => keys.indexOf(k) !== i),
      [],
    )
  })

  test('has a row for every combination that the peers offer, and no row for another', () => {
    assert.deepEqual([...matrix.rows.map(key)].sort(), [...expected()].sort())
  })

  test('the openings are the six that the bar names', () => {
    assert.deepEqual(Object.keys(OPENINGS).sort(), [
      'claude-code-auto',
      'claude-code-legacy',
      'legacy',
      'modern',
      'probe-sibling',
      'probe-then-initialize',
    ])
  })

  test('every row has an expect of the 3 forms and a source for it', () => {
    for (const r of matrix.rows) {
      assert.match(r.expect, /^(legacy session|modern session|error: .+)$/, key(r))
      assert.ok(typeof r.source === 'string' && r.source.length > 0, `${key(r)} has no source`)
      assert.ok(!r.asRead || r.asRead.startsWith('as read'), key(r))
      if (r.asRead)
        assert.match(r.source!, /public-CvV4ZHkX\.mjs:\d+/, `${key(r)}: an "as read" cell names the client line`)
    }
  })

  test('a pending row names the PR that owns it, a covered row a file and a test name that exist, a manual row a file', () => {
    for (const r of matrix.rows) {
      if (r.status === 'pending') {
        assert.ok(['10', '12', '13', '13b', 'S2'].includes(r.owner ?? ''), `${key(r)}: owner ${r.owner}`)
      } else if (r.status === 'covered') {
        assert.ok(r.file && r.test, `${key(r)} is covered with no file and test`)
        const file = path.join(dir, '..', r.file)
        assert.ok(fs.existsSync(file), `${key(r)}: ${r.file} does not exist`)
        assert.ok(fs.readFileSync(file, 'utf8').includes(r.test), `${key(r)}: the test name is not in ${r.file}`)
      } else if (r.status === 'manual') {
        // Only the real Claude Code bridge is run by hand.
        assert.equal(r.link, 'bridge', `${key(r)}: a manual row is the bridge`)
        assert.ok(r.file && fs.existsSync(path.join(dir, '..', r.file)), key(r))
      } else {
        assert.fail(`${key(r)}: status ${r.status}`)
      }
    }
  })

  test('the legacy rows that a test of today proves are covered, and the others of the modern work are pending', () => {
    // The flag `legacy` is the behavior of 1.0.x, which today's tests prove. A row of `auto` is covered by the PR that gives its
    // side the modern protocol: the upstream rows with PR 13, the downstream rows with PR 10 and 12.
    for (const r of matrix.rows.filter(r => r.status === 'covered' && r.side !== 'upstream'))
      assert.equal(r.flag, 'legacy', key(r))
    for (const r of matrix.rows.filter(r => r.flag === 'auto' && r.side !== 'upstream'))
      assert.notEqual(r.status, 'covered', key(r))
  })
})
