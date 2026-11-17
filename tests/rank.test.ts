import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rankTools, type ToolEntry } from '../src/core/protocol.ts'

type Fixture = { servers: Record<string, [string, string][]>; queries: [string, string][] }

const fixture: Fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'rank-catalog.json'), 'utf8'),
)
const catalog: ToolEntry[] = Object.entries(fixture.servers).flatMap(([server, tools]) =>
  tools.map(([tool, description]) => ({ name: `mcp__${server}__${tool}`, description })),
)
const dotted: ToolEntry[] = [
  ...catalog,
  { name: 'mcp__fs__files.read', description: 'Read a file' },
  { name: 'mcp__fs__files.list', description: 'List files' },
]

const rankOf = (tools: readonly ToolEntry[], query: string, wanted: string): number => {
  const i = rankTools(tools, query, tools.length).findIndex(t => t.name === wanted)
  return i < 0 ? Infinity : i + 1
}

describe('rankTools on a catalog of 140 tools from 13 servers', () => {
  test('ranks the wanted tool of 84 searches first more often than the rule before #49', () => {
    const ranks = fixture.queries.map(([query, wanted]) => rankOf(catalog, query, wanted))
    const top1 = ranks.filter(r => r === 1).length
    const top3 = ranks.filter(r => r <= 3).length
    const mrr = ranks.reduce((sum, r) => sum + 1 / r, 0) / ranks.length
    const got = `top-1 ${top1}, top-3 ${top3}, MRR ${mrr.toFixed(3)} (before #49: 65, 78, 0.855)`
    assert.ok(top1 >= 78 && top3 >= 83 && mrr >= 0.955, got)
  })

  const first: [string, string, readonly ToolEntry[]][] = [
    ['mcp__azure-devops__work', 'mcp__azure-devops__work', catalog],
    ['search wiki', 'mcp__azure-devops__search_wiki', catalog],
    ['github pull request', 'mcp__github__get_pull_request', catalog],
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
})
