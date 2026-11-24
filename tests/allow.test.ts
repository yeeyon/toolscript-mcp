// `toolscript-mcp allow` and the allow commands that `toolscript-mcp tools` prints. A server picks its tool names, so a
// name reaches a printed command only when every shell passes it as it is, and an agent runs only printed lines.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowRefusal, planAllow } from '../src/core/commands.ts'
import type { Launch, ServerKey } from '../src/core/config.ts'
import { NO_GUARDS, decide, type Action, type Guards, type Policy } from '../src/core/policy.ts'
import { runAllow } from '../src/host/allow.ts'
import { runTools, type CheckIo } from '../src/host/diagnose.ts'
import { SHELLS } from './shells.ts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-allow-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const MAIN = fileURLToPath(new URL('../src/host/main.ts', import.meta.url))
const LAUNCH: Launch = { kind: 'node', main: MAIN }

/** A path as a printed command holds it: in double quotes, with forward slashes on Windows. */
const word = (file: string) => `"${process.platform === 'win32' ? file.replaceAll('\\', '/') : file}"`

const rules = (...pairs: [Action, string][]): Policy =>
  pairs.map(([action, match], index) => ({ match, action, index }))
const shape = (policy: Policy) => policy.map(({ action, match }) => [action, match])
const NO_BRIDGE: Guards = NO_GUARDS
const bridged = (...keys: string[]): Guards => ({ bridges: new Set(keys as ServerKey[]), workspace: false })

describe('planAllow', () => {
  const plan = (policy: Policy, tools: string[], bridges = NO_BRIDGE) => planAllow(policy, bridges, tools)

  test('puts an exact allow rule first for each new tool, once, before the old rules', () => {
    const { steps, policy } = plan(rules(['ask', 'mcp__gh__*']), ['mcp__gh__a', 'mcp__gh__b', 'mcp__gh__a'])
    assert.deepEqual(steps, [
      { tool: 'mcp__gh__a', kind: 'add' },
      { tool: 'mcp__gh__b', kind: 'add' },
    ])
    assert.deepEqual(shape(policy), [
      ['allow', 'mcp__gh__a'],
      ['allow', 'mcp__gh__b'],
      ['ask', 'mcp__gh__*'],
    ])
    assert.deepEqual(
      policy.map(r => r.index),
      [0, 1, 2],
    )
  })

  test('keeps a tool that an earlier allow rule allows before a deny rule', () => {
    const old = rules(['allow', '*'], ['deny', 'mcp__gh__del*'])
    const { steps, policy } = plan(old, ['mcp__gh__delete'])
    assert.equal(steps[0]?.kind, 'keep')
    assert.match(steps[0]?.kind === 'keep' ? steps[0].why : '', /^allowed already by policy\[0\]/)
    assert.deepEqual(shape(policy), shape(old))
  })

  test('refuses a deny rule that an earlier ask rule hides, and adds no rule', () => {
    const old = rules(['ask', 'mcp__fake__hid*'], ['deny', 'mcp__fake__hidden'])
    const { steps, policy } = plan(old, ['mcp__fake__hidden'])
    const [step] = steps
    assert.equal(step?.kind, 'refuse')
    assert.equal(
      step?.kind === 'refuse' ? step.edit : '',
      'put an allow rule for mcp__fake__hidden before the rule policy[0] {"match": "mcp__fake__hid*", "action": "ask"}',
    )
    assert.deepEqual(shape(policy), shape(old))
  })

  test('refuses a tool that an exact ask rule names, and keeps one that an allow rule before it allows', () => {
    const asked = plan(rules(['ask', 'mcp__gh__a']), ['mcp__gh__a'])
    const [step] = asked.steps
    assert.equal(step?.kind, 'refuse')
    assert.match(
      step?.kind === 'refuse' ? step.why : '',
      /^the ask rule policy\[0\] .* names it\. allow never loosens an ask/,
    )
    assert.equal(
      step?.kind === 'refuse' ? step.edit : '',
      'change the rule policy[0] {"match": "mcp__gh__a", "action": "ask"} to allow',
    )
    assert.deepEqual(shape(asked.policy), [['ask', 'mcp__gh__a']])
    assert.equal(plan(rules(['allow', 'mcp__gh__*'], ['ask', 'mcp__gh__a']), ['mcp__gh__a']).steps[0]?.kind, 'keep')
  })

  test('refuses a tool of a bridge that a deny rule for the bridge matches', () => {
    const bridges = bridged('claude-code')
    const old = rules(['allow', '*'], ['deny', 'mcp__claude-code__*'])
    const { steps, policy } = plan(old, ['mcp__claude-code__Read'], bridges)
    const [step] = steps
    assert.equal(step?.kind, 'refuse')
    assert.equal(
      step?.kind === 'refuse' ? step.edit : '',
      'put an allow rule for mcp__claude-code__Read before the rule policy[1] {"match": "mcp__claude-code__*", "action": "deny"}',
    )
    assert.deepEqual(shape(policy), shape(old))
  })

  test('moves an exact allow rule that an earlier rule hides to the front', () => {
    const hidden = plan(rules(['ask', 'mcp__gh__*'], ['allow', 'mcp__gh__a']), ['mcp__gh__a'])
    assert.deepEqual(shape(hidden.policy), [
      ['allow', 'mcp__gh__a'],
      ['ask', 'mcp__gh__*'],
    ])
  })

  test('says allowed already when the rule that decides the tool allows it', () => {
    for (const old of [rules(['allow', 'mcp__gh__a'], ['ask', '*']), rules(['allow', 'mcp__gh__*'])]) {
      const { steps, policy } = plan(old, ['mcp__gh__a'])
      assert.match(steps[0]?.kind === 'keep' ? steps[0].why : '', /^allowed already by policy\[0\]/)
      assert.deepEqual(shape(policy), shape(old))
    }
  })

  test('adds a rule for a tool of a bridge, which a rule for all servers does not allow', () => {
    const bridges = bridged('claude-code')
    const { steps } = plan(rules(['allow', '*']), ['mcp__claude-code__Read'], bridges)
    assert.deepEqual(steps, [{ tool: 'mcp__claude-code__Read', kind: 'add' }])
  })
})

describe('planAllow with a deny rule behind an allow rule (issue 139)', () => {
  const old = rules(['allow', 'mcp__fake__search'], ['deny', 'mcp__fake__*'])
  const plan = (tool: string) => planAllow(old, NO_BRIDGE, [tool])

  test('keeps a tool that an earlier allow rule already allows', () => {
    const { steps, policy } = plan('mcp__fake__search')
    assert.deepEqual(steps, [
      {
        tool: 'mcp__fake__search',
        kind: 'keep',
        why: 'allowed already by policy[0] {"match": "mcp__fake__search", "action": "allow"}',
      },
    ])
    assert.deepEqual(shape(policy), shape(old))
  })

  test('refuses a tool that the deny rule decides, and names the rule', () => {
    const { steps, policy } = plan('mcp__fake__fetch')
    assert.deepEqual(steps, [
      {
        tool: 'mcp__fake__fetch',
        kind: 'refuse',
        why: 'the deny rule policy[1] {"match": "mcp__fake__*", "action": "deny"} matches it. allow never loosens a deny rule',
        edit: 'put an allow rule for mcp__fake__fetch before the rule policy[1] {"match": "mcp__fake__*", "action": "deny"}',
      },
    ])
    assert.deepEqual(shape(policy), shape(old))
  })
})

describe('the hand edit of a refused tool', () => {
  const bridges = bridged('claude-code')
  const cases: [Policy, string][] = [
    [rules(['allow', 'mcp__fake__search'], ['deny', 'mcp__fake__*']), 'mcp__fake__fetch'],
    [rules(['ask', 'mcp__fake__hid*'], ['deny', 'mcp__fake__hidden']), 'mcp__fake__hidden'],
    [rules(['allow', '*'], ['deny', 'mcp__claude-code__*']), 'mcp__claude-code__Read'],
    [rules(['deny', 'mcp__gh__f*'], ['deny', 'mcp__gh__fetch'], ['allow', '*']), 'mcp__gh__fetch'],
    [rules(['ask', 'mcp__gh__*'], ['ask', 'mcp__gh__a']), 'mcp__gh__a'],
    [rules(['ask', 'mcp__claude-code__Read']), 'mcp__claude-code__Read'],
  ]
  for (const [old, tool] of cases)
    test(`allows ${tool} once a person makes it`, () => {
      const [step] = planAllow(old, bridges, [tool]).steps
      assert.equal(step?.kind, 'refuse')
      const edit = step?.kind === 'refuse' ? step.edit : ''
      const before = /^put an allow rule for \S+ before the rule policy\[(\d+)\] \{.*\}$/.exec(edit)
      const change = /^change the rule policy\[(\d+)\] \{.*\} to allow$/.exec(edit)
      assert.ok(before !== null || change !== null, edit)
      const pairs = old.map((r): [Action, string] => [r.action, r.match])
      if (before !== null) pairs.splice(Number(before[1]), 0, ['allow', tool])
      if (change !== null) pairs[Number(change[1])] = ['allow', old[Number(change[1])]?.match ?? '']
      assert.equal(decide(rules(...pairs), bridges, tool).action, 'allow', edit)
    })

  test('names the rule by its text, so the edit still fits after the printed command adds a rule', () => {
    const old = rules(['deny', 'mcp__fake__drop*'], ['ask', 'mcp__fake__a'])
    const { steps, policy } = planAllow(old, NO_BRIDGE, ['mcp__fake__new', 'mcp__fake__a'])
    const refused = steps.find(s => s.kind === 'refuse')
    assert.equal(
      refused?.kind === 'refuse' ? refused.edit : '',
      'change the rule policy[1] {"match": "mcp__fake__a", "action": "ask"} to allow',
    )
    // After the printed command, policy[1] is the deny rule: the edit finds the ask rule by its match and action.
    const edited = policy.map((r): [Action, string] =>
      r.match === 'mcp__fake__a' && r.action === 'ask' ? ['allow', r.match] : [r.action, r.match],
    )
    assert.equal(decide(rules(...edited), NO_BRIDGE, 'mcp__fake__a').action, 'allow')
    assert.equal(decide(rules(...edited), NO_BRIDGE, 'mcp__fake__drop_all').action, 'deny')
  })
})

describe('allowRefusal', () => {
  const keys = new Set(['gh', 'my_notes', '-dash'])
  test('takes the exact name of one tool of a server of the config, with a plain tool part', () => {
    for (const tool of ['mcp__gh__list', 'mcp__my_notes__get.page-2', 'mcp__-dash__x', 'mcp__gh___under'])
      assert.equal(allowRefusal(tool, keys), undefined, tool)
  })
  test('refuses a glob, a name that a shell can change and a server that the config lacks', () => {
    for (const tool of [
      'mcp__gh__*',
      'mcp__gh__a b',
      'mcp__gh__list$(touch PWN)',
      'mcp__gh__x`y`',
      'mcp__gh__x;y',
      'mcp__gh__é',
      'mcp__gh__',
      'gh__list',
      'mcp__gh__a\nb',
    ])
      assert.match(allowRefusal(tool, keys) ?? '', /give the exact name of one tool/, tool)
    assert.equal(allowRefusal('mcp__other__list', keys), 'mcp__other__list: the config has no server other.')
  })
})

/** A temp HOME and a config file with `json`, and an io that keeps what a command prints. */
const setup = (json: unknown, configName = 'config.json') => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  const config = path.join(dir, configName)
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const text = typeof json === 'string' ? json : JSON.stringify(json, null, 2)
  fs.writeFileSync(config, text)
  const printed: string[] = []
  const io: CheckIo = {
    env: { TOOLSCRIPT_CONFIG: undefined, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: home, FAKE_TOKEN: 'x' },
    platform: process.platform,
    home,
    version: '0.0.0',
    launch: LAUNCH,
    print: t => void printed.push(...t.split('\n')),
  }
  const take = () => printed.splice(0)
  return {
    dir,
    home,
    config,
    text,
    io,
    take,
    allow: (...args: string[]) => runAllow([...args, '--config', config], io),
    tools: (key: string) => runTools([key, '--config', config], io),
  }
}

const FAKE_SERVER = path.join(ROOT, 'fake-server.mjs')
fs.writeFileSync(
  FAKE_SERVER,
  `import readline from 'node:readline'
const ro = { readOnlyHint: true }
const tools = [
  { name: 'list_issues$(touch\${IFS}PWNtool)', annotations: ro },
  { name: 'count\`touch PWNtick\`', annotations: ro },
  { name: 'node\${IFS}-v;touch\${IFS}PWNlabel', annotations: ro },
  { name: 'list_a', annotations: ro },
  { name: 'list_b', annotations: ro },
  { name: 'write_c', annotations: { destructiveHint: true } },
  { name: 'asked', annotations: ro },
  { name: 'hidden', annotations: ro },
  { name: 'open', annotations: ro },
  { name: 'shut' },
].map(t => ({ inputSchema: { type: 'object' }, ...t }))
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
  if (m.method === 'initialize')
    return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
  if (m.method === 'tools/list') return reply({ tools })
  reply({})
})
`,
)

const POLICY = [
  { match: 'mcp__fake__open', action: 'allow' },
  { match: 'mcp__fake__shut', action: 'deny' },
  { match: 'mcp__fake__asked', action: 'ask' },
  { match: 'mcp__fake__hid*', action: 'ask' },
  { match: 'mcp__fake__hidden', action: 'deny' },
]
const FAKE_CONFIG = {
  $schema: 'https://example.com/schema.json',
  mcpServers: { fake: { command: process.execPath, args: [FAKE_SERVER], env: { TOKEN: '${FAKE_TOKEN}' } } },
  sandbox: { timeoutSeconds: 60 },
  policy: POLICY,
}

describe('toolscript-mcp allow', () => {
  test('a dry run writes nothing, and prints the policy and the command that writes it', async () => {
    const s = setup(FAKE_CONFIG)
    assert.equal(await s.allow('mcp__fake__list_a', 'mcp__fake__open'), 0)
    assert.deepEqual(s.take(), [
      'add: an allow rule for mcp__fake__list_a',
      'keep: mcp__fake__open: allowed already by policy[0] {"match": "mcp__fake__open", "action": "allow"}',
      `Dry run: allow did not change ${s.config}. The policy would be:`,
      '  policy[0] {"match": "mcp__fake__list_a", "action": "allow"}',
      '  policy[1] {"match": "mcp__fake__open", "action": "allow"}',
      '  policy[2] {"match": "mcp__fake__shut", "action": "deny"}',
      '  policy[3] {"match": "mcp__fake__asked", "action": "ask"}',
      '  policy[4] {"match": "mcp__fake__hid*", "action": "ask"}',
      '  policy[5] {"match": "mcp__fake__hidden", "action": "deny"}',
      'toolscript-mcp reads the policy again at each run. It asks you to approve a new allow rule before it applies.',
      'If your client cannot ask, restart toolscript-mcp to apply a new allow rule.',
      'To write this policy, run the command below.',
      `    node ${word(MAIN)} allow --apply --config ${word(s.config)} "mcp__fake__list_a"`,
    ])
    assert.equal(fs.readFileSync(s.config, 'utf8'), s.text)
  })

  for (const apply of [[], ['--apply']])
    test(`${apply.join('') || 'a dry run'} with an added, a refused and a kept tool exits 2, writes nothing, prints the add command`, async () => {
      const s = setup(FAKE_CONFIG)
      assert.equal(await s.allow(...apply, 'mcp__fake__list_a', 'mcp__fake__hidden', 'mcp__fake__open'), 2)
      const printed = s.take()
      const text = printed.join('\n')
      assert.deepEqual(printed.slice(0, 5), [
        'add: an allow rule for mcp__fake__list_a',
        'refused: mcp__fake__hidden: the deny rule policy[4] {"match": "mcp__fake__hidden", "action": "deny"} matches it. allow never loosens a deny rule.',
        'keep: mcp__fake__open: allowed already by policy[0] {"match": "mcp__fake__open", "action": "allow"}',
        `next: mcp__fake__hidden: to allow it, edit the policy of ${s.config}: put an allow rule for mcp__fake__hidden before the rule policy[3] {"match": "mcp__fake__hid*", "action": "ask"}.`,
        `allow did not change ${s.config}, because it refused a tool.`,
      ])
      assert.ok(!text.includes('Dry run'), text)
      assert.equal(fs.readFileSync(s.config, 'utf8'), s.text)
      const command = `    node ${word(MAIN)} allow --apply --config ${word(s.config)} "mcp__fake__list_a"`
      assert.equal(printed.at(-1), command)
      assert.equal(await s.allow('--apply', 'mcp__fake__list_a'), 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(s.config, 'utf8')).policy, [
        { match: 'mcp__fake__list_a', action: 'allow' },
        ...POLICY,
      ])
    })

  test('a run that refuses every tool prints no policy and no command, and an ask rule gets its own text', async () => {
    const s = setup(FAKE_CONFIG)
    assert.equal(await s.allow('mcp__fake__shut', 'mcp__fake__asked', 'mcp__fake__shut'), 2)
    const printed = s.take()
    assert.equal(printed.filter(l => l.startsWith('refused: ')).length, 2)
    assert.ok(printed.some(l => /^refused: mcp__fake__asked: the ask rule policy\[2\] .* names it\./.test(l)))
    assert.ok(
      printed.includes(
        `next: mcp__fake__asked: to allow it, edit the policy of ${s.config}: change the rule policy[2] {"match": "mcp__fake__asked", "action": "ask"} to allow.`,
      ),
    )
    assert.ok(
      !printed.some(l => /^ +(node|npx|claude|pushd) |policy would be|needs no change/.test(l)),
      printed.join('\n'),
    )
    assert.equal(fs.readFileSync(s.config, 'utf8'), s.text)
  })

  for (const apply of [[], ['--apply']])
    test(`${apply.join('') || 'a dry run'} with a deny rule behind an allow rule reports each tool, exits 2, writes nothing`, async () => {
      const s = setup({
        mcpServers: { fake: { command: 'node', args: ['x.mjs'] } },
        policy: [
          { match: 'mcp__fake__search', action: 'allow' },
          { match: 'mcp__fake__*', action: 'deny' },
        ],
      })
      assert.equal(await s.allow(...apply, 'mcp__fake__fetch', 'mcp__fake__search'), 2)
      const printed = s.take()
      const text = printed.join('\n')
      assert.equal(printed.filter(l => l.startsWith('refused: mcp__fake__fetch: ')).length, 1, text)
      assert.equal(printed.filter(l => /^keep: mcp__fake__search: allowed already/.test(l)).length, 1, text)
      assert.ok(!text.includes('needs no change'), text)
      assert.ok(!text.includes('stays'), text)
      assert.ok(
        printed.includes(
          `next: mcp__fake__fetch: to allow it, edit the policy of ${s.config}: put an allow rule for mcp__fake__fetch before the rule policy[1] {"match": "mcp__fake__*", "action": "deny"}.`,
        ),
        text,
      )
      assert.equal(fs.readFileSync(s.config, 'utf8'), s.text)
    })

  test('--apply keeps the share keys', async () => {
    const config = {
      ...FAKE_CONFIG,
      share: true,
      mcpServers: { fake: { ...FAKE_CONFIG.mcpServers.fake, share: true } },
    }
    const s = setup(config)
    assert.equal(await s.allow('--apply', 'mcp__fake__list_a'), 0)
    const saved = JSON.parse(fs.readFileSync(s.config, 'utf8'))
    assert.equal(saved.share, true)
    assert.equal(saved.mcpServers.fake.share, true)
  })

  test('--apply writes the policy atomically, keeps every other key as it was, and leaves no temp file', async () => {
    const s = setup(FAKE_CONFIG)
    assert.equal(await s.allow('--apply', 'mcp__fake__list_a', 'mcp__fake__list_b'), 0)
    const printed = s.take()
    assert.equal(printed[2], `Wrote ${s.config}. The policy is now:`)
    assert.deepEqual(JSON.parse(fs.readFileSync(s.config, 'utf8')), {
      ...FAKE_CONFIG,
      policy: [
        { match: 'mcp__fake__list_a', action: 'allow' },
        { match: 'mcp__fake__list_b', action: 'allow' },
        ...POLICY,
      ],
    })
    assert.deepEqual(fs.readdirSync(path.dirname(s.config)).sort(), ['config.json', 'home'])
    if (process.platform !== 'win32') assert.equal(fs.statSync(s.config).mode & 0o777, 0o600)

    const before = fs.readFileSync(s.config, 'utf8')
    assert.equal(await s.allow('--apply', 'mcp__fake__list_a'), 0, 'a second run')
    assert.deepEqual(s.take(), [
      'keep: mcp__fake__list_a: allowed already by policy[0] {"match": "mcp__fake__list_a", "action": "allow"}',
      `The policy needs no change. allow did not change ${s.config}.`,
    ])
    assert.equal(fs.readFileSync(s.config, 'utf8'), before)
  })

  test('refuses a name that is not plain or of no server of the config, exits 2 and writes nothing', async () => {
    const s = setup(FAKE_CONFIG)
    for (const tools of [
      ['mcp__fake__list_issues$(touch${IFS}PWNtool)'],
      ['mcp__fake__list_a', 'mcp__other__list'],
      ['mcp__fake__*'],
    ]) {
      assert.equal(await s.allow('--apply', ...tools), 2, tools.join(' '))
      const printed = s.take()
      assert.ok(printed.includes(`allow did not change ${s.config}.`), printed.join('\n'))
      assert.equal(fs.readFileSync(s.config, 'utf8'), s.text)
    }
    assert.equal(await s.allow('--apply'), 2, 'no tool')
  })

  test('a config that cannot be read exits 1', async () => {
    const s = setup('{ "mcpServers": { "fake": ', 'bad.json')
    assert.equal(await s.allow('mcp__fake__list_a'), 1)
    assert.match(s.take().join('\n'), /has errors/)
  })
})

describe('the allow commands of toolscript-mcp tools', () => {
  test('a plain tool that the policy asks for gets a dry-run command, and any other name gets none', async () => {
    const s = setup(FAKE_CONFIG)
    assert.equal(await s.tools('fake'), 0)
    const printed = s.take()
    const block = printed.slice(printed.indexOf('Commands that allow tools:'))
    const run = `    node ${word(MAIN)} allow --config ${word(s.config)}`
    assert.deepEqual(block, [
      'Commands that allow tools:',
      '  - mcp__fake__list_issues$(touch${IFS}PWNtool)',
      '    no command: the name holds a character that a shell can change.',
      '  - "mcp__fake__count`touch PWNtick`"',
      '    no command: the name holds a character that a shell can change.',
      '  - mcp__fake__node${IFS}-v;touch${IFS}PWNlabel',
      '    no command: the name holds a character that a shell can change.',
      '  - mcp__fake__list_a',
      `${run} "mcp__fake__list_a"`,
      '  - mcp__fake__list_b',
      `${run} "mcp__fake__list_b"`,
      '  - mcp__fake__write_c',
      `${run} "mcp__fake__write_c"`,
      '  - mcp__fake__asked',
      '    no command: the ask rule policy[2] {"match": "mcp__fake__asked", "action": "ask"} names it. allow never loosens an ask rule.',
      '  - mcp__fake__hidden',
      '    no command: the deny rule policy[4] {"match": "mcp__fake__hidden", "action": "deny"} matches it. allow never loosens a deny rule.',
      '  - every read-only tool above with a command',
      `${run} "mcp__fake__list_a" "mcp__fake__list_b"`,
    ])
    for (const line of printed.filter(l => /^ {4}(node|npx|claude|pushd) /.test(l)))
      assert.match(line, /^ {4}node "[\w .:()~/'@+-]+" allow --config "[\w .:()~/'@+-]+"( "mcp__[\w.-]+")+$/)
    for (const line of printed.filter(l => /^ {2}\S/.test(l))) assert.match(line, /^ {2}- /)
  })

  test('a config path that a shell can change gets no command, and the text says which path', async () => {
    const s = setup(FAKE_CONFIG, 'c%d/config.json')
    assert.equal(await s.tools('fake'), 0)
    const printed = s.take()
    const at = printed.indexOf('Commands that allow tools:')
    assert.deepEqual(printed.slice(at + 1, at + 3), [
      "  no command: a shell can change the path of the config file. A path in a command holds only letters, digits, spaces, a drive letter and . _ - ( ) ~ / ' @ +.",
      `    path: ${s.config}`,
    ])
    assert.ok(!printed.some(l => /^ {4}node /.test(l)), printed.join('\n'))
  })

  // The child reads only the temp home. NODE_OPTIONS lets Node 22.13 run main.ts.
  const childEnv = (home: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData'),
      XDG_CONFIG_HOME: home,
      FAKE_TOKEN: 'x',
      NODE_OPTIONS: '--experimental-strip-types --no-warnings',
    }
    delete env.TOOLSCRIPT_CONFIG
    delete env.CLAUDE_CONFIG_DIR
    return env
  }

  for (const [shell, { present, run }] of Object.entries(SHELLS))
    test(
      `${shell} runs the printed dry run, then the printed apply line, and the config gets exactly the rules`,
      { skip: !present() && `no ${shell}` },
      async () => {
        const s = setup(FAKE_CONFIG, 'cfg dir (x)/config.json')
        assert.equal(await s.tools('fake'), 0)
        const listed = s.take()
        const all = listed[listed.indexOf('  - every read-only tool above with a command') + 1] ?? ''
        const cwd = path.join(s.dir, 'cwd')
        fs.mkdirSync(cwd)
        const env = childEnv(s.home)
        const dry = run([all], { cwd, env })
        assert.equal(fs.readFileSync(s.config, 'utf8'), s.text, dry)
        const apply = dry.split(/\r?\n/).filter(l => /^ {4}node /.test(l))
        assert.equal(apply.length, 1, dry)
        const applied = run(apply, { cwd, env })
        assert.deepEqual(
          JSON.parse(fs.readFileSync(s.config, 'utf8')),
          {
            ...FAKE_CONFIG,
            policy: [
              { match: 'mcp__fake__list_a', action: 'allow' },
              { match: 'mcp__fake__list_b', action: 'allow' },
              ...POLICY,
            ],
          },
          applied,
        )
        assert.deepEqual(fs.readdirSync(cwd), [], 'no payload ran')
      },
    )
})
