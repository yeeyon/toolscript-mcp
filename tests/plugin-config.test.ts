import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { decide, matches, type Action } from '../src/core/policy.ts'
import * as plugin from '../plugin/skills/setup/policy.mjs'

const SCRIPT = fileURLToPath(new URL('../plugin/skills/setup/config.mjs', import.meta.url))
const SECRETS = [
  'fake-secret-123',
  'fake-header-456',
  'fake-arg-789',
  'fake-q',
  '/fake-path',
  'fake-user',
  'fake-pass',
  'fake-oauth-id',
]

const FIXTURE = {
  mcpServers: {
    local: {
      command: '/usr/bin/fake-server',
      args: ['--key', 'fake-arg-789'],
      env: { TOKEN: 'fake-secret-123' },
    },
    remote: {
      type: 'http',
      url: 'https://fake-user:fake-pass@mcp.example.com/fake-path?token=fake-q',
      headers: { Authorization: 'Bearer fake-header-456' },
    },
    login: {
      type: 'http',
      url: 'https://login.example.com/mcp',
      oauth: { clientId: 'fake-oauth-id' },
    },
    open: { type: 'http', url: 'https://open.example.com/mcp' },
  },
  policy: [{ match: 'mcp__fake__*', action: 'allow' }],
  sandbox: { callTimeoutSeconds: 7 },
}

let dir: string
let n = 0

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-'))
})
after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(...args: string[]) {
  return runWith({}, ...args)
}

function runWith(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function makeConfig(content: string = JSON.stringify(FIXTURE, null, 2)): string {
  const file = path.join(dir, `config-${n++}.json`)
  fs.writeFileSync(file, content)
  return file
}

function makeEntry(value: unknown): string {
  const file = path.join(dir, `entry-${n++}.json`)
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

describe('plugin config helper', () => {
  it('shows the servers and the policy without a secret', () => {
    const { code, out } = run(makeConfig())
    assert.equal(code, 0)
    const lines = out.split('\n')
    assert.ok(lines.includes('local  stdio  fake-server'))
    assert.ok(lines.includes('remote  http  https://mcp.example.com'))
    assert.ok(lines.includes('login  http  https://login.example.com  oauth'))
    assert.ok(lines.includes('open  http  https://open.example.com  oauth'))
    assert.ok(lines.includes('policy:'))
    assert.ok(lines.includes('{"match":"mcp__fake__*","action":"allow"}'))
    for (const secret of SECRETS) assert.ok(!out.includes(secret), secret)
  })

  it('says when the policy is empty', () => {
    const file = makeConfig(JSON.stringify({ mcpServers: {} }))
    assert.match(run(file).out, /policy: empty, so each tool is ask/)
  })

  it('writes the policy in order and keeps the other keys', () => {
    const file = makeConfig()
    const { code, out } = run(file, 'policy', 'deny', 'mcp__fake__delete*', 'allow', 'mcp__fake__*')
    assert.equal(code, 0)
    assert.ok(!out.includes('added'), out)
    assert.ok(out.includes('{"match":"mcp__fake__delete*","action":"deny"}\n{"match":"mcp__fake__*","action":"allow"}'))
    const saved = JSON.parse(read(file))
    assert.deepEqual(saved.policy, [
      { match: 'mcp__fake__delete*', action: 'deny' },
      { match: 'mcp__fake__*', action: 'allow' },
    ])
    assert.deepEqual(saved.mcpServers, FIXTURE.mcpServers)
    assert.deepEqual(saved.sandbox, FIXTURE.sandbox)
    assert.ok(read(file).endsWith('}\n'))
  })

  it('puts new rules first and keeps the other rules after them', () => {
    const file = makeConfig(
      JSON.stringify({
        ...FIXTURE,
        policy: [
          { match: 'mcp__fake__*', action: 'allow' },
          { match: 'mcp__cc__Bash', action: 'allow' },
          { match: '*', action: 'allow' },
        ],
      }),
    )
    const rules = ['allow', 'mcp__cc__Read', 'ask', 'mcp__cc__Bash', 'deny', 'mcp__cc__*']
    const expected = [
      { match: 'mcp__cc__Read', action: 'allow' },
      { match: 'mcp__cc__Bash', action: 'ask' },
      { match: 'mcp__cc__*', action: 'deny' },
      { match: 'mcp__fake__*', action: 'allow' },
      { match: '*', action: 'allow' },
    ]
    for (let round = 0; round < 2; round++) {
      const { code, out } = run(file, 'prepend', ...rules)
      assert.equal(code, 0)
      assert.ok(out.includes('{"match":"mcp__cc__*","action":"deny"}\n{"match":"mcp__fake__*","action":"allow"}'))
      const saved = JSON.parse(read(file))
      assert.deepEqual(saved.policy, expected)
      assert.deepEqual(saved.mcpServers, FIXTURE.mcpServers)
      assert.deepEqual(saved.sandbox, FIXTURE.sandbox)
    }
  })

  it('refuses prepend with no pairs or a bad rule and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    assert.equal(run(file, 'prepend').code, 2)
    assert.equal(run(file, 'prepend', 'permit', 'mcp__fake__x').code, 2)
    assert.equal(run(file, 'prepend', 'allow', 'fake__x').code, 2)
    assert.equal(read(file), before)
  })

  it('empties the policy with no pairs', () => {
    const file = makeConfig()
    assert.equal(run(file, 'policy').code, 0)
    assert.deepEqual(JSON.parse(read(file)).policy, [])
  })

  it('refuses a bad action and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    const { code, err } = run(file, 'policy', 'allow', 'mcp__fake__*', 'permit', 'mcp__fake__x')
    assert.equal(code, 2)
    assert.match(err, /allow, deny or ask/)
    assert.equal(read(file), before)
  })

  it('adds a server and shows it', () => {
    const file = makeConfig()
    const entry = makeEntry({ command: 'node', args: ['fake.js'], env: { K: 'fake-secret-123' } })
    const { code, out } = run(file, 'add', 'extra_one', entry)
    assert.equal(code, 0)
    assert.ok(out.includes('extra_one  stdio  node'))
    assert.ok(!out.includes('fake-secret-123'))
    const saved = JSON.parse(read(file))
    assert.equal(saved.mcpServers.extra_one.env.K, 'fake-secret-123')
    assert.deepEqual(saved.policy, FIXTURE.policy)
    assert.equal(Object.keys(saved.mcpServers).length, 5)
  })

  it('refuses a duplicate name, a bad name and a bad entry', () => {
    const file = makeConfig()
    const before = read(file)
    const good = makeEntry({ command: 'node' })
    assert.equal(run(file, 'add', 'local', good).code, 1)
    assert.equal(run(file, 'add', 'bad name', good).code, 1)
    assert.equal(run(file, 'add', 'bad__name', good).code, 1)
    assert.equal(run(file, 'add', 'fresh', makeEntry({ type: 'http' })).code, 1)
    assert.equal(run(file, 'add', 'fresh', makeEntry(['node'])).code, 1)
    assert.equal(run(file, 'add', 'fresh', makeEntry({ command: 5 })).code, 1)
    assert.equal(read(file), before)
  })

  it('refuses a config that is not valid JSON and leaves it as it was', () => {
    const file = makeConfig('{ not json')
    for (const args of [[], ['policy', 'allow', 'mcp__fake__*'], ['add', 'fresh', makeEntry({ command: 'node' })]]) {
      const { code } = run(file, ...args)
      assert.equal(code, 1)
      assert.equal(read(file), '{ not json')
    }
  })

  it('hides a command with arguments in it and a URL from a variable', () => {
    const file = makeConfig(
      JSON.stringify({
        mcpServers: {
          inline: { command: 'npx -y fake-server --api-key fake-secret-123' },
          fromvar: { type: 'http', url: '${FAKE_URL}' },
        },
      }),
    )
    const { code, out } = run(file)
    assert.equal(code, 0)
    assert.ok(out.split('\n').includes('inline  stdio'))
    assert.ok(out.includes('fromvar  http  url-from-a-variable  oauth'))
    assert.ok(!out.includes('fake-secret-123'))
  })

  it('refuses a match that the server rejects and leaves the file as it was', () => {
    const file = makeConfig()
    const before = read(file)
    for (const match of ['fake__*', '']) {
      const { code, err } = run(file, 'policy', 'allow', match)
      assert.equal(code, 2)
      assert.match(err, /starts with mcp__ or \*/)
    }
    assert.equal(read(file), before)
  })

  it('makes the config and its folder when add finds no config', () => {
    const file = path.join(dir, `new-${n++}`, 'config.json')
    const { code, out } = run(file, 'add', 'fake', makeEntry({ command: 'node' }))
    assert.equal(code, 0)
    assert.ok(out.includes('fake  stdio  node'))
    assert.deepEqual(JSON.parse(read(file)), { mcpServers: { fake: { command: 'node' } }, policy: [] })
  })

  it('prints the default config path', () => {
    assert.equal(runWith({ TOOLSCRIPT_CONFIG: 'C:/fake/config.json' }, 'path').out.trim(), 'C:/fake/config.json')
    const base = process.platform === 'win32' ? { APPDATA: dir } : { XDG_CONFIG_HOME: dir }
    const { code, out } = runWith({ TOOLSCRIPT_CONFIG: '', ...base }, 'path')
    assert.equal(code, 0)
    assert.equal(out.trim(), path.join(dir, 'toolscript-mcp', 'config.json').replaceAll('\\', '/'))
  })

  it('exits 1 for a missing config and 2 for a usage error', () => {
    assert.equal(run(path.join(dir, 'missing.json')).code, 1)
    assert.equal(run(makeConfig(), 'policy', 'allow').code, 2)
    assert.equal(run(makeConfig(), 'unknown').code, 2)
  })
})

type Rule = { match: string; action: Action }

const B = 'mcp__claude-code__'
// A tool of the bridge that the tools reference of Claude Code does not list, such as one that a later version adds.
const NEW_TOOL = 'NewTool'
const rule = (action: Action, match: string): Rule => ({ match, action })
const asArgs = (rules: Rule[]) => rules.flatMap(r => [r.action, r.match])
const realDecide = (policy: readonly Rule[], tool: string) =>
  decide(
    policy.map((r, index) => ({ ...r, index })),
    tool,
  )

// The rules of step 7 item 4 of the setup skill.
const STEP_7 = [
  rule('allow', `${B}Read`),
  rule('allow', `${B}Grep`),
  rule('allow', `${B}Glob`),
  rule('ask', `${B}Bash`),
  rule('ask', `${B}PowerShell`),
  rule('ask', `${B}Edit`),
  rule('ask', `${B}Write`),
  rule('deny', `${B}*`),
]

describe('the policy commands and the tools of the Claude Code bridge', () => {
  const withPolicy = (policy: Rule[]) => makeConfig(JSON.stringify({ ...FIXTURE, policy }))
  const savedPolicy = (file: string): Rule[] => JSON.parse(read(file)).policy
  const decides = (file: string, tool: string) => realDecide(savedPolicy(file), `${B}${tool}`).action
  const addedLines = (out: string) => {
    const [title, ...lines] = out.split('\n')
    if (title !== 'added these rules for the tools of claude-code:') return []
    return lines.slice(
      0,
      lines.findIndex(line => !line.startsWith('{')),
    )
  }
  // Runs the command twice: the second run must leave the file as the first run wrote it.
  const twice = (file: string, ...args: string[]) => {
    const first = run(file, ...args)
    assert.equal(first.code, 0, first.err)
    const written = read(file)
    assert.equal(run(file, ...args).code, 0)
    assert.equal(read(file), written, 'a second run changed the policy')
    return first.out
  }

  // The review of #47: the command put the rules of the bridge first, so `allow mcp__claude-code__*` came before the
  // deny of the person, and Bash was allowed.
  it('writes the rules of the person in their order, so the first rule that matches decides', () => {
    const file = withPolicy(STEP_7)
    const rules = [rule('deny', 'mcp__*__Bash'), rule('allow', `${B}*`), rule('allow', '*')]
    const out = twice(file, 'policy', ...asArgs(rules))
    assert.ok(!out.includes('added'), out)
    assert.deepEqual(savedPolicy(file), rules)
    assert.equal(decides(file, 'Bash'), 'deny')
    for (const tool of ['Write', 'Agent', NEW_TOOL]) assert.equal(decides(file, tool), 'allow', tool)
  })

  // The review of #47: the old allow rule of the bridge stayed, and moved above the deny that had come before it.
  it('keeps the old decision of a tool that a rule for every server decided', () => {
    const file = withPolicy([rule('deny', 'mcp__*__Bash'), rule('allow', `${B}*`), rule('allow', '*')])
    const out = twice(file, 'policy', 'deny', 'mcp__github__*delete*', 'allow', '*')
    assert.ok(out.startsWith(`added these rules for the tools of claude-code:\n{"match":"${B}Bash","action":"deny"}\n`))
    assert.deepEqual(savedPolicy(file), [
      rule('deny', `${B}Bash`),
      rule('deny', 'mcp__github__*delete*'),
      rule('allow', '*'),
    ])
    assert.equal(decides(file, 'Bash'), 'deny')
    for (const tool of ['Write', NEW_TOOL]) assert.equal(decides(file, tool), 'allow', tool)
  })

  // The review of #47: a rule of the bridge spelled in another way was not kept, so `allow "*"` allowed the tool.
  for (const match of ['mcp__claude-code*', 'mcp__claude*', 'mcp__*__Bash', '*Bash']) {
    it(`keeps the deny of an old rule ${match} under a new "*" rule`, () => {
      const file = withPolicy([rule('deny', match)])
      twice(file, 'policy', 'allow', '*')
      assert.equal(decides(file, 'Bash'), 'deny')
      const all = match.startsWith('mcp__claude')
      for (const tool of ['Read', 'Write', NEW_TOOL]) assert.equal(decides(file, tool), all ? 'deny' : 'ask', tool)
      assert.equal(realDecide(savedPolicy(file), 'mcp__github__delete_repo').action, 'allow')
    })
  }

  // The review of #47: a prepended rule with a * took only the stricter action of old rules with the same match.
  it('keeps the deny of an old rule for every server in prepend, also under a new rule with a *', () => {
    const file = withPolicy([rule('deny', 'mcp__*__Bash')])
    const out = twice(file, 'prepend', 'allow', `${B}*`)
    assert.ok(out.startsWith(`added these rules for the tools of claude-code:\n{"match":"${B}Bash","action":"deny"}\n`))
    assert.equal(decides(file, 'Bash'), 'deny')
    for (const tool of ['Read', 'Write', NEW_TOOL]) assert.equal(decides(file, tool), 'allow', tool)
  })

  for (const [match, tool] of [
    [`${B}B*`, 'Bash'],
    ['mcp__*__Write', 'Write'],
  ] as const) {
    it(`keeps the deny of an old rule ${match} in the prepend of step 7, and prints it`, () => {
      const file = withPolicy([rule('deny', match), rule('allow', '*')])
      const out = twice(file, 'prepend', ...asArgs(STEP_7))
      assert.ok(
        out.startsWith(`added these rules for the tools of claude-code:\n{"match":"${B}${tool}","action":"deny"}\n`),
      )
      assert.equal(decides(file, tool), 'deny')
      assert.equal(decides(file, 'Read'), 'allow')
      assert.equal(decides(file, 'Edit'), 'ask')
      for (const other of ['Agent', NEW_TOOL]) assert.equal(decides(file, other), 'deny', other)
    })
  }

  it('keeps every tool denied when the prepend of step 7 comes after a deny of the whole bridge', () => {
    const file = withPolicy([rule('deny', `${B}*`), rule('allow', '*')])
    twice(file, 'prepend', ...asArgs(STEP_7))
    for (const tool of ['Read', 'Grep', 'Bash', 'Write', 'Agent', NEW_TOOL])
      assert.equal(decides(file, tool), 'deny', tool)
  })

  it('never loosens an old rule with the same match in prepend', () => {
    const file = withPolicy([
      rule('deny', `${B}Bash`),
      rule('ask', `${B}Read`),
      rule('allow', `${B}Write`),
      rule('allow', '*'),
    ])
    const out = twice(file, 'prepend', ...asArgs(STEP_7))
    assert.deepEqual(addedLines(out), [`{"match":"${B}Bash","action":"deny"}`, `{"match":"${B}Read","action":"ask"}`])
    assert.deepEqual(savedPolicy(file), [
      rule('deny', `${B}Bash`),
      rule('ask', `${B}Read`),
      ...STEP_7,
      rule('allow', '*'),
    ])
    assert.equal(decides(file, 'Bash'), 'deny')
    assert.equal(decides(file, 'Read'), 'ask')
    assert.equal(decides(file, 'Write'), 'ask')
  })

  it('takes the rules of step 7 as they are when no old rule decides the tools', () => {
    const file = withPolicy([rule('deny', 'mcp__fake__*')])
    const out = twice(file, 'prepend', ...asArgs(STEP_7))
    assert.ok(!out.includes('added'), out)
    assert.deepEqual(savedPolicy(file), [...STEP_7, rule('deny', 'mcp__fake__*')])
  })

  it('keeps the rules of step 7 in force under a new policy that names no tool of the bridge', () => {
    const file = withPolicy(STEP_7)
    const out = twice(file, 'policy', 'deny', 'mcp__fake__delete*', 'allow', '*')
    assert.deepEqual(addedLines(out), [
      ...[STEP_7[3], STEP_7[5], STEP_7[2], STEP_7[1], STEP_7[4], STEP_7[0], STEP_7[6]].map(r => JSON.stringify(r)),
      `{"match":"${B}*","action":"deny"}`,
    ])
    assert.deepEqual(savedPolicy(file).slice(7), [
      rule('deny', 'mcp__fake__delete*'),
      rule('deny', `${B}*`),
      rule('allow', '*'),
    ])
    for (const tool of ['Read', 'Grep', 'Glob']) assert.equal(decides(file, tool), 'allow', tool)
    for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write']) assert.equal(decides(file, tool), 'ask', tool)
    for (const tool of ['Agent', 'WebFetch', NEW_TOOL]) assert.equal(decides(file, tool), 'deny', tool)

    twice(file, 'policy')
    for (const tool of ['Read', 'Bash', 'Write']) assert.equal(decides(file, tool), 'ask', tool)
    for (const tool of ['Agent', NEW_TOOL]) assert.equal(decides(file, tool), 'deny', tool)
  })

  it('opens one tool with a rule that names it, and keeps the others', () => {
    const file = withPolicy(STEP_7)
    twice(file, 'policy', 'allow', `${B}Agent`, 'allow', '*')
    assert.equal(decides(file, 'Agent'), 'allow')
    assert.equal(decides(file, 'Bash'), 'ask')
    for (const tool of ['WebFetch', NEW_TOOL]) assert.equal(decides(file, tool), 'deny', tool)

    const fresh = withPolicy([])
    twice(fresh, 'policy', 'allow', `${B}Read`, 'allow', '*')
    assert.deepEqual(savedPolicy(fresh), [rule('allow', `${B}Read`), rule('ask', `${B}*`), rule('allow', '*')])
    assert.equal(decides(fresh, 'Read'), 'allow')
    for (const tool of ['Bash', 'Agent', NEW_TOOL]) assert.equal(decides(fresh, tool), 'ask', tool)
    assert.equal(realDecide(savedPolicy(fresh), 'mcp__github__delete_repo').action, 'allow')
  })

  it('opens the whole bridge with a rule that names it', () => {
    const file = withPolicy(STEP_7)
    const out = twice(file, 'policy', 'allow', `${B}*`, 'allow', '*')
    assert.ok(!out.includes('added'), out)
    for (const tool of ['Read', 'Bash', 'Write', 'Agent', NEW_TOOL]) assert.equal(decides(file, tool), 'allow', tool)
  })
})

// policy.mjs is the part of config.mjs without a file, so this test runs many policies in one process.
describe('the policy commands over random policies', () => {
  const MATCHES = [
    '*',
    'mcp__*',
    'mcp__claude*',
    'mcp__claude-code*',
    `${B}*`,
    `${B}B*`,
    `${B}Bash`,
    `${B}Read`,
    `${B}Cron*`,
    `${B}*e*`,
    'mcp__*__Bash',
    '*Bash',
    'mcp__*__Write',
    '*Write*',
    '*delete*',
    'mcp__*__*delete*',
    'mcp__github__*',
    'mcp__claude-codex__*',
    '*d',
  ]
  const ACTIONS: Action[] = ['allow', 'deny', 'ask']
  const KNOWN = (plugin.BRIDGE_TOOLS as string[]).map(tool => B + tool)
  const UNKNOWN = [NEW_TOOL, 'CronPause', 'xBash', 'odd~1'].map(tool => B + tool)
  const OTHERS = ['mcp__github__delete_repo', 'mcp__github__get', 'mcp__claude-codex__Bash', 'mcp__x__Bash']
  // A rule for some tools of the bridge only: it does not match a name that ends in a character of no match.
  const forSome = (r: Rule) => !matches(r.match, `${B}\u0007`)
  let seed = 47
  const random = (below: number) => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) % below
  }
  const randomPolicy = (): Rule[] =>
    Array.from({ length: random(6) }, () => rule(ACTIONS[random(3)]!, MATCHES[random(MATCHES.length)]!))
  const plain = (policy: readonly Rule[]) => policy.map(({ match, action }) => ({ match, action }))
  const looseness = { deny: 0, ask: 1, allow: 2 }

  it('loosens a tool of the bridge only by a new rule that starts with mcp__claude-code__', () => {
    let opened = 0
    for (let i = 0; i < 1000; i++) {
      const old = randomPolicy()
      const rules = randomPolicy()
      for (const command of ['policy', 'prepend'] as const) {
        const make = command === 'policy' ? plugin.setPolicy : plugin.prependPolicy
        const named = new Set(rules.map(r => r.match))
        const next = command === 'policy' ? rules : [...rules, ...old.filter(r => !named.has(r.match))]
        const { policy, added } = make(old, rules) as { policy: Rule[]; added: Rule[] }
        const at = `${command} ${JSON.stringify(rules)} over ${JSON.stringify(old)}: ${JSON.stringify(plain(policy))}`
        // A tool that is not in BRIDGE_TOOLS gets the decision of the other tools, unless a rule for some tools
        // matches it: the guard does not keep such a decision.
        const tools = [
          ...KNOWN,
          ...UNKNOWN.filter(tool => ![...old, ...next].some(r => forSome(r) && matches(r.match, tool))),
        ]
        for (const tool of tools) {
          const was = realDecide(old, tool)
          const now = realDecide(policy, tool)
          if (looseness[now.action] <= looseness[was.action]) continue
          opened++
          const by = realDecide(next, tool).rule
          assert.ok(by !== undefined && by.index < rules.length && by.match.startsWith(B), `${tool} in ${at}`)
          assert.equal(now.action, by.action, `${tool} in ${at}`)
          if (command === 'prepend') assert.equal(was.rule, undefined, `${tool} in ${at}`)
        }
        for (const tool of OTHERS) assert.equal(realDecide(policy, tool).action, realDecide(next, tool).action, at)
        assert.ok(
          added.every(r => r.match.startsWith(B)),
          at,
        )
        if (command === 'policy') assert.deepEqual(plain(policy.filter(r => !added.includes(r))), rules, at)
        assert.deepEqual(
          plain((make(policy, rules) as { policy: Rule[] }).policy),
          plain(policy),
          `second run of ${at}`,
        )
      }
    }
    assert.ok(opened > 1000, `only ${opened} tools opened`)
  })

  it('matches and decides as src/core/policy.ts', () => {
    const chars = ['a', 'b', '_', '*', '-', '\u0000', '$', '__', 'mcp', 'c']
    const text = (most: number) => Array.from({ length: random(most) }, () => chars[random(chars.length)]).join('')
    for (let i = 0; i < 20000; i++) {
      const glob = text(7)
      const tool = text(9).replaceAll('*', 'x')
      assert.equal(plugin.matches(glob, tool), matches(glob, tool), `${JSON.stringify(glob)} ${JSON.stringify(tool)}`)
    }
    for (let i = 0; i < 2000; i++) {
      const policy = randomPolicy()
      for (const tool of [...KNOWN.slice(0, 8), ...UNKNOWN, ...OTHERS]) {
        assert.equal(plugin.decide(policy, tool).action, realDecide(policy, tool).action)
      }
    }
  })
})
