// The pure parts of the toolscript arms of bench/interactive.mjs (bench/arms.mjs, bench/spend.mjs): no pty, no Claude Code, no
// spend. The dry run is the script itself, run against two fake builds in a temp folder.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PINNED_105,
  buildFields,
  buildLines,
  buildOfArm,
  childEnv,
  cwdSlug,
  entryEnv,
  envOfArm,
  firstMethodOf,
  homeEnv,
  jobsOf,
  passRule,
  readBuild,
  resolveBuilds,
  toolscriptEntry,
} from '../bench/arms.mjs'
import { estimate } from '../bench/spend.mjs'
import { TOOL } from '../src/core/tools.ts'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-bench-arms-')))
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

/** A fake build: dist/host/main.js with `text` and a package.json with `version`. */
const fakeBuild = (name: string, version: string, text: string) => {
  const root = path.join(dir, name)
  fs.mkdirSync(path.join(root, 'dist', 'host'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'host', 'main.js'), text)
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(root, 'runtime', 'runner.mjs'), `runner of ${text}`)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'toolscript-mcp', version }))
  return root
}
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

describe('the arm table', () => {
  const head = readBuild(fakeBuild('t-head', '1.1.0', 'head main'))
  const base = readBuild(fakeBuild('t-base', '1.0.5', 'base main'))
  const builds = { head, base }

  test('three entries: the build path and one variable differ, nothing else', () => {
    const config = '/run/toolscript.json'
    const entries = Object.fromEntries(
      ['toolscript', 'toolscript-legacy', 'toolscript-1.0.5'].map(arm => [
        arm,
        toolscriptEntry(builds[buildOfArm(arm)!], config, envOfArm(arm)),
      ]),
    )
    assert.deepEqual(entries.toolscript, { command: 'node', args: [head.main, '--config', config] })
    assert.deepEqual(entries['toolscript-legacy'], {
      command: 'node',
      args: [head.main, '--config', config],
      env: { TOOLSCRIPT_PROTOCOL: 'legacy' },
    })
    assert.deepEqual(entries['toolscript-1.0.5'], { command: 'node', args: [base.main, '--config', config] })
    // The default arm has no `env` key at all, so it runs on the default of the build.
    assert.ok(!('env' in entries.toolscript))
    assert.equal(buildOfArm('toolscript-lean'), 'head')
    assert.equal(buildOfArm('direct'), undefined)
  })

  test('the row fields name what ran: version, hash, variables and the first method', () => {
    assert.deepEqual(buildFields('toolscript-legacy', builds, 'initialize'), {
      version: '1.1.0',
      mainSha256: sha('head main'),
      runnerSha256: sha('runner of head main'),
      variables: { TOOLSCRIPT_PROTOCOL: 'legacy' },
      firstMethod: 'initialize',
    })
    assert.deepEqual(buildFields('toolscript-1.0.5', builds, undefined), {
      version: '1.0.5',
      mainSha256: sha('base main'),
      runnerSha256: sha('runner of base main'),
      variables: {},
      firstMethod: null,
    })
    assert.deepEqual(buildFields('direct', builds, 'initialize'), {})
  })

  test('the first method comes from the first line of the file of the fake server', () => {
    assert.equal(firstMethodOf('{"method":"server/discover"}\n'), 'server/discover')
    assert.equal(firstMethodOf('{"method":"initialize"}\n{"method":"x"}\n'), 'initialize')
    for (const bad of ['', 'not json', '{}', '{"method":3}']) assert.equal(firstMethodOf(bad), undefined)
  })

  test('the fake server writes it: the first method once, and not into the call log', () => {
    const log = path.join(dir, 'calls.jsonl')
    const r = spawnSync(process.execPath, [path.join(REPO, 'bench', 'fake-server.mjs')], {
      env: { ...process.env, BENCH_LOG: log },
      input: [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
        '',
      ].join('\n'),
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(firstMethodOf(fs.readFileSync(`${log}.first`, 'utf8')), 'server/discover')
    assert.ok(!fs.existsSync(log), 'no tools/call, so no call log')
  })

  test('the lines above the tables list each toolscript arm once with its values', () => {
    const row = (arm: string, extra: object = {}) => ({ arm, ...buildFields(arm, builds, 'initialize'), ...extra })
    const lines = buildLines([
      row('toolscript-1.0.5'),
      row('toolscript-1.0.5'),
      row('toolscript-legacy'),
      { arm: 'direct' },
    ])
    const text = lines.join('\n')
    assert.equal(lines.filter(l => l.startsWith('- ')).length, 2)
    assert.match(
      text,
      new RegExp(
        `- toolscript-1.0.5: version 1.0.5, main.js SHA-256 ${sha('base main')}, runner.mjs SHA-256 ${sha('runner of base main')}, variables none, first method sent initialize`,
      ),
    )
    assert.match(text, /- toolscript-legacy: version 1.1.0, .*variables TOOLSCRIPT_PROTOCOL=legacy/)
    assert.deepEqual(buildLines([{ arm: 'direct' }, { arm: 'codemode' }]), [])
  })
})

describe('the builds', () => {
  test('a folder with no main.js, no package.json or no version is an error that names the folder', () => {
    const none = path.join(dir, 'none')
    fs.mkdirSync(none)
    assert.match(readBuild(none).error, /has no dist\/host\/main\.js/)
    const noPackage = fakeBuild('no-package', '1.0.0', 'x')
    fs.rmSync(path.join(noPackage, 'package.json'))
    assert.match(readBuild(noPackage).error, /no readable package\.json/)
    const noVersion = fakeBuild('no-version', '1.0.0', 'x')
    fs.writeFileSync(path.join(noVersion, 'package.json'), '{}')
    assert.match(readBuild(noVersion).error, /no version/)
  })

  test('an arm whose build is missing ends the command with one line that names the flag', () => {
    const good = fakeBuild('good', '1.0.5', 'good')
    const arms = ['toolscript-1.0.5', 'toolscript-legacy', 'toolscript']
    assert.deepEqual(resolveBuilds({ armIds: arms, head: good, base: undefined, repo: good }).errors, [
      '--base <dir> is needed by the arm toolscript-1.0.5: a folder with dist/host/main.js',
    ])
    const missing = resolveBuilds({
      armIds: arms,
      head: path.join(dir, 'gone'),
      base: path.join(dir, 'gone2'),
      repo: good,
    })
    assert.equal(missing.errors.length, 2)
    assert.match(missing.errors[0]!, /^--head: .* has no dist\/host\/main\.js$/)
    assert.match(missing.errors[1]!, /^--base: .* has no dist\/host\/main\.js$/)
    // An arm that runs no build needs none: the old arms keep their behaviour.
    assert.deepEqual(
      resolveBuilds({ armIds: ['direct', 'codemode'], head: undefined, base: undefined, repo: path.join(dir, 'gone') }),
      {
        errors: [],
        warnings: [],
        builds: {},
      },
    )
    // The head defaults to the repo.
    assert.equal(
      resolveBuilds({ armIds: ['toolscript'], head: undefined, base: undefined, repo: good }).builds.head?.dir,
      good,
    )
  })

  test('a build with no runtime/runner.mjs is an error', () => {
    const noRunner = fakeBuild('no-runner', '1.0.5', 'x')
    fs.rmSync(path.join(noRunner, 'runtime'), { recursive: true })
    assert.match(readBuild(noRunner).error, /has no runtime\/runner\.mjs/)
  })

  test('a base whose main.js is the head main.js ends the command: the comparison would be void', () => {
    const a = fakeBuild('same-a', '1.1.0', 'one text')
    const b = fakeBuild('same-b', '1.0.5', 'one text')
    const r = resolveBuilds({ armIds: ['toolscript-1.0.5', 'toolscript'], head: a, base: b, repo: a })
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0]!, /^--base and --head hold the same dist\/host\/main\.js \(SHA-256 [0-9a-f]{64}\)/)
  })

  test('a base that is not the published 1.0.5 warns once; the published bytes do not', () => {
    const head = fakeBuild('warn-head', '1.1.0', 'head text')
    const other = fakeBuild('warn-base', '1.0.5', 'local build')
    const warned = resolveBuilds({ armIds: ['toolscript-1.0.5'], head, base: other, repo: head })
    assert.deepEqual(warned.errors, [])
    assert.equal(warned.warnings.length, 1)
    assert.match(warned.warnings[0]!, /^WARN --base: dist\/host\/main\.js and runtime\/runner\.mjs of .*warn-base/)
    assert.ok(warned.warnings[0]!.includes(PINNED_105.mainSha256))
    assert.match(PINNED_105.mainSha256, /^[0-9a-f]{64}$/)
    assert.match(PINNED_105.runnerSha256, /^[0-9a-f]{64}$/)
  })
})

describe('what the child of an arm sees', () => {
  test('the pty environment has no CLAUDE* and no TOOLSCRIPT_*, whatever the case', () => {
    const env = childEnv(
      {
        PATH: '/bin',
        CLAUDECODE: '1',
        claude_code_effort: 'x',
        TOOLSCRIPT_PROTOCOL: 'modern',
        toolscript_lazy: '0',
        TOOLSCRIPT_CHILD_GUARD: '1',
        KEEP: 'y',
      },
      { codeMode: false, bash: 'C:/bash.exe' },
    )
    assert.deepEqual(env, { PATH: '/bin', KEEP: 'y', CLAUDE_CODE_GIT_BASH_PATH: 'C:/bash.exe' })
    assert.equal(childEnv({}, { codeMode: true, bash: 'b' }).CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, '1')
  })

  test('every toolscript entry has the same keys, with a fresh home and no variable but its own', () => {
    const home = path.join(dir, 'run', 'home')
    assert.deepEqual(homeEnv(home), {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
    })
    assert.deepEqual(entryEnv('toolscript', home), homeEnv(home))
    assert.deepEqual(entryEnv('toolscript-1.0.5', home), homeEnv(home))
    assert.deepEqual(entryEnv('toolscript-legacy', home), { TOOLSCRIPT_PROTOCOL: 'legacy', ...homeEnv(home) })
  })

  test('the cwd of every arm has the same length', () => {
    const all = [
      'direct',
      'codemode',
      'toolscript',
      'toolscript-legacy',
      'toolscript-1.0.5',
      'direct-lean',
      'toolscript-lean',
    ]
    const slugs = all.map(a => cwdSlug(a, all))
    assert.equal(new Set(slugs).size, all.length)
    assert.equal(new Set(slugs.map(s => s.length)).size, 1)
  })
})

describe('the dry run', () => {
  const head = fakeBuild('dry-head', '1.1.0', 'dry head')
  const base = fakeBuild('dry-base', '1.0.5', 'dry base')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(REPO, 'bench', 'interactive.mjs'), '--dry-run', ...args], {
      encoding: 'utf8',
      cwd: dir,
    })

  test('it prints the arms with build, version and hash, the tasks, the count, the order and the spend, and starts nothing', () => {
    const r = run(
      '--head',
      head,
      '--base',
      base,
      '--arms',
      'toolscript-1.0.5,toolscript-legacy,toolscript',
      '--tasks',
      'ticket,logs',
      '--reps',
      '2',
      '--max-spend',
      '0.5',
      '--out',
      path.join(dir, 'out'),
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(
      r.stdout,
      /toolscript-1\.0\.5: build .*dry-base, version 1\.0\.5, main\.js SHA-256 [0-9a-f]{64}, runner\.mjs SHA-256 [0-9a-f]{64}, variables none/,
    )
    assert.ok(r.stdout.includes(sha('dry base')) && r.stdout.includes(sha('dry head')))
    assert.match(r.stdout, /toolscript-legacy: .*version 1\.1\.0, .*variables TOOLSCRIPT_PROTOCOL=legacy/)
    assert.match(r.stdout, /tasks: logs, ticket/)
    assert.match(r.stdout, /runs to do: 12/)
    assert.ok(r.stdout.includes(sha('runner of dry base')) && r.stdout.includes('runner.mjs SHA-256'))
    // The base is not the published 1.0.5, so one WARN line on stderr.
    assert.equal(
      r.stderr
        .trim()
        .split('\n')
        .filter(l => l.startsWith('WARN --base')).length,
      1,
    )
    // The order: arms alternate inside a task, and the start arm moves one place each rep.
    const order = [...r.stdout.matchAll(/^\s*\d+\. (\S+)$/gm)].map(m => m[1])
    assert.deepEqual(order.slice(0, 3), ['logs-toolscript-1.0.5-1', 'logs-toolscript-legacy-1', 'logs-toolscript-1'])
    assert.deepEqual(order.slice(6, 9), ['logs-toolscript-legacy-2', 'logs-toolscript-2', 'logs-toolscript-1.0.5-2'])
    assert.match(r.stdout, /spent so far \$0\.0000, cap \$0\.5/)
    // 12 runs with no saved run: 0.25 USD each, over the cap of 0.5.
    assert.match(r.stdout, /estimate of the 12 planned runs \$3\.0000, total \$3\.0000 against the cap \$0\.5: OVER/)
    // No saved run: every figure is the default, and the dry run says so.
    assert.match(r.stdout, /12 of the 12 runs are estimated at the \$0\.25 default \(no saved run of the arm\)/)
    assert.ok(!fs.existsSync(path.join(dir, 'out')), 'a dry run makes no folder')
  })

  test('it fails on a missing build with the one line that names the flag', () => {
    const r = run('--head', head, '--arms', 'toolscript-1.0.5,toolscript')
    assert.equal(r.status, 2)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.trim(), '--base <dir> is needed by the arm toolscript-1.0.5: a folder with dist/host/main.js')
    const gone = run('--head', path.join(dir, 'gone'), '--arms', 'toolscript')
    assert.equal(gone.status, 2)
    assert.match(gone.stderr, /^--head: .* has no dist\/host\/main\.js\r?\n$/)
  })

  test('jobsOf gives the order that the bench runs', () => {
    const jobs = jobsOf({ tasks: [{ id: 't1' }, { id: 't2' }], armIds: ['toolscript-a', 'toolscript-b'], reps: 2 })
    assert.deepEqual(
      jobs.map((j: { task: { id: string }; arm: string; rep: number }) => `${j.task.id}-${j.arm}-${j.rep}`),
      [
        't1-toolscript-a-1',
        't1-toolscript-b-1',
        't2-toolscript-a-1',
        't2-toolscript-b-1',
        't1-toolscript-b-2',
        't1-toolscript-a-2',
        't2-toolscript-b-2',
        't2-toolscript-a-2',
      ],
    )
  })

  test('codemode keeps its place while the three toolscript arms rotate through the others', () => {
    const arms = ['codemode', 'toolscript-1.0.5', 'toolscript-legacy', 'toolscript']
    const jobs = jobsOf({ tasks: [{ id: 't' }], armIds: arms, reps: 3 }) as { arm: string; rep: number }[]
    const orders = [1, 2, 3].map(rep => jobs.filter(j => j.rep === rep).map(j => j.arm))
    assert.deepEqual(orders, [
      ['codemode', 'toolscript-1.0.5', 'toolscript-legacy', 'toolscript'],
      ['codemode', 'toolscript-legacy', 'toolscript', 'toolscript-1.0.5'],
      ['codemode', 'toolscript', 'toolscript-1.0.5', 'toolscript-legacy'],
    ])
    // Each toolscript arm leads once and follows each other arm once.
    assert.deepEqual(orders.map(o => o[1]).sort(), arms.slice(1).sort())
  })

  test('with three arms each arm leads once in three reps and stands in each place once (a Latin square)', () => {
    const arms = ['toolscript-a', 'toolscript-b', 'toolscript-c']
    const jobs = jobsOf({ tasks: [{ id: 't' }], armIds: arms, reps: 3 }) as { arm: string; rep: number }[]
    const orders = [1, 2, 3].map(rep => jobs.filter(j => j.rep === rep).map(j => j.arm))
    assert.deepEqual(orders, [
      ['toolscript-a', 'toolscript-b', 'toolscript-c'],
      ['toolscript-b', 'toolscript-c', 'toolscript-a'],
      ['toolscript-c', 'toolscript-a', 'toolscript-b'],
    ])
    assert.deepEqual(orders.map(o => o[0]).sort(), arms)
    for (let place = 0; place < 3; place++) assert.deepEqual(orders.map(o => o[place]).sort(), arms)
  })
})

describe('the estimate of a new arm', () => {
  test('a toolscript arm with no run uses the largest cost of any toolscript arm, else 0.25; others keep their rule', () => {
    const rows = [
      { arm: 'toolscript', task: 'ticket', costUsd: 0.03 },
      { arm: 'toolscript-lean', task: 'logs', costUsd: 0.08 },
      { arm: 'direct', task: 'ticket', costUsd: 0.5 },
    ]
    assert.equal(estimate(rows, 'toolscript-1.0.5', 'ticket'), 0.08)
    assert.equal(estimate(rows, 'toolscript', 'ticket'), 0.03)
    assert.equal(estimate(rows, 'toolscript', 'logs'), 0.03, 'the arm rule before the family rule')
    assert.equal(estimate(rows, 'codemode', 'ticket'), 0.25)
    assert.equal(estimate([], 'toolscript-legacy', 'ticket'), 0.25)
    assert.equal(estimate([{ arm: 'direct', task: 'x', costUsd: 0.4 }], 'toolscript-legacy', 'ticket'), 0.25)
  })
})

describe('the pass rule of the release run', () => {
  const run = (arm: string, extra: Record<string, unknown> = {}) => ({
    arm,
    task: 't1',
    version: '1.1.0',
    correct: true,
    cold: false,
    freshInput: 100,
    cacheRead: 9000,
    cacheWrite: 900,
    firstCallInput: 5000,
    failedTools: {},
    ...extra,
  })
  const three = (legacy: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => [
    ...[1, 2, 3].map(() => run('toolscript-1.0.5')),
    ...[1, 2, 3].map(() => run('toolscript-legacy', legacy)),
    ...[1, 2, 3].map(() => run('toolscript', head)),
  ]

  test('equal arms pass, and each limit can fail on its own', () => {
    assert.equal(passRule(three()).pass, true)
    // +2 % passes, over it fails, on the total input and on the first call, for each pair.
    assert.equal(passRule(three({ cacheRead: 9000 + 150 })).pass, true)
    assert.equal(passRule(three({ cacheRead: 9000 + 230 })).pass, false)
    assert.equal(passRule(three({}, { firstCallInput: 5000 * 1.03 })).pass, false)
    assert.equal(passRule(three({}, { cacheWrite: 900 + 300 })).pass, false)
    assert.equal(passRule(three({ failedTools: { [TOOL.run_code]: 1 } })).pass, false)
    assert.equal(passRule(three({}, { failedTools: { [TOOL.run_code]: 1 } })).pass, false)
    // A failed call of another tool is not a failed run_code call.
    assert.equal(passRule(three({ failedTools: { [TOOL.search_tools]: 1 } })).pass, true)
  })

  test('a wrong answer fails its arm, cold runs count for correctness, an error row and codemode are left out of the limits', () => {
    assert.equal(passRule([...three(), run('toolscript', { correct: false })]).pass, false)
    // A wrong answer in a cold run is still a wrong answer.
    assert.equal(passRule([...three(), run('toolscript', { correct: false, cold: true })]).pass, false)
    assert.equal(passRule([...three(), run('toolscript-1.0.5', { correct: false, cold: true })]).pass, false)
    // A cold run is left out of the token limits.
    assert.equal(passRule([...three(), run('toolscript', { cold: true, cacheRead: 1e9 })]).pass, true)
    assert.equal(passRule([...three(), { arm: 'toolscript', error: 'x', costUsd: 0 }]).pass, true)
    assert.equal(passRule([...three(), run('codemode', { correct: false, freshInput: 1e9 })]).pass, true)
    const text = passRule(three()).lines.join('\n')
    assert.match(
      text,
      /PASS toolscript-legacy against toolscript-1\.0\.5: total input tokens, median over 1 tasks of the per-task ratio of medians 0\.00 % \(limit \+2 %\)/,
    )
    assert.match(text, /PASS toolscript against toolscript-legacy: failed run_code calls 0 against 0/)
  })

  test('the release verdict needs all three arms with warm runs: no verdict, and a line that names the missing arm', () => {
    const errored = [
      ...three().filter(r => r.arm !== 'toolscript'),
      ...[1, 2, 3].map(() => ({ arm: 'toolscript', task: 't1', error: 'screen', costUsd: 0.1 })),
    ]
    let rule = passRule(errored)
    assert.equal(rule.pass, undefined)
    assert.match(rule.lines.join('\n'), /- NO VERDICT: toolscript has no warm run \(0 finished, 0 cold, 3 errored\)/)
    const coldOnly = [
      ...three().filter(r => r.arm !== 'toolscript'),
      ...[1, 2, 3].map(() => run('toolscript', { cold: true })),
    ]
    rule = passRule(coldOnly)
    assert.equal(rule.pass, undefined)
    assert.match(rule.lines.join('\n'), /- NO VERDICT: toolscript has no warm run \(3 finished, 3 cold, 0 errored\)/)
    // Its cold runs were still counted for correctness, so a wrong one is a FAIL and not a silent drop.
    assert.equal(passRule([...coldOnly, run('toolscript', { cold: true, correct: false })]).pass, false)
    // A missing base arm too, and a limit that already failed stays a failure.
    assert.equal(passRule(three().filter(r => r.arm !== 'toolscript-1.0.5')).pass, undefined)
    assert.equal(passRule([...errored, run('toolscript-legacy', { correct: false })]).pass, false)
  })

  test('the limits are judged task by task: the median over tasks of the ratio of medians', () => {
    // Task `big` is 10 times the size of task `small`. One median over all runs would follow `big` alone.
    const rowsOf = (arm: string, task: string, scale: number, n = 3) =>
      Array.from({ length: n }, () =>
        run(arm, {
          task,
          cacheRead: 9000 * scale,
          freshInput: 100 * scale,
          cacheWrite: 900 * scale,
          firstCallInput: 5000,
        }),
      )
    const build = (legacySmall: number, legacyBig: number) => [
      ...rowsOf('toolscript-1.0.5', 'small', 1),
      ...rowsOf('toolscript-1.0.5', 'big', 10),
      ...rowsOf('toolscript-legacy', 'small', legacySmall),
      ...rowsOf('toolscript-legacy', 'big', legacyBig),
      ...rowsOf('toolscript', 'small', legacySmall),
      ...rowsOf('toolscript', 'big', legacyBig),
    ]
    assert.equal(passRule(build(1, 10)).pass, true)
    // Two tasks: the median of two ratios is their mean, so +3 % on one task and 0 % on the other is +1.5 %, and +5 % is +2.5 %.
    assert.equal(passRule(build(1.03, 10)).pass, true)
    assert.equal(passRule(build(1.05, 10)).pass, false)
    assert.match(
      passRule(build(1.05, 10)).lines.join('\n'),
      /FAIL toolscript-legacy against toolscript-1\.0\.5: total input tokens, median over 2 tasks/,
    )
    // A task that only one arm has warm runs for is left out of that pair's ratio.
    const lone = [...build(1, 10), ...rowsOf('toolscript-legacy', 'extra', 1000)]
    assert.equal(passRule(lone).pass, true)
  })

  test('an older results folder, where no toolscript row names its build, has no verdict and no lines', () => {
    const old = (arm: string) => ({ ...run(arm), version: undefined })
    assert.deepEqual(passRule([old('toolscript'), old('direct')]), { lines: [], pass: undefined })
    assert.deepEqual(passRule([old('toolscript'), old('toolscript-lean')]), { lines: [], pass: undefined })
    assert.deepEqual(passRule([]), { lines: [], pass: undefined })
  })
})
