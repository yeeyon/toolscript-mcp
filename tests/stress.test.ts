import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  anyFailed,
  cell,
  checkedBytes,
  decode,
  hostBytes,
  judge,
  measuresMemory,
  median,
  newestTag,
  parseJunit,
  planOf,
  planOutputs,
  profileOf,
  renderBaseline,
  renderSummary,
  runProfile,
  runTarget,
  SYSTEMS,
  summarize,
} from '../scripts/stress.mjs'
import { readTable } from '../bench/memory.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stress-test-')))
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

const file = (name: string, text: string) => {
  const target = path.join(dir, name)
  fs.writeFileSync(target, text)
  return target
}
const PASS = file('pass.test.mjs', "import { test } from 'node:test'\ntest('ok', () => {})\n")
// Fails in the third repeat only, as a test with a seed does.
const FLAKY = file(
  'flaky.test.mjs',
  "import { describe, test } from 'node:test'\ndescribe('group', () => {\n  test('sometimes', () => { if (process.env.STRESS_RUN === '3') throw new Error('boom ' + process.env.STRESS_SEED) })\n  test('always fine', () => {})\n})\n",
)
const HANG = file(
  'hang.test.mjs',
  "import { test } from 'node:test'\ntest('hangs', async () => { await new Promise(r => setTimeout(r, 30000)) })\n",
)
const SCRIPT_OK = file('script-ok.mjs', "console.log('fine', process.env.STRESS_RUN)\n")
const SCRIPT_BAD = file(
  'script-bad.mjs',
  "console.error('bad run ' + process.env.STRESS_RUN)\nprocess.exit(process.env.STRESS_RUN === '2' ? 1 : 0)\n",
)

const XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites>',
  '\t<testsuite name="suite &amp;quot;A&amp;quot; &amp; &lt;b>" time="0.1" tests="3">',
  '\t\t<testcase name="passes" time="0.001" classname="test"/>',
  '\t\t<testcase name="fails &amp; &lt;x> a &gt; b" time="0.002" classname="test" failure="short">',
  '\t\t\t<failure type="testCodeFailure" message="short">',
  'Error: a &lt;b> &amp; c',
  'line 2',
  '\t\t\t</failure>',
  '\t\t</testcase>',
  '\t\t<testcase name="skipped" time="0.0" classname="test">',
  '\t\t\t<skipped type="skipped" message="why"/>',
  '\t\t</testcase>',
  '\t\t<testsuite name="inner">',
  '\t\t\t<testcase name="deep" time="0.0" classname="test"/>',
  '\t\t</testsuite>',
  '\t</testsuite>',
  '\t<testcase name="top" time="0.0" classname="test" failure="line1line2 > x">',
  '\t\t<failure type="testCodeFailure" message="line1line2 > x">oops</failure>',
  '\t</testcase>',
  '\t<!-- tests 5 -->',
  '</testsuites>',
].join('\n')

describe('the junit file', () => {
  test('each test case with its suites, its failure and its skip', () => {
    const got = parseJunit(XML)
    assert.deepEqual(
      got.map(r => [r.name, r.failed, r.skipped]),
      [
        ['suite &quot;A&quot; & <b> > passes', false, false],
        ['suite &quot;A&quot; & <b> > fails & <x> a > b', true, false],
        ['suite &quot;A&quot; & <b> > skipped', false, true],
        ['suite &quot;A&quot; & <b> > inner > deep', false, false],
        ['top', true, false],
      ],
    )
    assert.equal(got[1]!.detail, 'Error: a <b> & c\nline 2')
    assert.equal(got[4]!.detail, 'oops')
  })

  test('a file with no test case, or text that is no XML, gives none', () => {
    assert.deepEqual(parseJunit(''), [])
    assert.deepEqual(parseJunit('<testsuites>\n</testsuites>'), [])
    assert.deepEqual(parseJunit('not xml <testcase name="x" failure'), [])
  })

  test('the entities decode one level, and a bad number stays as it is', () => {
    assert.equal(
      decode('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp; &#65; &#x42; &#99999999999;'),
      '<a> "b" \'c\' & A B &#99999999999;',
    )
  })

  test('real node:test output of this Node parses', () => {
    const out = path.join(dir, 'real.xml')
    spawnSync(
      process.execPath,
      ['--test-reporter=junit', '--test-reporter-destination=' + out, '--test', FLAKY.replaceAll('\\', '/')],
      {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, STRESS_RUN: '3', STRESS_SEED: '9' },
        windowsHide: true,
      },
    )
    const got = parseJunit(fs.readFileSync(out, 'utf8'))
    assert.deepEqual(
      got.map(r => [r.name, r.failed]),
      [
        ['group > sometimes', true],
        ['group > always fine', false],
      ],
    )
    assert.match(got[0]!.detail, /boom 9/)
  })
})

describe('the summary', () => {
  const run = (n: number, ...tests: [string, boolean][]) => ({
    run: n,
    seed: 100 + n,
    ms: 1,
    results: tests.map(([name, failed]) => ({ name, failed, skipped: false, detail: failed ? 'why ' + n : '' })),
  })

  test('one row for each test that failed: runs, fails, rate, and the first failure with its seed', () => {
    const runs = [
      run(1, ['a', false], ['b', false]),
      run(2, ['a', true], ['b', false]),
      run(3, ['a', false], ['b', true]),
      run(4, ['a', true], ['b', false], ['c', false]),
    ]
    const rows = summarize(runs)
    assert.deepEqual(
      rows.map(r => [r.name, r.runs, r.fails, r.rate, r.first.run, r.first.seed, r.first.lines]),
      [
        ['a', 4, 2, 0.5, 2, 102, 'why 2'],
        ['b', 4, 1, 0.25, 3, 103, 'why 3'],
      ],
    )
    assert.deepEqual(summarize([run(1, ['a', false])]), [])
  })

  test('a skipped test counts as no run', () => {
    const rows = summarize([
      { run: 1, seed: 1, ms: 1, results: [{ name: 'a', failed: false, skipped: true, detail: '' }] },
    ])
    assert.deepEqual(rows, [])
  })

  test('the markdown has the table and the closing line', () => {
    const result = {
      label: 'tests/x.test.ts',
      planned: 4,
      runs: [run(1, ['a|b', true]), run(2, ['a|b', false])],
      ms: 90_000,
      note: 'a note',
    }
    const text = renderSummary('stress: test', [result])
    assert.match(text, /^### stress: test$/m)
    assert.match(text, /- tests\/x\.test\.ts: 2 of 4 runs, 1 failed, 1\.5 min, a note/)
    assert.match(text, /\| a\\\|b \| 2 \| 1 \| 50% \| 1, 101 \|/)
    assert.match(text, /1 targets, 2 runs, 1 failed runs, 1\.5 min\./)
    const clean = renderSummary('t', [{ label: 'y', planned: 1, runs: [run(1, ['a', false])], ms: 0 }])
    assert.ok(!clean.includes('| test |'))
  })
})

describe('runTarget', () => {
  test('a flaky test fails in run 3 only: rate, first failure, seed and the files of that run', async () => {
    const out = path.join(dir, 'out-flaky')
    const result = await runTarget({ target: FLAKY, cwd: dir, count: 5, label: 'flaky' }, { out, seedBase: 100 })
    assert.equal(result.runs.length, 5)
    const [row, ...more] = summarize(result.runs)
    assert.deepEqual(more, [])
    assert.deepEqual(
      [row!.name, row!.runs, row!.fails, row!.first.run, row!.first.seed],
      ['group > sometimes', 5, 1, 3, 103],
    )
    assert.match(row!.first.lines, /boom 103/)
    assert.ok(anyFailed([result]))
    const kept = path.join(out, 'flaky', 'run-3')
    assert.ok(fs.existsSync(path.join(kept, 'junit.xml')))
    assert.ok(fs.existsSync(path.join(kept, 'stdout.txt')))
    assert.ok(fs.existsSync(path.join(kept, 'stderr.txt')))
    assert.ok(!fs.existsSync(path.join(out, 'flaky', 'run-1')), 'a passed repeat leaves nothing')
  })

  test('a passing target has no row and no file', async () => {
    const out = path.join(dir, 'out-pass')
    const result = await runTarget({ target: PASS, cwd: dir, count: 2, label: 'pass' }, { out })
    assert.deepEqual(summarize(result.runs), [])
    assert.ok(!anyFailed([result]))
    assert.deepEqual(fs.readdirSync(path.join(out, 'pass')), [])
  })

  test('a test that hangs is ended at the limit and is the failed test "(process)"', async () => {
    const start = Date.now()
    const result = await runTarget(
      { target: HANG, cwd: dir, count: 1, timeout: 1, label: 'hang' },
      { out: path.join(dir, 'out-hang') },
    )
    assert.ok(Date.now() - start < 20_000, 'the limit did not end the run')
    const [row] = summarize(result.runs)
    assert.equal(row!.name, '(process) hang')
    assert.match(row!.first.lines, /no end in 1 s/)
  })

  test('a target that does not exist fails as a file, never as a pass', async () => {
    const result = await runTarget(
      { target: 'missing.test.mjs', cwd: dir, count: 1, label: 'missing' },
      { out: path.join(dir, 'out-missing') },
    )
    assert.ok(anyFailed([result]))
  })

  test('the box stops the repeats and says so', async () => {
    const result = await runTarget(
      { target: PASS, cwd: dir, count: 50, box: 0.0005, label: 'box' },
      { out: path.join(dir, 'out-box') },
    )
    assert.equal(result.stopped, 'box')
    assert.ok(result.runs.length >= 1 && result.runs.length < 50)
    assert.match(renderSummary('t', [result]), /stopped at the box of 0\.0005 min/)
  })

  test('the deadline of the run drops the repeat that it cuts, and stops the repeats after it', async () => {
    const out = path.join(dir, 'out-deadline')
    const cut = await runTarget(
      { target: HANG, cwd: dir, count: 3, label: 'hang' },
      { out, deadline: performance.now() + 1500 },
    )
    assert.equal(cut.stopped, 'deadline')
    assert.equal(cut.runs.length, 0)
    assert.ok(!anyFailed([cut]))
    const some = await runTarget(
      { target: PASS, cwd: dir, count: 500, label: 'pass' },
      { out, deadline: performance.now() + 4000 },
    )
    assert.equal(some.stopped, 'deadline')
    assert.ok(some.runs.length >= 1 && some.runs.length < 500)
    assert.ok(!anyFailed([some]))
    assert.match(renderSummary('t', [some]), /stopped at the deadline of the run/)
  })

  test('a script passes on exit code 0, and its output is kept for each repeat', async () => {
    const out = path.join(dir, 'out-script')
    const ok = await runTarget({ target: SCRIPT_OK, cwd: dir, kind: 'script', count: 2, label: 'ok' }, { out })
    assert.ok(!anyFailed([ok]))
    assert.equal(fs.readFileSync(path.join(out, 'ok', 'run-2', 'stdout.txt'), 'utf8').trim(), 'fine 2')
    const bad = await runTarget({ target: SCRIPT_BAD, cwd: dir, kind: 'script', count: 3, label: 'bad' }, { out })
    const [row] = summarize(bad.runs)
    assert.deepEqual([row!.name, row!.runs, row!.fails, row!.first.run], ['bad', 3, 1, 2])
    assert.match(row!.first.lines, /bad run 2/)
  })
})

describe('the table cell', () => {
  test('a backslash, a pipe and a line end stay inside one cell', () => {
    assert.equal(cell('a\\|b'), 'a\\\\\\|b')
    assert.equal(cell('end\\'), 'end\\\\')
    assert.equal(cell('a|b\r\nc'), 'a\\|b c')
    // Read back as markdown, the escapes give the text again: no pipe is left bare.
    for (const text of ['a\\|b', 'end\\', 'x||y', '\\\\|']) assert.ok(!/(?<!\\)(?:\\\\)*\|/.test(cell(text)), text)
  })
})

describe('the profiles', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'stress.json'), 'utf8'))

  test('tests/stress.json: each profile has entries that name a target and a count, and the files exist', () => {
    assert.deepEqual(Object.keys(config).sort(), ['bench', 'cpu1', 'flakes', 'load'])
    for (const name of Object.keys(config))
      for (const e of profileOf(config, name)) {
        assert.ok(typeof e.target === 'string' && e.count >= 1, name + ' ' + e.target)
        if (!e.optional && !/[*{]/.test(e.target)) assert.ok(fs.existsSync(path.join(REPO, e.target)), e.target)
        if (e.box !== undefined) assert.ok(e.box > 0)
      }
    // The #133 target is optional until bench/broker-race.mjs is on main.
    assert.ok(config.cpu1.find((e: { target: string }) => e.target === 'bench/broker-race.mjs').optional)
  })

  test('the boxes of each profile fit the deadline of the workflow with 5 minutes to spare', () => {
    const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'stress.yml'), 'utf8')
    const deadlines = [...yml.matchAll(/--deadline (\d+)/g)].map(m => Number(m[1]))
    assert.ok(deadlines.length >= 5)
    const profileDeadline = Math.min(...deadlines.filter(d => d >= 45))
    assert.equal(profileDeadline, 45, 'the profile steps use --deadline 45')
    for (const name of Object.keys(config)) {
      const minutes = profileOf(config, name).reduce((n, e) => n + (e.box ?? (e.timeout ?? 600) / 60), 0)
      assert.ok(minutes <= profileDeadline - 5, name + ' needs ' + minutes + ' min')
    }
    assert.ok(deadlines.includes(40), 'the baseline has its own deadline')
  })

  test('a profile that is missing or has a bad entry is refused', () => {
    assert.throws(() => profileOf(config, 'nope'), /no profile nope/)
    assert.throws(() => profileOf({ x: [{ target: 'a' }] }, 'x'), /a bad entry/)
    assert.throws(() => profileOf(null, 'x'))
  })

  test('an optional target that is not there is skipped with a line, and another missing target fails', async () => {
    const results = await runProfile(
      [
        { target: 'bench/not-there.mjs', optional: true, count: 1, cwd: dir, note: 'x' },
        { target: 'tests/also-missing.test.mjs', count: 1, cwd: dir },
      ],
      { out: path.join(dir, 'out-profile') },
    )
    assert.match(results[0]!.note, /^skipped: bench\/not-there\.mjs is not in this checkout$/)
    assert.equal(results[0]!.runs.length, 0)
    assert.ok(!anyFailed([results[0]!]))
    assert.ok(anyFailed([results[1]!]))
    assert.match(renderSummary('t', results), /skipped: bench\/not-there\.mjs is not in this checkout/)
  })

  test('a target that the deadline kept from running fails, and each result is handed on when its target ends', async () => {
    const seen: string[] = []
    const results = await runProfile(
      [
        { target: path.basename(PASS), cwd: dir, count: 1, label: 'late' },
        { target: 'tests/also-missing.test.mjs', optional: true, count: 1, cwd: dir, label: 'optional' },
      ],
      { out: path.join(dir, 'out-late'), deadline: performance.now() - 1, onResult: r => seen.push(r.label) },
    )
    assert.deepEqual(seen, ['late', 'optional'])
    assert.ok(anyFailed([results[0]!]))
    assert.match(
      renderSummary('t', [results[0]!]),
      /not run: the deadline of the run passed before this target started/,
    )
    assert.ok(!anyFailed([results[1]!]))
  })

  test('the command line: a filter that matches no target is an error, not a green run', () => {
    const r = spawnSync(
      process.execPath,
      [
        path.join(REPO, 'scripts', 'stress.mjs'),
        'profile',
        'flakes',
        '--only',
        'no-such-target',
        '--out',
        path.join(dir, 'o'),
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    assert.equal(r.status, 2)
    assert.match(r.stderr, /matches no target/)
  })

  test('the command line: exit code 1 and the table for a flake, 0 for a pass, and the step summary is written', () => {
    const run = (target: string, count: number, env: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        process.execPath,
        [
          path.join(REPO, 'scripts', 'stress.mjs'),
          'run',
          '--target',
          target,
          '--count',
          String(count),
          '--out',
          path.join(dir, 'out-cli'),
        ],
        {
          cwd: dir,
          env: { ...process.env, ...env },
          encoding: 'utf8',
          windowsHide: true,
        },
      )
    const summary = path.join(dir, 'step-summary.md')
    const bad = run(FLAKY, 4, { GITHUB_STEP_SUMMARY: summary })
    assert.equal(bad.status, 1, bad.stderr)
    assert.match(bad.stdout, /\| group > sometimes \| 4 \| 1 \| 25% \| 3, 3 \|/)
    assert.equal(fs.readFileSync(summary, 'utf8').trim(), bad.stdout.trim())
    assert.equal(run(PASS, 2).status, 0)
    assert.equal(
      spawnSync(process.execPath, [path.join(REPO, 'scripts', 'stress.mjs')], { encoding: 'utf8', windowsHide: true })
        .status,
      2,
    )
  })
})

const sessions = (n: number) => Array.from({ length: n }, () => ({ ok: true, failed: [], connected: ['bench1'] }))
const data = (idle: object, round: object = {}) => ({
  rounds: [
    { count: 1, sessions: sessions(1), samples: { idle: { privateBytes: 1 } } },
    { count: 6, sessions: sessions(6), samples: { idle }, ...round },
  ],
})

describe('the baseline budgets', () => {
  const same = {
    startMs: 400,
    hostMb: 80,
    sharedSavingMb: 20,
    listBytes: 3000,
    instructionBytes: 1500,
    searchBytes: 800,
    packBytes: 200_000,
    mainBytes: 1_400_000,
  }
  const verdict = (head: Partial<typeof same>, start: string) =>
    judge(same, { ...same, ...head }).find(r => r.metric.startsWith(start))!.ok

  test('the same build passes every row', () => {
    assert.ok(judge(same, same).every(r => r.ok))
  })

  test('each budget fails just over its limit and passes at it', () => {
    assert.equal(judge(same, { ...same, startMs: 400 + 50 }).find(r => r.metric.startsWith('start'))!.ok, true)
    assert.equal(judge(same, { ...same, startMs: 400 + 50.5 }).find(r => r.metric.startsWith('start'))!.ok, false)
    // On a slow start the 10% counts: 1000 ms allows 1100.
    assert.equal(
      judge({ ...same, startMs: 1000 }, { ...same, startMs: 1100 }).find(r => r.metric.startsWith('start'))!.ok,
      true,
    )
    assert.equal(
      judge({ ...same, startMs: 1000 }, { ...same, startMs: 1101 }).find(r => r.metric.startsWith('start'))!.ok,
      false,
    )
    assert.equal(judge(same, { ...same, hostMb: 90 }).find(r => r.metric.startsWith('host memory'))!.ok, true)
    assert.equal(judge(same, { ...same, hostMb: 90.1 }).find(r => r.metric.startsWith('host memory'))!.ok, false)
    assert.equal(judge(same, { ...same, sharedSavingMb: 10 }).find(r => r.metric.startsWith('sharing'))!.ok, false)
    for (const key of ['listBytes', 'instructionBytes', 'searchBytes'] as const) {
      assert.equal(
        judge(same, { ...same, [key]: same[key] }).every(r => r.ok),
        true,
      )
      assert.equal(judge(same, { ...same, [key]: same[key] + 1 }).filter(r => !r.ok).length, 1, key)
      assert.equal(
        judge(same, { ...same, [key]: same[key] - 100 }).every(r => r.ok),
        true,
        'smaller is fine',
      )
    }
    assert.equal(verdict({ packBytes: 250_000 }, 'npm pack'), true)
    assert.equal(verdict({ packBytes: 250_001 }, 'npm pack'), false)
    assert.equal(verdict({ mainBytes: 1_750_001 }, 'dist/host'), false)
  })

  test('each system of the baseline plan can produce every row that it judges', async () => {
    const platform = { 'ubuntu-latest': 'linux', 'macos-latest': 'darwin', 'windows-latest': 'win32' } as const
    for (const runner of SYSTEMS) {
      const rows = judge(same, same, { memory: measuresMemory(platform[runner]) })
      assert.ok(
        rows.every(r => r.ok),
        runner,
      )
      assert.equal(rows.filter(r => 'skipped' in r).length, runner === 'macos-latest' ? 2 : 0, runner)
    }
    // The premise, checked on the system that runs this test: where a number is judged, memory.mjs reads one.
    const own = (await readTable()).find((p: { pid: number }) => p.pid === process.pid)
    assert.ok(own, 'the process table has this process')
    const number = typeof own.pb === 'number' || typeof own.ws === 'number'
    assert.equal(number, measuresMemory(process.platform))
  })

  test('the host memory comes from private bytes, or from the private memory of Linux', () => {
    assert.equal(hostBytes(data({ privateBytes: 600, workingSetPrivate: 5 })), 600)
    assert.equal(hostBytes(data({ privateBytes: null, workingSetPrivate: 480 })), 480)
    assert.equal(hostBytes(data({ privateBytes: null, workingSetPrivate: null })), null)
    assert.equal(hostBytes({}), null)
  })

  test('a round that is not 6 healthy sessions gives no host memory, so its row fails', () => {
    const idle = { privateBytes: 600 }
    assert.equal(hostBytes(data(idle, { sessions: sessions(5) })), null, 'fewer than 6 sessions')
    assert.equal(hostBytes(data(idle, { stoppedAt: 4 })), null, 'the bench stopped on free RAM')
    for (const bad of [
      { ok: false, error: 'exited' },
      { failed: ['bench2'] },
      { connectTimeout: true },
      { failed: undefined },
    ]) {
      const list = sessions(6)
      list[3] = { ...list[3], ...bad }
      assert.equal(hostBytes(data(idle, { sessions: list })), null, JSON.stringify(bad))
    }
    const rows = judge({ ...same, hostMb: 80 }, { ...same, hostMb: hostBytes(data(idle, { sessions: sessions(5) })) })
    assert.equal(rows.find(r => r.metric.startsWith('host memory'))!.ok, false)
  })

  test('a search or list reply that is an error, an isError result or empty gives no bytes, so its row fails', () => {
    const init = { result: { instructions: 'use run_code' } }
    const list = { result: { tools: [{ name: 'run_code' }] } }
    const search = { result: { content: [{ type: 'text', text: 'tools' }] } }
    const good = checkedBytes(init, list, search)
    assert.ok(good.instructionBytes! > 0 && good.listBytes! > 0 && good.searchBytes! > 0)
    const rpcError = { error: { code: -32603, message: 'boom' } }
    assert.equal(checkedBytes(init, list, rpcError).searchBytes, null)
    assert.equal(
      checkedBytes(init, list, { result: { isError: true, content: [{ type: 'text', text: 'failed' }] } }).searchBytes,
      null,
    )
    assert.equal(checkedBytes(init, list, { result: { content: [] } }).searchBytes, null)
    assert.equal(checkedBytes(init, list, undefined).searchBytes, null)
    assert.equal(checkedBytes(rpcError, list, search).instructionBytes, null)
    assert.equal(checkedBytes({ result: {} }, list, search).instructionBytes, null)
    assert.equal(checkedBytes(init, { result: { tools: [] } }, search).listBytes, null)
    const row = judge(same, { ...same, searchBytes: checkedBytes(init, list, rpcError).searchBytes }).find(r =>
      r.metric.startsWith('search_tools'),
    )!
    assert.equal(row.ok, false)
    assert.match(renderBaseline([row]), /FAIL \(not measured\)/)
  })

  test('the macOS memory rows are left out with a reason, and a lost number on Linux or Windows fails', () => {
    const lost = { ...same, hostMb: null, sharedSavingMb: null }
    assert.equal(judge(lost, lost, { memory: true }).filter(r => !r.ok).length, 2)
    const rows = judge(lost, lost, { memory: false })
    assert.ok(rows.every(r => r.ok))
    assert.match(renderBaseline(rows), /\| not judged: this system has no private memory number for a process \|/)
  })

  test('a metric that was not measured is n/a and fails: it never passes silently', () => {
    const rows = judge({ ...same, hostMb: null, sharedSavingMb: null }, { ...same, hostMb: 500, sharedSavingMb: null })
    assert.equal(rows.filter(r => !r.ok).length, 2)
    assert.equal(rows.filter(r => r.na).length, 2)
    assert.ok(rows.filter(r => !r.na).every(r => r.ok))
    const text = renderBaseline(rows)
    assert.match(text, /\| host memory MB .* \| n\/a \| 500\.0 \| \+10 MB \| FAIL \(not measured\) \|/)
    assert.match(text, /Tokens and cost need a Claude login/)
  })

  test('the median of a list ignores what is not a number', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 2, 3]), 2.5)
    assert.equal(median([null, undefined, NaN] as never), null)
    assert.equal(median([]), null)
  })
})

describe('the plan of a run', () => {
  const names = (jobs: { name: string }[]) => jobs.map(j => j.name)
  const macs = (plan: ReturnType<typeof planOf>) =>
    [...plan.stress, ...plan.baseline].filter(j => j.os === 'macos-latest').length

  test('each profile has its systems and Node versions, and at most 3 macOS jobs', () => {
    const jobs = (profile: string) => planOf({ event: 'workflow_dispatch', inputs: { profile } })
    assert.equal(jobs('flakes').stress.length, 6)
    assert.deepEqual([...new Set(jobs('flakes').stress.map(j => j.node))].sort(), ['22.13', '24'])
    assert.equal(jobs('load').stress.length, 3)
    assert.equal(jobs('bench').stress.length, 3)
    // cpu1 has no macOS job: macOS cannot limit a job to one CPU.
    assert.deepEqual(names(jobs('cpu1').stress), ['cpu1 ubuntu-latest node 24', 'cpu1 windows-latest node 24'])
    const baseline = jobs('baseline')
    assert.equal(baseline.stress.length, 0)
    assert.equal(baseline.baseline.length, 3)
    for (const profile of ['flakes', 'load', 'cpu1', 'bench', 'baseline']) assert.ok(macs(jobs(profile)) <= 3, profile)
  })

  test('the weekly schedule is flakes and baseline against the newest release tag: 9 jobs, 3 on macOS', () => {
    const plan = planOf({ event: 'schedule', latestTag: 'v1.0.4' })
    assert.equal(plan.stress.length + plan.baseline.length, 9)
    assert.equal(macs(plan), 3)
    assert.equal(plan.base, 'v1.0.4')
    assert.throws(() => planOf({ event: 'schedule' }), /needs a v\* release tag/)
    // An input of a dispatch never reaches a scheduled run.
    assert.equal(planOf({ event: 'schedule', latestTag: 'v1.0.4', inputs: { base: 'dev' } }).base, 'v1.0.4')
  })

  test('the newest tag is the highest stable version, by number', () => {
    assert.equal(newestTag('v1.0.9\nv1.0.10\nv0.12.20\nv1.0.2\n'), 'v1.0.10')
    assert.equal(newestTag('v1.1.0-beta.1\nv1.0.4\nlatest\nv2\n'), 'v1.0.4')
    assert.equal(newestTag(''), undefined)
  })

  test('a push to stress/** runs the profile of the stress.json of the branch, flakes by default', () => {
    assert.ok(planOf({ event: 'push' }).stress.every(j => j.profile === 'flakes'))
    const plan = planOf({
      event: 'push',
      branch: { profile: 'one', target: 'tests/lazy.e2e.mjs', count: 7, os: 'windows-latest', node: '24' },
    })
    assert.deepEqual(
      plan.stress.map(j => [j.name, j.target, j.count]),
      [['one windows-latest node 24', 'tests/lazy.e2e.mjs', '7']],
    )
  })

  test('os and node narrow the jobs, and one takes a target, a pattern and a count', () => {
    const plan = planOf({
      event: 'workflow_dispatch',
      inputs: {
        profile: 'one',
        target: 'tests/lazy.e2e.mjs',
        pattern: '2 s kill',
        count: '200',
        os: 'macos-latest',
        node: '22.13',
        base: 'dev',
      },
    })
    assert.deepEqual(plan.stress, [
      {
        profile: 'one',
        os: 'macos-latest',
        node: '22.13',
        name: 'one macos-latest node 22.13',
        target: 'tests/lazy.e2e.mjs',
        pattern: '2 s kill',
        count: '200',
      },
    ])
    assert.equal(plan.base, 'dev')
    assert.equal(
      planOf({ event: 'workflow_dispatch', inputs: { profile: 'flakes', os: 'ubuntu-latest' } }).stress.length,
      2,
    )
    assert.equal(
      planOf({ event: 'workflow_dispatch', inputs: { profile: 'one', target: 'tests/x.test.ts' } }).stress.length,
      3,
    )
  })

  test('a bad profile, system, Node, target or count is refused', () => {
    const bad = (inputs: Record<string, string>, why: RegExp) =>
      assert.throws(() => planOf({ event: 'workflow_dispatch', inputs }), why)
    bad({ profile: 'nope' }, /no profile nope/)
    bad({ profile: 'flakes', os: 'solaris' }, /os is all or one of/)
    bad({ profile: 'flakes', node: '18' }, /node is default/)
    bad({ profile: 'one' }, /target is a path/)
    bad({ profile: 'one', target: '../etc/passwd' }, /target is a path/)
    bad({ profile: 'one', target: 'tests/x; rm -rf /' }, /target is a path/)
    bad({ profile: 'one', target: '$(id)' }, /target is a path/)
    bad({ profile: 'one', target: 'tests/x.ts', count: '0' }, /count is a whole number/)
    bad({ profile: 'one', target: 'tests/x.ts', count: '99999' }, /count is a whole number/)
    bad({ profile: 'one', target: 'tests/x.ts', count: '1.5' }, /count is a whole number/)
    // The base reaches $GITHUB_OUTPUT: a newline must not forge a line of output.
    for (const base of ['main\nstress={"include":[]}', 'main\r\nx=1', '-x', '../x', 'a b', 'a;b', 'v1\n'])
      bad({ profile: 'baseline', base }, /base is a ref/)
    assert.equal(
      planOf({ event: 'workflow_dispatch', inputs: { profile: 'baseline', base: 'release/v1.0.5' } }).base,
      'release/v1.0.5',
    )
    assert.throws(
      () => planOf({ event: 'push', branch: { profile: 'baseline', base: 'x\nstress=1' } }),
      /base is a ref/,
    )
  })

  test('the outputs are one line each, as $GITHUB_OUTPUT wants, with no newline inside a value', () => {
    const lines = planOutputs(planOf({ event: 'schedule', latestTag: 'v1.0.4' })).split('\n')
    assert.deepEqual(
      lines.map(l => l.split('=')[0]),
      ['stress', 'has_stress', 'baseline', 'has_baseline', 'base'],
    )
    assert.equal(JSON.parse(lines[0]!.slice('stress='.length)).include.length, 6)
    assert.equal(lines[1], 'has_stress=true')
    assert.equal(
      planOutputs(planOf({ event: 'workflow_dispatch', inputs: { profile: 'baseline' } })).split('\n')[1],
      'has_stress=false',
    )
  })
})
