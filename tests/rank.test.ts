import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { listsAll, rankTools, type ToolEntry } from '../src/core/protocol.ts'

type Servers = Record<string, [string, string][]>
type Queries = [string, string][]

const load = (file: string): { servers?: Servers; queries: Queries } =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', file), 'utf8'))
const toCatalog = (servers: Servers): ToolEntry[] =>
  Object.entries(servers).flatMap(([server, tools]) =>
    tools.map(([tool, description]) => ({ name: `mcp__${server}__${tool}`, description })),
  )

const tuning = load('rank-catalog.json')
const catalog = toCatalog(tuning.servers!)
const heldOutA = load('rank-heldout-a.json')
const heldOutB = load('rank-heldout-b.json')
const catalogB = toCatalog(heldOutB.servers!)
const dotted: ToolEntry[] = [
  ...catalog,
  { name: 'mcp__fs__files.read', description: 'Read a file' },
  { name: 'mcp__fs__files.list', description: 'List files' },
]

const rankOf = (tools: readonly ToolEntry[], query: string, wanted: string): number => {
  const i = rankTools(tools, query, tools.length).findIndex(t => t.name === wanted)
  return i < 0 ? Infinity : i + 1
}

const score = (tools: readonly ToolEntry[], queries: Queries) => {
  for (const [, wanted] of queries)
    assert.ok(
      tools.some(t => t.name === wanted),
      `no tool ${wanted}`,
    )
  const ranks = queries.map(([query, wanted]) => rankOf(tools, query, wanted))
  return {
    top1: ranks.filter(r => r === 1).length,
    mrr: ranks.reduce((sum, r) => sum + 1 / r, 0) / ranks.length,
  }
}

describe('rankTools on three sets of searches', () => {
  // The floors sit 2 top-1 points and about 0.01 MRR under the measured values. A later rule that is no worse out of
  // sample must pass. The first set tuned the rule: the other two did not. Measured, before #49 -> now:
  // tuning set 65 -> 69 (MRR 0.855 -> 0.894), set A 107 -> 111 (0.920 -> 0.939), set B 101 -> 101 (0.910 -> 0.909).
  const sets: [string, readonly ToolEntry[], Queries, number, number][] = [
    ['tuning set: 84 searches on 140 tools', catalog, tuning.queries, 67, 0.88],
    ['held-out set A: 122 searches on the same 140 tools', catalog, heldOutA.queries, 109, 0.93],
    ['held-out set B: 114 searches on 200 other tools', catalogB, heldOutB.queries, 99, 0.9],
  ]
  for (const [label, tools, queries, top1Floor, mrrFloor] of sets)
    test(label, () => {
      const { top1, mrr } = score(tools, queries)
      const got = `top-1 ${top1} of ${queries.length}, MRR ${mrr.toFixed(3)}`
      assert.ok(top1 >= top1Floor && mrr >= mrrFloor, `${got}, floors ${top1Floor} and ${mrrFloor}`)
    })

  const first: [string, string, readonly ToolEntry[]][] = [
    ['mcp__azure-devops__work', 'mcp__azure-devops__work', catalog],
    ['search wiki', 'mcp__azure-devops__search_wiki', catalog],
    ['read file', 'mcp__filesystem__read_file', catalog],
    ['memory search', 'mcp__memory__search_nodes', catalog],
    ['azure devops create branch', 'mcp__azure-devops__repo_create_branch', catalog],
    ['mcp__fs__files.read', 'mcp__fs__files.read', dotted],
    ['files.read', 'mcp__fs__files.read', dotted],
    ['use mcp__github__get_issue.', 'mcp__github__get_issue', catalog],
  ]
  for (const [query, wanted, tools] of first)
    test(`"${query}" ranks ${wanted} first`, () => {
      assert.equal(rankTools(tools, query, 1)[0]?.name, wanted)
    })

  test('words of the name and the server key list the tools that hold all of them first', () => {
    const found = rankTools(catalog, 'github pull request', 6).map(t => t.name)
    assert.ok(found.includes('mcp__github__get_pull_request'))
    assert.ok(found.every(n => n.startsWith('mcp__github__') && n.includes('pull_request')))
  })

  test('a server name lists the tools of that server before a tool that names it in its description', () => {
    const tools = [...catalog, { name: 'mcp__docs__lookup', description: 'Look up Azure DevOps documentation' }]
    const found = rankTools(tools, 'azure devops', 100).map(t => t.name)
    assert.equal(found.length, 45)
    assert.equal(found.at(-1), 'mcp__docs__lookup')
  })

  test('a server name lists the tools of that server in name order', () => {
    const found = rankTools(catalog, 'google drive', 10).map(t => t.name)
    assert.deepEqual(found, [
      'mcp__google_drive__create_file',
      'mcp__google_drive__read_file',
      'mcp__google_drive__search',
    ])
  })

  test('a hostile query of 50,000 characters ranks in well under 100 ms', () => {
    rankTools(catalog, 'warm up the regex and the JIT', 10)
    for (const unit of ['-', '.', 'a-', '_.-']) {
      const query = `${unit.repeat(Math.ceil(50_000 / unit.length)).slice(0, 49_999)}a`
      const start = performance.now()
      rankTools(catalog, query, 10)
      const ms = performance.now() - start
      assert.ok(ms < 100, `${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`)
    }
  })

  test('a cut that splits a tool name drops the partial name', () => {
    const name = 'mcp__github__get_issue_comments'
    const prose = 'a '.repeat(489)
    const query = `${prose}${'b'.repeat(978 - prose.length)}${name}`
    assert.equal(query.slice(0, 1000), `${query.slice(0, 978)}mcp__github__get_issue`)
    assert.deepEqual(
      rankTools(catalog, query, 3).map(t => t.name),
      rankTools(catalog, query.slice(0, 978), 3).map(t => t.name),
    )
    assert.notEqual(rankTools(catalog, query, 1)[0]?.name, 'mcp__github__get_issue')
  })

  test('only the first 1,000 characters of a query count', () => {
    const tail = ` ${'x'.repeat(2000)} mcp__github__get_issue`
    assert.deepEqual(
      rankTools(catalog, `search wiki${tail}`, 3).map(t => t.name),
      rankTools(catalog, 'search wiki', 3).map(t => t.name),
    )
  })

  test('a query whose words all come after the cut lists every tool, and listsAll says so', () => {
    const query = `${' '.repeat(1000)}jira issue`
    assert.equal(listsAll(query), true)
    assert.equal(rankTools(catalog, query, catalog.length).length, catalog.length)
    assert.equal(listsAll('jira issue'), false)
  })
})
