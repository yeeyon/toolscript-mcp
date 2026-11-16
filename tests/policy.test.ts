import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, type Config } from '../src/core/config.ts'
import {
  approvalNote,
  askText,
  checkCall,
  decide,
  declinedNote,
  deniedReport,
  keptPolicyNote,
  loosenText,
  matches,
  onlyTightens,
  planRun,
  policyChange,
  refusedReport,
  type Policy,
  type Rule,
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
    assert.equal(matches('mcp__a__*_*_x', 'mcp__a__b_c_x'), true)
    assert.equal(matches('mcp__a__*_*_x', 'mcp__a___x'), false, 'two stars do not share one underscore')
    assert.equal(matches('mcp__ab*ba', 'mcp__aba'), false, 'the parts do not overlap')
    assert.equal(matches('mcp__a**', 'mcp__a'), true)
  })

  test('make it fail: * matches a line break, so a deny rule still decides', () => {
    const p = policy(['mcp__x__delete*', 'deny'], ['*', 'allow'])
    for (const tool of ['mcp__x__delete\n', 'mcp__x__delete a', 'mcp__x__delete_\r'])
      assert.equal(decide(p, tool).action, 'deny', JSON.stringify(tool))
  })

  test('make it fail: a long name that a program builds does not stall the decision', () => {
    const p = policy(['mcp__*__delete_*__confirm', 'deny'])
    const started = performance.now()
    assert.equal(decide(p, `mcp__${'__delete_'.repeat(20_000)}`).action, 'ask')
    assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`)
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

  test('callTimeoutSeconds is 60 by default, at least 1, and never more than timeoutSeconds', () => {
    assert.equal(config({}).sandbox.callTimeoutSeconds, 60)
    assert.equal(config({ sandbox: { timeoutSeconds: 30 } }).sandbox.callTimeoutSeconds, 30)
    assert.equal(config({ sandbox: { callTimeoutSeconds: 1 } }).sandbox.callTimeoutSeconds, 1)
    assert.equal(config({ sandbox: { timeoutSeconds: 600, callTimeoutSeconds: 600 } }).sandbox.callTimeoutSeconds, 600)
    for (const t of [0, -1, 2.5, '30', 86_401, null])
      assert.deepEqual(errors({ sandbox: { callTimeoutSeconds: t } }), [
        `sandbox.callTimeoutSeconds: must be a whole number of seconds from 1 to 86400, not ${JSON.stringify(t)}`,
      ])
    assert.deepEqual(errors({ sandbox: { timeoutSeconds: 30, callTimeoutSeconds: 31 } }), [
      'sandbox.callTimeoutSeconds: must not be more than sandbox.timeoutSeconds (30)',
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
    const plan = planRun(p, [call('mcp__bench__list_issues'), call('mcp__bench__create_ticket', 3)], new Set())
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
      planRun(
        p,
        [call('mcp__ops__restart'), call('mcp__bench__list_issues'), call('mcp__x__y'), call('mcp__x__y')],
        new Set(),
      ),
      { kind: 'run', ask: ['mcp__ops__restart', 'mcp__x__y'], interactive: [] },
    )
    assert.deepEqual(planRun(p, [call('mcp__bench__list_issues')], new Set()), {
      kind: 'run',
      ask: [],
      interactive: [],
    })
  })

  test('a tool whose server requires a person is asked under an allow or ask rule, and a deny rule still denies it', () => {
    const marked = new Set(['mcp__bench__list_issues', 'mcp__ops__restart', 'mcp__bench__create_ticket'])
    assert.deepEqual(
      planRun(p, [call('mcp__bench__list_issues'), call('mcp__ops__restart'), call('mcp__bench__list_issues')], marked),
      { kind: 'run', ask: [], interactive: ['mcp__bench__list_issues', 'mcp__ops__restart'] },
    )
    assert.equal(planRun(p, [call('mcp__bench__create_ticket')], marked).kind, 'refused')
  })

  test('the prompt lists the tools and shows the program', () => {
    const text = askText({ ask: ['mcp__x__y', 'mcp__x__z'], interactive: [] }, 'return 1')
    assert.ok(text.includes('these tools, which no policy rule allows:\n- mcp__x__y\n- mcp__x__z\n'), text)
    assert.ok(text.includes('Approve for this run only? The approval covers each call of these tools in the program.'))
    assert.ok(!text.includes('each time'), text)
    assert.ok(text.endsWith('The program:\nreturn 1'), text)
    assert.ok(askText({ ask: ['mcp__x__y'], interactive: [] }, 'x'.repeat(5000)).endsWith('… [1000 more characters]'))
  })

  test('the prompt names apart the tools whose server requires a person each time', () => {
    const both = askText({ ask: ['mcp__x__y'], interactive: ['mcp__x__grant'] }, 'return 1')
    assert.ok(
      both.startsWith('A toolscript program wants to call this tool, which no policy rule allows:\n- mcp__x__y\n'),
    )
    assert.ok(
      both.includes(
        'It also wants to call this tool. Its server requires your approval each time, so a policy rule cannot allow it:\n- mcp__x__grant\n',
      ),
      both,
    )
    const alone = askText({ ask: [], interactive: ['mcp__x__a', 'mcp__x__b'] }, 'return 1')
    assert.ok(
      alone.startsWith(
        'A toolscript program wants to call these tools. Their servers require your approval each time, so a policy rule cannot allow them:\n- mcp__x__a\n- mcp__x__b\n',
      ),
      alone,
    )
  })

  test('a refusal for a tool whose server requires a person offers no allow rule', () => {
    const unsupported = refusedReport({ ask: [], interactive: ['mcp__x__grant'] }, 'unsupported')
    assert.ok(unsupported.includes('this MCP client cannot ask the person'), unsupported)
    assert.ok(unsupported.includes("mcp__x__grant needs the person's approval at each run"), unsupported)
    assert.ok(unsupported.includes('so a program cannot call it.'), unsupported)
    assert.ok(!unsupported.includes('"action": "allow"'), unsupported)
    const declined = refusedReport({ ask: ['mcp__x__y'], interactive: ['mcp__x__grant'] }, 'decline')
    assert.ok(declined.includes('{"match": "mcp__x__y", "action": "allow"}'), declined)
    assert.ok(!declined.includes('{"match": "mcp__x__grant"'), declined)
    assert.ok(!declined.includes('Write the tool name as a string'), 'the name was a string, and the person said no')
    assert.ok(!declined.includes('Run the program again'), declined)
  })

  test('a client that cannot ask, and a decline, refuse the run with the allow rule to add', () => {
    const unsupported = refusedReport({ ask: ['mcp__x__y'], interactive: [] }, 'unsupported')
    assert.match(
      unsupported,
      /^Error: the program did not run, because some tools need approval and this MCP client cannot ask the person\. No call was made\./,
    )
    assert.ok(unsupported.includes('add {"match": "mcp__x__y", "action": "allow"} to "policy"'), unsupported)
    assert.ok(unsupported.includes('the new rule applies only after they restart toolscript-mcp'), unsupported)
    const declined = refusedReport({ ask: ['mcp__x__y'], interactive: [] }, 'decline')
    assert.match(declined, /^Error: the program did not run, because the person did not approve/)
    assert.ok(declined.includes('{"match": "mcp__x__y", "action": "allow"}'), declined)
    assert.ok(!declined.includes('restart'), declined)
  })
})

describe('the check of each nested call', () => {
  const p = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__bench__list_*', 'allow'])

  test('allow runs, deny names its rule, and ask runs only when approved for this run', () => {
    const none = new Set<string>()
    assert.deepEqual(checkCall(p, new Set(), 'mcp__bench__list_issues', none), { ok: true })
    assert.deepEqual(checkCall(p, new Set(['mcp__bench__create_ticket']), 'mcp__bench__create_ticket', none), {
      ok: false,
      error: 'denied by policy[0] {"match": "mcp__bench__create_ticket", "action": "deny"}',
    })
    assert.deepEqual(checkCall(p, new Set(['mcp__bench__query_logs']), 'mcp__bench__query_logs', none), { ok: true })
    const dynamic = checkCall(p, new Set(['mcp__bench__query_logs']), 'mcp__bench__get_deploys', none)
    assert.equal(dynamic.ok, false)
    assert.ok(!dynamic.ok && dynamic.needs === 'rule')
  })

  test('a tool whose server requires a person runs only when approved for this run, and a deny rule still denies it', () => {
    const marked = new Set(['mcp__bench__list_issues', 'mcp__bench__create_ticket'])
    const allowed = checkCall(p, new Set(), 'mcp__bench__list_issues', marked)
    assert.ok(!allowed.ok && allowed.needs === 'person', JSON.stringify(allowed))
    assert.ok(!allowed.ok && allowed.error.includes('an allow rule does not replace it'), JSON.stringify(allowed))
    assert.deepEqual(checkCall(p, new Set(['mcp__bench__list_issues']), 'mcp__bench__list_issues', marked), {
      ok: true,
    })
    const denied = checkCall(p, new Set(['mcp__bench__create_ticket']), 'mcp__bench__create_ticket', marked)
    assert.ok(!denied.ok && denied.needs === undefined && denied.error.startsWith('denied by'), JSON.stringify(denied))
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
    assert.ok(
      note.includes(
        'This MCP client cannot ask the person, so the new rule applies only after they restart toolscript-mcp.',
      ),
      note,
    )
    const asks = approvalNote(['mcp__a__x'], true)
    assert.ok(asks.includes('A tool name written as a string in call("…") is asked before the run.'), asks)
    assert.ok(!asks.includes('restart'), asks)
  })
})

describe('a change of the policy in the config file', () => {
  const current = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'ask'])
  const looser = (from: Policy, to: Policy): boolean => !onlyTightens(from, to)
  const RANK = { deny: 0, ask: 1, allow: 2 }

  test('make it fail: a new allow that a rule shadows for every name the old check tried is looser', () => {
    const cases: [Policy, Policy, string][] = [
      [[], policy(['mcp__x__', 'ask'], ['mcp__x__*', 'allow']), 'mcp__x__anything'],
      [[], policy(['mcp__x__', 'deny'], ['mcp__x__*', 'allow']), 'mcp__x__anything'],
      [policy(['mcp__x__get', 'allow']), policy(['mcp__x__get*', 'allow']), 'mcp__x__get_all'],
      [policy(['mcp__x__*', 'deny']), policy(['mcp__x__', 'deny'], ['mcp__x__*', 'allow']), 'mcp__x__anything'],
      [
        policy(['mcp__x__*', 'deny'], ['mcp__*__del', 'allow']),
        policy(['mcp__*__del', 'allow'], ['mcp__x__*', 'deny']),
        'mcp__x__del',
      ],
    ]
    for (const [from, to, name] of cases) {
      const shown = `${policyChange(from, to)} for ${name}`
      assert.ok(RANK[decide(to, name).action] > RANK[decide(from, name).action], shown)
      assert.equal(looser(from, to), true, shown)
    }
  })

  test('inserting deny rules, removing allow rules and lowering an action in place apply with no prompt', () => {
    const tighter = [
      policy(
        ['mcp__x__*', 'deny'],
        ['mcp__bench__create_ticket', 'deny'],
        ['mcp__fs__*', 'allow'],
        ['mcp__bench__*', 'ask'],
      ),
      policy(
        ['mcp__bench__create_ticket', 'deny'],
        ['mcp__fs__w*', 'deny'],
        ['mcp__fs__*', 'allow'],
        ['mcp__bench__*', 'ask'],
      ),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'ask'], ['*', 'deny']),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__bench__*', 'ask']),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'ask'], ['mcp__bench__*', 'ask']),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'deny'], ['mcp__bench__*', 'ask']),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'deny']),
      policy(
        ['mcp__fs__write_*', 'deny'],
        ['mcp__bench__create_ticket', 'deny'],
        ['mcp__fs__*', 'ask'],
        ['mcp__bench__*', 'deny'],
        ['mcp__*', 'deny'],
      ),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__x__*', 'deny'], ['mcp__bench__*', 'ask']),
      current,
    ]
    for (const to of tighter) assert.equal(looser(current, to), false, policyChange(current, to))
    assert.equal(looser([], policy(['mcp__a__*', 'deny'], ['*', 'deny'])), false)
    assert.equal(looser(policy(['mcp__a__*', 'allow'], ['mcp__b__*', 'allow']), []), false)
  })

  test('removing a deny or ask, raising an action, inserting an allow or ask, a new match and a new order are looser', () => {
    const others = [
      policy(['mcp__fs__*', 'allow'], ['mcp__bench__*', 'ask']),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow']),
      policy(['mcp__bench__create_ticket', 'ask'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'ask']),
      policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'allow']),
      policy(
        ['mcp__x__*', 'allow'],
        ['mcp__bench__create_ticket', 'deny'],
        ['mcp__fs__*', 'allow'],
        ['mcp__bench__*', 'ask'],
      ),
      policy(
        ['mcp__x__*', 'ask'],
        ['mcp__bench__create_ticket', 'deny'],
        ['mcp__fs__*', 'allow'],
        ['mcp__bench__*', 'ask'],
      ),
      policy(['mcp__bench__create_ticket*', 'deny'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'ask']),
      policy(['mcp__fs__*', 'allow'], ['mcp__bench__create_ticket', 'deny'], ['mcp__bench__*', 'ask']),
    ]
    for (const to of others) assert.equal(looser(current, to), true, policyChange(current, to))
    assert.equal(looser(policy(['mcp__gone__*', 'deny']), []), true, 'a rule over tools of no connected server counts')
  })

  test('make it fail: the same match twice pairs each rule of the new policy with the right old rule', () => {
    const allowThenDeny = policy(['mcp__a__*', 'allow'], ['mcp__a__*', 'deny'])
    assert.equal(looser(allowThenDeny, policy(['mcp__a__*', 'deny'])), false, 'the allow is removed, not lowered')
    const askThenAllow = policy(['mcp__a__*', 'ask'], ['mcp__a__*', 'allow'])
    assert.equal(looser(askThenAllow, policy(['mcp__a__*', 'ask'])), false, 'the second rule is removed')
    assert.equal(looser(askThenAllow, policy(['mcp__a__*', 'allow'])), true, 'the ask is gone')
  })

  test('each step only tightens, and an accepted change never raises a decision', () => {
    const MATCHES = ['mcp__a__x', 'mcp__a__*', 'mcp__*', 'mcp__a__', 'mcp__*__x', 'mcp__b__y', 'mcp__a__x*', '*']
    const NAMES = [
      'mcp__a__x',
      'mcp__a__',
      'mcp__a__y',
      'mcp__a__xy',
      'mcp__b__x',
      'mcp__b__y',
      'mcp__c__z',
      'mcp____x',
    ]
    const ACTIONS = ['allow', 'deny', 'ask'] as const
    let seed = 7
    const next = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
    }
    const rule = (match: string, action: Rule['action']): Rule => ({ match, action, index: 0 })
    const randomPolicy = (): Rule[] =>
      Array.from({ length: next(6) }, () => rule(MATCHES[next(MATCHES.length)]!, ACTIONS[next(3)]!))
    const step = (p: Rule[]): Rule[] => {
      const at = next(p.length + 1)
      const kind = next(3)
      const allows = p.flatMap((r, i) => (r.action === 'allow' ? [i] : []))
      const raised = p.flatMap((r, i) => (r.action === 'deny' ? [] : [i]))
      if (kind === 1 && allows.length > 0) return p.toSpliced(allows[next(allows.length)]!, 1)
      if (kind === 2 && raised.length > 0) {
        const i = raised[next(raised.length)]!
        return p.with(i, rule(p[i]!.match, p[i]!.action === 'allow' && next(2) === 0 ? 'ask' : 'deny'))
      }
      return p.toSpliced(at, 0, rule(MATCHES[next(MATCHES.length)]!, 'deny'))
    }
    const raises = (from: Policy, to: Policy): string | undefined =>
      NAMES.find(name => RANK[decide(to, name).action] > RANK[decide(from, name).action])
    let accepted = 0
    for (let i = 0; i < 3000; i++) {
      const from = randomPolicy()
      let to = from
      for (let n = next(4); n >= 0; n--) to = step(to)
      assert.equal(raises(from, to), undefined, policyChange(from, to))
      assert.equal(onlyTightens(from, to), true, policyChange(from, to))
      const other = randomPolicy()
      if (onlyTightens(from, other)) {
        accepted++
        assert.equal(raises(from, other), undefined, policyChange(from, other))
      }
    }
    assert.ok(accepted > 100, `${accepted} random pairs accepted`)
  })

  test('make it fail: a policy too large to compare counts as looser, and its change shows at once', () => {
    const many = policy(...Array.from({ length: 4000 }, (_, i): [string, 'deny'] => [`mcp__a__t${i}`, 'deny']))
    const more = [...many, ...policy(['mcp__b__*', 'deny'])]
    const started = performance.now()
    assert.equal(looser(many, more), true)
    assert.equal(policyChange(many, more), 'added {"match": "mcp__b__*", "action": "deny"}')
    assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`)
  })

  test('policyChange names the rules added and removed, and nothing when the rules are the same', () => {
    const next = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'ask'], ['mcp__bench__*', 'ask'])
    assert.equal(
      policyChange(current, next),
      'added {"match": "mcp__fs__*", "action": "ask"}; removed {"match": "mcp__fs__*", "action": "allow"}',
    )
    assert.equal(
      policyChange(current, policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow'])),
      'removed {"match": "mcp__bench__*", "action": "ask"}',
    )
    assert.equal(
      policyChange(
        policy(['mcp__a__*', 'deny'], ['mcp__b__*', 'allow']),
        policy(['mcp__b__*', 'allow'], ['mcp__a__*', 'deny']),
      ),
      'the order of the rules changed to {"match": "mcp__b__*", "action": "allow"}, {"match": "mcp__a__*", "action": "deny"}',
    )
    assert.equal(
      policyChange(
        current,
        policy(['mcp__bench__create_ticket', 'deny'], ['mcp__fs__*', 'allow'], ['mcp__bench__*', 'ask']),
      ),
      '',
    )
  })

  test('the prompt and the note name the file and the rules added and removed, not tool names', () => {
    const next = policy(['mcp__x__', 'ask'], ['mcp__x__*', 'allow'])
    const change = policyChange([], next)
    assert.equal(
      loosenText('/home/u/.config/toolscript-mcp/config.json', change, next),
      [
        'The toolscript-mcp policy in /home/u/.config/toolscript-mcp/config.json changed, and the change can let a tool run with less approval: added {"match": "mcp__x__*", "action": "allow"}, {"match": "mcp__x__", "action": "ask"}.',
        '',
        'The new policy. The first rule that matches a tool decides:',
        'policy[0] {"match": "mcp__x__", "action": "ask"}',
        'policy[1] {"match": "mcp__x__*", "action": "allow"}',
        '',
        'If you decline, this run uses the policy in force. The file still holds the new policy, and it applies at the next start of toolscript-mcp.',
        '',
        'Apply the new policy?',
      ].join('\n'),
    )
    const restart = keptPolicyNote('c.json', change, 'unsupported')
    assert.ok(
      restart.startsWith(
        '## Policy not reloaded\n\nThe toolscript-mcp policy in c.json changed, and the change can let a tool run with less approval: added {"match": "mcp__x__*", ',
      ),
      restart,
    )
    assert.ok(restart.includes('restart toolscript-mcp'), restart)
    assert.ok(keptPolicyNote('c.json', change, 'decline').includes('The person did not approve it'))
    assert.equal(
      declinedNote('c.json'),
      '## Policy not reloaded\n\nThe person declined the policy in c.json, so this run used the policy in force. Do not change the config yourself.',
    )
  })

  test('make it fail: an added deny does not hide a reorder that lets a denied tool run', () => {
    const from = policy(['mcp__bench__create_ticket', 'deny'], ['mcp__bench__*', 'allow'])
    const to = policy(['mcp__bench__*', 'allow'], ['mcp__bench__create_ticket', 'deny'], ['mcp__zzz__x', 'deny'])
    assert.equal(
      policyChange(from, to),
      'added {"match": "mcp__zzz__x", "action": "deny"}; the order of the other rules changed',
    )
    const inserted = policy(['mcp__zzz__x', 'deny'], ['mcp__bench__create_ticket', 'deny'], ['mcp__bench__*', 'allow'])
    assert.equal(policyChange(from, inserted), 'added {"match": "mcp__zzz__x", "action": "deny"}')
  })

  test('make it fail: the prompt lists every rule of the new policy in order, uncut, so no loosening rule hides', () => {
    const olds = Array.from({ length: 10 }, (_, i): [string, 'deny'] => [`mcp__old${i}__*`, 'deny'])
    const long = `mcp__x__${'a'.repeat(500)}`
    const next = policy(...olds, ['*', 'allow'], [long, 'ask'])
    const change = policyChange([], next)
    assert.ok(change.startsWith('added {"match": "*", "action": "allow"}, {"match": "mcp__x__aaa'), change)
    const text = loosenText('c.json', change, next)
    const lines = text.split('\n')
    assert.ok(lines.includes('policy[10] {"match": "*", "action": "allow"}'), text)
    assert.ok(lines.includes(`policy[11] {"match": "${long}", "action": "ask"}`), text)
    assert.deepEqual(
      lines.filter(l => l.startsWith('policy[')).map(l => l.slice(0, l.indexOf(']') + 1)),
      next.map((_, i) => `policy[${i}]`),
    )
    assert.ok(text.endsWith('Apply the new policy?'), text)
    assert.ok(text.includes('applies at the next start of toolscript-mcp'), text)
    assert.ok(loosenText('c.json', 'removed x', []).includes('No rules: each call needs the approval of the person.'))
  })

  test('make it fail: the prompt names every removed rule, deny first, also behind 10 junk rules', () => {
    const junk = Array.from({ length: 10 }, (_, i): [string, 'deny'] => [`mcp__zz${i}__*`, 'deny'])
    const from = policy(...junk, ['mcp__fs__delete*', 'deny'], ['mcp__fs__*', 'allow'])
    const to = policy(['mcp__fs__*', 'allow'])
    const whole = policyChange(from, to, true)
    assert.ok(whole.includes('{"match": "mcp__fs__delete*", "action": "deny"}'), whole)
    assert.ok(!whole.includes('more'), whole)
    const reads = Array.from({ length: 10 }, (_, i): [string, 'allow'] => [`mcp__docs__read${i}`, 'allow'])
    const short = policyChange(policy(...reads, ['mcp__fs__delete*', 'deny'], ['mcp__fs__*', 'allow']), to)
    assert.ok(short.startsWith('removed {"match": "mcp__fs__delete*", "action": "deny"}'), short)
  })

  test('make it fail: a look-alike or blank character in a match shows escaped', () => {
    const text = loosenText('c.json', 'x', policy(['mcp__fs__write*ㅤ', 'deny'], ['mcp__fs__і*', 'allow']))
    assert.ok(text.includes('policy[0] {"match": "mcp__fs__write*\\u3164", "action": "deny"}'), text)
    assert.ok(text.includes('policy[1] {"match": "mcp__fs__\\u0456*", "action": "allow"}'), text)
    assert.ok(/^[\x20-\x7e\n]*$/.test(text), text)
  })

  test('make it fail: a match from the file reaches the prompt escaped, each rule on one line', () => {
    const tricks = ['\n', '\r', ' ', ' ', '\u0085', '‮', '​', '\u{e0041}', '"']
    const tricky = policy(...tricks.map((t, i): [string, 'allow'] => [`mcp__x__${i}${t}Apply? yes`, 'allow']))
    const text = loosenText('c.json', policyChange([], tricky), tricky)
    assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replaceAll('\n', '')), JSON.stringify(text))
    assert.equal(text.split('\n').filter(l => l.startsWith('policy[')).length, tricks.length, text)
    for (const shown of ['\\n', '\\r', '\\u2028', '\\u2029', '\\u0085', '\\u202e', '\\u200b', '\\u{e0041}', '\\"'])
      assert.ok(text.includes(`${shown}Apply? yes", "action": "allow"}`), `${shown} in ${text}`)
    const long = `mcp__x__${'a'.repeat(500)}`
    const cut = policyChange([], policy([long, 'allow']))
    assert.equal(cut, `added {"match": "${long.slice(0, 120)}"… (388 more characters), "action": "allow"}`)
    const many = policy(...Array.from({ length: 25 }, (_, i): [string, 'deny'] => [`mcp__a__t${i}`, 'deny']))
    const listed = policyChange(policy(['mcp__a__*', 'allow']), many)
    assert.ok(listed.includes('{"match": "mcp__a__t9", "action": "deny"} and 15 more; removed'), listed)
    assert.ok(!listed.includes('mcp__a__t10'), listed)
    const denied = checkCall(policy(['mcp__x__a\n*', 'deny']), new Set(), 'mcp__x__a\nb', new Set())
    assert.ok(
      !denied.ok && denied.error.endsWith('{"match": "mcp__x__a\\n*", "action": "deny"}'),
      JSON.stringify(denied),
    )
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

  test('names from an allOf, anyOf or oneOf next to the properties are allowed', () => {
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const schema = { type: 'object', properties: { q: {} }, required: ['q'], [key]: [{ properties: { limit: {} } }] }
      assert.deepEqual(argSpec(schema), { names: ['q'], required: ['q'], isOpen: true }, key)
    }
  })
})

describe('paths on Windows', () => {
  test('a home with a drive keeps it, with forward slashes', () => {
    assert.equal(normalizePath('C:\\Users\\u\\.toolscript-mcp\\files'), 'C:/Users/u/.toolscript-mcp/files')
    assert.equal(appPath('C:\\Users\\u', 'files', 'x'), 'C:/Users/u/.toolscript-mcp/files/x')
    assert.equal(appPath('/home/u/', 'files'), '/home/u/.toolscript-mcp/files')
  })
})
