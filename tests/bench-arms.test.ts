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
  buildFields,
  buildLines,
  buildOfArm,
  envOfArm,
  firstMethodOf,
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
      variables: { TOOLSCRIPT_PROTOCOL: 'legacy' },
      firstMethod: 'initialize',
    })
    assert.deepEqual(buildFields('toolscript-1.0.5', builds, undefined), {
      version: '1.0.5',
      mainSha256: sha('base main'),
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
        `- toolscript-1.0.5: version 1.0.5, main.js SHA-256 ${sha('base main')}, variables none, first method sent initialize`,
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
        builds: {},
      },
    )
    // The head defaults to the repo.
    assert.equal(
      resolveBuilds({ armIds: ['toolscript'], head: undefined, base: undefined, repo: good }).builds.head?.dir,
      good,
    )
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
      /toolscript-1\.0\.5: build .*dry-base, version 1\.0\.5, main\.js SHA-256 [0-9a-f]{64}, variables none/,
    )
    assert.ok(r.stdout.includes(sha('dry base')) && r.stdout.includes(sha('dry head')))
    assert.match(r.stdout, /toolscript-legacy: .*version 1\.1\.0, .*variables TOOLSCRIPT_PROTOCOL=legacy/)
    assert.match(r.stdout, /tasks: logs, ticket/)
    assert.match(r.stdout, /runs to do: 12/)
    // The order: arms alternate inside a task, and flip every rep.
    const order = [...r.stdout.matchAll(/^\s*\d+\. (\S+)$/gm)].map(m => m[1])
    assert.deepEqual(order.slice(0, 3), ['logs-toolscript-1.0.5-1', 'logs-toolscript-legacy-1', 'logs-toolscript-1'])
    assert.deepEqual(order.slice(6, 9), ['logs-toolscript-2', 'logs-toolscript-legacy-2', 'logs-toolscript-1.0.5-2'])
    assert.match(r.stdout, /spent so far \$0\.0000, cap \$0\.5/)
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
    const jobs = jobsOf({ tasks: [{ id: 't1' }, { id: 't2' }], armIds: ['a', 'b'], reps: 2 })
    assert.deepEqual(
      jobs.map((j: { task: { id: string }; arm: string; rep: number }) => `${j.task.id}-${j.arm}-${j.rep}`),
      ['t1-a-1', 't1-b-1', 't2-a-1', 't2-b-1', 't1-b-2', 't1-a-2', 't2-b-2', 't2-a-2'],
    )
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

  test('a wrong answer in a toolscript arm fails it, a cold run and an error row are left out, codemode is not judged', () => {
    assert.equal(passRule([...three(), run('toolscript', { correct: false })]).pass, false)
    assert.equal(passRule([...three(), run('toolscript', { correct: false, cold: true })]).pass, true)
    assert.equal(passRule([...three(), { arm: 'toolscript', error: 'x', costUsd: 0 }]).pass, true)
    assert.equal(passRule([...three(), run('codemode', { correct: false, freshInput: 1e9 })]).pass, true)
    const text = passRule(three()).lines.join('\n')
    assert.match(
      text,
      /PASS toolscript-legacy against toolscript-1\.0\.5: median total input tokens 10000 against 10000 \(0\.00 %, limit \+2 %\)/,
    )
    assert.match(text, /PASS toolscript against toolscript-legacy: failed run_code calls 0 against 0/)
  })

  test('with fewer than two of the three arms there is no verdict and no lines (an older results folder)', () => {
    assert.deepEqual(passRule([run('toolscript'), run('direct')]), { lines: [], pass: undefined })
    assert.deepEqual(passRule([]), { lines: [], pass: undefined })
  })
})
