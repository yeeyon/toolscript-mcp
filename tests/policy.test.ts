import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, type Config } from '../src/core/config.ts'
import {
  approvalNote,
  askText,
  checkCall,
  decide,
  deniedReport,
  matches,
  planRun,
  refusedReport,
  type Policy,
} from '../src/core/policy.ts'
import { argSpec } from '../src/core/catalog.ts'
import { normalizePath, appPath } from '../src/core/paths.ts'
import { keep, newKept, recallReply, MAX_KEPT } from '../src/core/protocol.ts'

const parse = (value: unknown, platform = 'linux') =>
  parseConfig(JSON.stringify({ mcpServers: {}, ...(value as object) }), {}, '/usr/bin/node', platform)
const config = (value: unknown, platform = 'linux'): Config => {
  const parsed = parse(value, platform)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'))
  return parsed.config
}
const errors = (value: unknown, platform = 'linux'): string[] => {
  const parsed = parse(value, platform)
  assert.equal(parsed.ok, false)
  return parsed.ok ? [] : parsed.errors
}
const policy = (...rules: [string, 'allow' | 'deny' | 'ask'][]): Policy =>
  config({ policy: rules.map(([match, action]) => ({ match, action })) }).policy

describe('policy rules', () => {
  test('a glob matches the whole name, and * matches any characters, __ too', () => {
    assert.equal(matches('mcp__bench__*', 'mcp__bench__create_ticket'), true)
    assert.equal(matches('mcp__bench__*', 'mcp__benchmark__x'), false)
    assert.equal(matches('mcp__*__list_*', 'mcp__a__list_issues'), true)
    assert.equal(matches('mcp__*', 'mcp__a__b__c'), true)
    assert.equal(matches('*', 'mcp__a__b'), true)
    assert.equal(matches('mcp__a__get', 'mcp__a__get_all'), false)
    assert.equal(matches('mcp__a.b__x', 'mcp__aXb__x'), false, 'a dot is a dot')
    assert.equal(matches('mcp__a__(x|y)', 'mcp__a__x'), false, 'no regular expression')
  })

  test('the first rule that matches wins, in config order', () => {
    const p = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__bench__*', 'allow'], ['mcp__*', 'deny'])
    assert.deepEqual(decide(p, 'mcp__bench__create_ticket'), { action: 'deny', rule: p[0] })
    assert.deepEqual(decide(p, 'mcp__bench__list_issues'), { action: 'allow', rule: p[1] })
    assert.deepEqual(decide(p, 'mcp__other__x'), { action: 'deny', rule: p[2] })
    const reversed = policy(['mcp__bench__*', 'allow'], ['mcp__bench__create_ticket', 'deny'])
    assert.equal(decide(reversed, 'mcp__bench__create_ticket').action, 'allow')
  })

  test('a tool that no rule matches is ask, with no rule', () => {
    assert.deepEqual(decide([], 'mcp__a__b'), { action: 'ask' })
    assert.deepEqual(decide(policy(['mcp__x__*', 'allow']), 'mcp__a__b'), { action: 'ask' })
    assert.deepEqual(config({}).policy, [])
  })

  test('each rule error points to the bad rule', () => {
    assert.deepEqual(
      errors({
        policy: [
          { match: 'mcp__a__*', action: 'allow' },
          { match: 'bench__create_ticket', action: 'deny' },
          { match: 'mcp__b__*', action: 'permit' },
          { match: '', action: 'ask', why: 'x' },
          'mcp__c__*',
          { action: 'deny' },
        ],
      }),
      [
        'policy[1].match: must be a glob over mcp__<server>__<tool>, such as "mcp__github__*", not "bench__create_ticket"',
        'policy[2].action: must be "allow", "deny" or "ask", not "permit"',
        'policy[3].why: unknown key (known: match, action)',
        'policy[3].match: must be a glob over mcp__<server>__<tool>, such as "mcp__github__*", not ""',
        'policy[4]: must be an object with "match" and "action"',
        'policy[5].match: must be a glob over mcp__<server>__<tool>, such as "mcp__github__*", not undefined',
      ],
    )
    assert.deepEqual(errors({ policy: { 'mcp__a__*': 'allow' } }), [
      'policy: must be an array of rules, such as [{ "match": "mcp__github__*", "action": "allow" }]',
    ])
  })

  test('a rule keeps its place in the config, for messages', () => {
    const p = policy(['mcp__a__*', 'allow'], ['mcp__b__x', 'deny'])
    assert.deepEqual(
      p.map(r => r.index),
      [0, 1],
    )
  })
})

describe('the sandbox config', () => {
  test('timeoutSeconds is 120 by default and at least 5', () => {
    assert.equal(config({}).sandbox.timeoutSeconds, 120)
    assert.equal(config({ sandbox: { timeoutSeconds: 5 } }).sandbox.timeoutSeconds, 5)
    for (const t of [4, 0, -1, 2.5, '30', 86_401, null])
      assert.deepEqual(errors({ sandbox: { timeoutSeconds: t } }), [
        `sandbox.timeoutSeconds: must be a whole number of seconds from 5 to 86400, not ${JSON.stringify(t)}`,
      ])
  })

  test('on Windows a bare node is refused, because the sandbox has no PATH', () => {
    const [error] = errors({ sandbox: { node: 'node' } }, 'win32')
    assert.match(error!, /^sandbox\.node: on Windows, give the full path of node\.exe/)
    assert.match(error!, /the sandbox has no PATH$/)
    assert.equal(config({ sandbox: { node: 'C:\\nodejs\\node.exe' } }, 'win32').sandbox.node, 'C:\\nodejs\\node.exe')
    assert.equal(config({ sandbox: { node: 'node' } }, 'linux').sandbox.node, 'node')
    assert.equal(config({}, 'win32').sandbox.node, '/usr/bin/node', 'the default is the host Node')
  })
})

describe('the decision before a run', () => {
  const call = (tool: string, line = 1) => ({ tool, line, keys: [] })
  const p = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__bench__*', 'allow'], ['mcp__ops__*', 'ask'])

  test('a deny rule on a literal name refuses the run and names the rule', () => {
    const plan = planRun(p, [call('mcp__bench__list_issues'), call('mcp__bench__create_ticket', 3)])
    assert.equal(plan.kind, 'refused')
    if (plan.kind !== 'refused') return
    assert.equal(
      deniedReport(plan.denied),
      'Error: the program did not run, because the toolscript-mcp policy denies a tool that it calls. No call was made.\n' +
        '- line 3: mcp__bench__create_ticket is denied by policy[0] {"match": "mcp__bench__create_ticket", "action": "deny"}',
    )
  })

  test('the names to ask are those of ask rules and of no rule, each once', () => {
    assert.deepEqual(
      planRun(p, [call('mcp__ops__restart'), call('mcp__bench__list_issues'), call('mcp__x__y'), call('mcp__x__y')]),
      { kind: 'run', ask: ['mcp__ops__restart', 'mcp__x__y'] },
    )
    assert.deepEqual(planRun(p, [call('mcp__bench__list_issues')]), { kind: 'run', ask: [] })
  })

  test('the prompt lists the tools and shows the program', () => {
    const text = askText(['mcp__x__y', 'mcp__x__z'], 'return 1')
    assert.ok(text.includes('these tools, which no policy rule allows:\n- mcp__x__y\n- mcp__x__z\n'), text)
    assert.ok(text.endsWith('The program:\nreturn 1'), text)
    assert.ok(askText(['mcp__x__y'], 'x'.repeat(5000)).endsWith('… [1000 more characters]'))
  })

  test('a client that cannot ask, and a decline, refuse the run with the allow rule to add', () => {
    const unsupported = refusedReport(['mcp__x__y'], 'unsupported')
    assert.match(
      unsupported,
      /^Error: the program did not run, because some tools need approval and this MCP client cannot ask the person\. No call was made\./,
    )
    assert.ok(unsupported.includes('add {"match": "mcp__x__y", "action": "allow"} to "policy"'), unsupported)
    const declined = refusedReport(['mcp__x__y'], 'decline')
    assert.match(declined, /^Error: the program did not run, because the person did not approve/)
    assert.ok(declined.includes('{"match": "mcp__x__y", "action": "allow"}'), declined)
  })
})

describe('the check of each nested call', () => {
  const p = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__bench__list_*', 'allow'])

  test('allow runs, deny names its rule, and ask runs only when approved for this run', () => {
    assert.deepEqual(checkCall(p, new Set(), 'mcp__bench__list_issues'), { ok: true })
    assert.deepEqual(checkCall(p, new Set(['mcp__bench__create_ticket']), 'mcp__bench__create_ticket'), {
      ok: false,
      error: 'denied by policy[0] {"match": "mcp__bench__create_ticket", "action": "deny"}',
      needsRule: false,
    })
    assert.deepEqual(checkCall(p, new Set(['mcp__bench__query_logs']), 'mcp__bench__query_logs'), { ok: true })
    const dynamic = checkCall(p, new Set(['mcp__bench__query_logs']), 'mcp__bench__get_deploys')
    assert.equal(dynamic.ok, false)
    assert.ok(!dynamic.ok && dynamic.needsRule)
  })

  test('approvalNote names each allow rule to add, and nothing when none was refused', () => {
    assert.equal(approvalNote([], true), '')
    const note = approvalNote(['mcp__a__x', 'mcp__b__y'], false)
    assert.ok(note.startsWith('## No allow rule\n\nNo policy rule allows mcp__a__x, mcp__b__y.'), note)
    assert.ok(
      note.includes(
        'ask them to add {"match": "mcp__a__x", "action": "allow"}, {"match": "mcp__b__y", "action": "allow"} to "policy"',
      ),
      note,
    )
    assert.ok(!note.includes('as a string'), note)
    assert.ok(approvalNote(['mcp__a__x'], true).includes('A tool name written as a string in call("…") is asked'))
  })
})

describe('kept results', () => {
  test('recall gives a kept result back as it is, and says why one is missing', () => {
    const kept = newKept()
    assert.equal(keep(kept, '{"n":7}', 0), 1)
    assert.equal(recallReply(kept, 1), '{"ok":true,"value":{"n":7}}')
    assert.deepEqual(JSON.parse(recallReply(kept, 9)), { ok: false, error: 'no result #9 in this session' })
    for (let i = 0; i < MAX_KEPT; i++) keep(kept, '1', i)
    assert.deepEqual(JSON.parse(recallReply(kept, 1)), {
      ok: false,
      error: 'result #1 is no longer kept: call the tool again',
    })
  })

  test('a result larger than the limit is not kept', () => {
    const kept = newKept()
    assert.equal(keep(kept, 'x'.repeat(8_000_001), 0), undefined)
    assert.equal(kept.results.size, 0)
  })
})

describe('the argument check from an input schema', () => {
  test('names, required names, and other names only when the schema allows them', () => {
    const schema = { type: 'object', properties: { a: {}, b: {} }, required: ['a', 3] }
    assert.deepEqual(argSpec(schema), { names: ['a', 'b'], required: ['a'], isOpen: false })
    assert.equal(argSpec({ ...schema, additionalProperties: true })?.isOpen, true)
    assert.equal(argSpec({ ...schema, additionalProperties: false })?.isOpen, false)
    assert.equal(argSpec({ type: 'object', properties: {} })?.isOpen, true)
    assert.equal(argSpec({ type: 'object' }), undefined)
  })
})

describe('paths on Windows', () => {
  test('a home with a drive keeps it, with forward slashes', () => {
    assert.equal(normalizePath('C:\\Users\\u\\.toolscript-mcp\\files'), 'C:/Users/u/.toolscript-mcp/files')
    assert.equal(appPath('C:\\Users\\u', 'files', 'x'), 'C:/Users/u/.toolscript-mcp/files/x')
    assert.equal(appPath('/home/u/', 'files'), '/home/u/.toolscript-mcp/files')
  })
})
