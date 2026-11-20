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
  // Then the stem of a plural word (#58): 69 (0.894), 111 (0.939), 101 (0.909 -> 0.911). A stem hit of 2 cost the
  // tuning set one top-1 (68, 0.880). Then the filler gate (#64): 69 (0.894), 111 -> 112 (0.939 -> 0.947), 101 -> 103
  // (0.911 -> 0.932). Then a stem hit of 0.5 instead of 1, below a description hit: 69 (0.894), 112 (0.947),
  // 103 -> 104 (0.932 -> 0.938). A stem that cuts "ies", "es" only after s, x, z, ch or sh, else "s", left all three.
  // Then "pr", "prs", "mr", "mrs" and a word written together from name words (#67): 69 (0.894), 112 -> 114
  // (0.947 -> 0.961), 104 -> 107 (0.938 -> 0.961).
  const sets: [string, readonly ToolEntry[], Queries, number, number][] = [
    ['tuning set: 84 searches on 140 tools', catalog, tuning.queries, 67, 0.88],
    ['held-out set A: 122 searches on the same 140 tools', catalog, heldOutA.queries, 112, 0.95],
    ['held-out set B: 114 searches on 200 other tools', catalogB, heldOutB.queries, 105, 0.95],
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

  describe('plural words of a query', () => {
    const tools: ToolEntry[] = [
      { name: 'mcp__azure-devops__pipelines_build', description: 'Show the status of one build of a pipeline run' },
      { name: 'mcp__azure-devops__repo_branch', description: 'Show a branch of a repository' },
      { name: 'mcp__azure-devops__wiki_page', description: 'Read a wiki page' },
      { name: 'mcp__atlassian__get_issue', description: 'Get a Jira issue and its status' },
      { name: 'mcp__atlassian__get_issue_fields', description: 'Get the fields of a Jira issue' },
      { name: 'mcp__atlassian__get_project', description: 'Get a Jira project' },
      { name: 'mcp__github__list_workflow_runs', description: 'List the runs of a workflow' },
      { name: 'mcp__github__list_branches', description: 'List the branches of a repository' },
    ]
    for (const query of ['builds', 'pipelines get builds status branch'])
      test(`"${query}" ranks pipelines_build first when its description lacks "builds"`, () => {
        assert.equal(rankTools(tools, query, 1)[0]?.name, 'mcp__azure-devops__pipelines_build')
      })

    // pipelines_build's description holds "builds", and pipelines_artifact's holds only "build" (#58).
    const real: [string, string, readonly ToolEntry[]][] = [
      ['builds', 'mcp__azure-devops__pipelines_build', catalog],
      ['pipelines builds', 'mcp__azure-devops__pipelines_build', catalog],
      ['pipelines get builds status branch', 'mcp__azure-devops__pipelines_build', catalog],
      ['wikis', 'mcp__azure-devops__wiki', catalog],
      ['pull request review comments', 'mcp__github__get_pull_request_comments', catalogB],
    ]
    for (const [query, wanted, set] of real)
      test(`"${query}" ranks the tool that holds the full word above one that holds its stem`, () => {
        assert.equal(rankTools(set, query, 1)[0]?.name, wanted)
      })

    test('a plural word finds a singular that ends in "y" or has 3 letters', () => {
      const singular: ToolEntry[] = [
        { name: 'mcp__sec__get_cve', description: 'Get one CVE record' },
        { name: 'mcp__gh__get_repository', description: 'Get a repository' },
        { name: 'mcp__pg__run_query', description: 'Run a SQL query' },
        { name: 'mcp__kv__get_policy', description: 'Read an access policy' },
      ]
      for (const [query, wanted] of [
        ['cves', 'mcp__sec__get_cve'],
        ['repositories', 'mcp__gh__get_repository'],
        ['queries', 'mcp__pg__run_query'],
        ['policies', 'mcp__kv__get_policy'],
      ])
        assert.deepEqual(
          rankTools(singular, query, 5).map(t => t.name),
          [wanted],
          query,
        )
    })

    test('the stem of a plural word keeps the "e" of its singular', () => {
      const found = (tools: readonly ToolEntry[], query: string) =>
        rankTools(tools, query, tools.length).map(t => t.name)
      // "sit", "fil" and "not" would match "repository", "filters" and "notifications".
      assert.ok(!found(catalog, 'sites').includes('mcp__azure-devops__repo_branch'))
      assert.ok(!found(catalog, 'files').includes('mcp__github__list_issues'))
      assert.ok(!found(catalogB, 'notes').includes('mcp__github__list_notifications'))
    })

    test('a plural word still finds the singular name, a short word is not cut', () => {
      assert.equal(rankTools(tools, 'branches', 1)[0]?.name, 'mcp__github__list_branches')
      assert.deepEqual(rankTools(tools, 'bus', 5), [])
      assert.deepEqual(rankTools(tools, 'class', 5), [])
      // A word that ends in "ss" is not cut, so "class" does not find "clash" through "clas".
      const clash = [{ name: 'mcp__x__list_clash', description: 'List each clash' }]
      assert.deepEqual(rankTools(clash, 'class', 5), [])
    })
  })

  describe('filler words of a query', () => {
    const tools: ToolEntry[] = [
      ...['local', 'sit', 'uat'].map(s => ({
        name: `mcp__grafana-${s}__get_dashboard_by_uid`,
        description: 'Get a dashboard by its uid',
      })),
      { name: 'mcp__azure-devops__repo_pull_request', description: 'Show a pull request' },
      { name: 'mcp__github__get_pull_request', description: 'Get a pull request of a repository' },
      { name: 'mcp__github__list_pull_requests', description: 'List the pull requests of a repository' },
      { name: 'mcp__github__get_me', description: 'Get the signed-in user' },
      { name: 'mcp__github__list_issues', description: 'List the issues of a repository' },
    ]
    const names = (query: string, limit = 10) => rankTools(tools, query, limit).map(t => t.name)

    test('filler words do not lift a tool that holds no other word of the query', () => {
      const found = rankTools(tools.slice(0, 4), 'pull request get by id', 4).map(t => t.name)
      assert.deepEqual(found, ['mcp__azure-devops__repo_pull_request'])
    })

    test('a query of only filler words still lists the tools that hold them', () => {
      assert.ok(names('get').some(n => n.includes('__get_')))
      assert.deepEqual(
        names('list by id').filter(n => n.includes('__list_')),
        ['mcp__github__list_issues', 'mcp__github__list_pull_requests'],
      )
    })

    test('a filler word still breaks a tie between tools that hold a real word', () => {
      const found = names('get pull request')
      assert.equal(found[0], 'mcp__github__get_pull_request')
      assert.ok(found.indexOf('mcp__github__list_pull_requests') > 0)
    })

    test('an exact short name that holds a filler word ranks first', () => {
      assert.equal(names('get_me', 1)[0], 'mcp__github__get_me')
    })

    test('when no tool holds the real word of a query, the filler words still list tools', () => {
      // "tickets" and "ticket" are in no tool: the right tool must stay in the list, as before the gate.
      assert.ok(names('list tickets').includes('mcp__github__list_pull_requests'))
      assert.ok(names('get ticket').includes('mcp__github__get_pull_request'))
    })
  })

  describe('abbreviations and joined words of a query', () => {
    const servers: Servers = {
      'azure-devops': [
        'repo_list_pull_requests_by_repo_or_project',
        'repo_get_pull_request_by_id',
        'core_list_projects',
        'wit_get_work_item',
        'wit_create_work_item',
        'wit_my_work_items',
      ].map(t => [t, '']),
      github: ['list_pull_requests', 'pull_request_read', 'create_pull_request'].map(t => [t, '']),
      gitlab: ['create_merge_request', 'list_merge_requests', 'get_merge_request'].map(t => [t, '']),
      bitbucket: [['getPullRequest', '']],
      atlassian: ['getVisibleJiraProjects', 'createJiraIssue'].map(t => [t, '']),
      grafana: ['query_prometheus', 'get_dashboard_property', 'list_datasources'].map(t => [t, '']),
      filesystem: ['read_text_file', 'list_directory'].map(t => [t, '']),
      tracker: [['createWorkitem', '']],
    }
    const r = toCatalog(servers)
    const short = (tools: readonly ToolEntry[], query: string, limit = tools.length) =>
      rankTools(tools, query, limit).map(t => t.name.replace(/^mcp__.+?__/, ''))
    const pullRequests = [
      'repo_list_pull_requests_by_repo_or_project',
      'repo_get_pull_request_by_id',
      'list_pull_requests',
      'pull_request_read',
      'create_pull_request',
      'getPullRequest',
    ]
    const mergeRequests = ['create_merge_request', 'list_merge_requests', 'get_merge_request']
    const sameSet = (found: string[], wanted: string[]) => assert.deepEqual([...found].sort(), [...wanted].sort())

    test('"pr" lists the 6 pull request tools and no project tool', () => {
      sameSet(short(r, 'pr', 20), pullRequests)
    })

    test('"prs" and "mrs" list the singular names too, the plural names first', () => {
      const prs = short(r, 'prs', 20)
      sameSet(prs, pullRequests)
      sameSet(prs.slice(0, 2), ['repo_list_pull_requests_by_repo_or_project', 'list_pull_requests'])
      sameSet(short(r, 'mrs', 20), mergeRequests)
      assert.equal(short(r, 'mrs', 1)[0], 'list_merge_requests')
      sameSet(short(r, 'mr', 20), mergeRequests)
    })

    test('an abbreviation with other words ranks the tool of its action first', () => {
      assert.equal(short(r, 'get pr by id', 1)[0], 'repo_get_pull_request_by_id')
      assert.equal(short(r, 'create pr', 1)[0], 'create_pull_request')
      assert.equal(short(r, 'create mr', 1)[0], 'create_merge_request')
      sameSet(short(r, 'list prs', 2), ['repo_list_pull_requests_by_repo_or_project', 'list_pull_requests'])
    })

    test('an abbreviation ranks the tool first on the tuning set and the held-out set', () => {
      for (const [query, wanted] of [
        ['get pr', 'mcp__github__get_pull_request'],
        ['merge a pr', 'mcp__github__merge_pull_request'],
        ['pr comments', 'mcp__azure-devops__repo_pull_request_thread'],
      ])
        assert.equal(rankTools(catalog, query, 1)[0]?.name, wanted, query)
      for (const [query, wanted] of [
        ['list prs', 'mcp__github__list_pull_requests'],
        ['pr comments', 'mcp__github__get_pull_request_comments'],
        ['get mr', 'mcp__gitlab__get_merge_request'],
        ['list mrs', 'mcp__gitlab__list_merge_requests'],
      ])
        assert.equal(rankTools(catalogB, query, 1)[0]?.name, wanted, query)
    })

    test('"prs" lists all 10 github pull request tools, get_pull_request_status not above get_pull_request', () => {
      const found = rankTools(catalogB, 'prs', 15).map(t => t.name)
      const github = catalogB.map(t => t.name).filter(n => n.startsWith('mcp__github__') && n.includes('pull_request'))
      assert.equal(github.length, 10)
      for (const n of github) assert.ok(found.includes(n), n)
      assert.ok(found.indexOf('mcp__github__get_pull_request') < found.indexOf('mcp__github__get_pull_request_status'))
    })

    test('"pr" lists a tool whose description holds it as a word, below the tools whose name matches', () => {
      const tools: ToolEntry[] = [
        { name: 'mcp__x__merge', description: 'Merge a PR into its base' },
        { name: 'mcp__x__list_projects', description: 'List the projects and the sprint of a team' },
        { name: 'mcp__x__get_pr', description: 'Read one' },
      ]
      assert.deepEqual(
        rankTools(tools, 'pr', 5).map(t => t.name),
        ['mcp__x__get_pr', 'mcp__x__merge'],
      )
    })

    test('the words that matched before still rank the same', () => {
      assert.equal(short(r, 'list projects', 1)[0], 'core_list_projects')
      assert.equal(rankTools(catalogB, 'user profile', 1)[0]?.name, 'mcp__atlassian__jira_get_user_profile')
      assert.equal(rankTools(catalogB, 'press key', 1)[0]?.name, 'mcp__chrome-devtools__press_key')
      assert.equal(rankTools(catalogB, 'sprint', 1)[0]?.name.endsWith('jira_get_sprints_from_board'), true)
      assert.deepEqual(short(r, 'print'), [])
    })

    test('"workitem" lists the name as written first, then the plural and singular names', () => {
      assert.deepEqual(short(r, 'workitem', 10), [
        'createWorkitem',
        'wit_create_work_item',
        'wit_get_work_item',
        'wit_my_work_items',
      ])
    })

    test('a word written together finds the tool that splits it', () => {
      assert.equal(short(r, 'get workitem', 1)[0], 'wit_get_work_item')
      assert.equal(short(r, 'my workitems', 1)[0], 'wit_my_work_items')
      assert.equal(short(r, 'textfile', 1)[0], 'read_text_file')
      sameSet(short(r, 'pullrequest', 20), pullRequests)
    })

    test('a word written together ranks the tool first on the tuning set and the held-out set', () => {
      assert.equal(rankTools(catalog, 'workitem', 1)[0]?.name, 'mcp__azure-devops__search_workitem')
      const top = rankTools(catalog, 'workitem', 5).map(t => t.name)
      assert.ok(top.filter(n => n.includes('wit_work_item')).length >= 4, top.join(' '))
      for (const [query, wanted] of [
        ['create workitem', 'mcp__azure-devops__wit_work_item_write'],
        ['update workitem', 'mcp__azure-devops__wit_work_item_write'],
        ['workitem comment', 'mcp__azure-devops__wit_work_item_comment_write'],
      ])
        assert.equal(rankTools(catalog, query, 1)[0]?.name, wanted, query)
      assert.equal(rankTools(catalogB, 'get mergerequest', 1)[0]?.name, 'mcp__gitlab__get_merge_request')
    })

    test('a joined word starts and ends at the borders of name words', () => {
      const tools: ToolEntry[] = [
        { name: 'mcp__x__a_list_schemas', description: 'Schemas' },
        { name: 'mcp__x__b_notes', description: 'Keeps lists' },
        { name: 'mcp__x__get_map_items', description: 'Items of a map' },
      ]
      // "lists" is not "list" + "schemas" cut in the middle, and a word of 3 letters never joins.
      assert.equal(rankTools(tools, 'lists', 1)[0]?.name, 'mcp__x__b_notes')
      assert.deepEqual(rankTools(tools, 'api', 5), [])
      assert.equal(rankTools(tools, 'mapitems', 1)[0]?.name, 'mcp__x__get_map_items')
    })

    test('words that already matched through a substring still match', () => {
      sameSet(short(r, 'work item', 10), [
        'wit_create_work_item',
        'wit_get_work_item',
        'wit_my_work_items',
        'createWorkitem',
      ])
      assert.deepEqual(short(r, 'data source'), ['list_datasources'])
      assert.deepEqual(short(r, 'datasource'), ['list_datasources'])
      assert.deepEqual(short(r, 'text file'), ['read_text_file'])
    })
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

  test('a query of 50,000 characters of plural words ranks in well under 100 ms', () => {
    rankTools(catalog, 'warm up the regex and the JIT', 10)
    // No tool holds "queries", "attachments" or "qzxes", so each tool is matched by the stem of each word that the
    // 1000-character cut keeps. The fastest of 3 runs counts, so a busy CI machine does not fail the test.
    for (const unit of ['queries ', 'attachments qzxes ', 'pr mrs ', 'workitem pullrequests ']) {
      const query = unit.repeat(Math.ceil(50_000 / unit.length))
      let ms = Infinity
      let found: ToolEntry[] = []
      for (let run = 0; run < 3; run++) {
        const start = performance.now()
        found = rankTools(catalog, query, 10)
        ms = Math.min(ms, performance.now() - start)
      }
      assert.ok(found.length > 0, `${JSON.stringify(unit)} found no tool through the stem`)
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
