// The bench scripts as a user runs them: bench/run.mjs and bench/forget.mjs
// started with node. No case here starts Claude Code.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL } from '../src/core/tools.ts'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-bench-test-')))
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

const node = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000, ...options })

test('run.mjs refuses an --out that holds the rows of an earlier run', () => {
  const out = path.join(ROOT, 'earlier')
  fs.mkdirSync(out)
  const rows = `${JSON.stringify({ task: 'logs', arm: 'direct', rep: 1 })}\n`
  fs.writeFileSync(path.join(out, 'results.jsonl'), rows)

  // With no PATH, a run.mjs that starts the bench cannot find claude, so this test never spends money.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  const run = node([path.join(REPO, 'bench', 'run.mjs'), '--out', out, '--reps', '1'], { env })

  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stderr, /results\.jsonl/)
  assert.deepEqual(fs.readdirSync(out), ['results.jsonl'])
  assert.equal(fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8'), rows)
})

test('check.mjs judges an answer of another agent with the check of run.mjs', () => {
  const dir = path.join(ROOT, 'check')
  fs.mkdirSync(dir)
  const file = (name: string, text: string) => (fs.writeFileSync(path.join(dir, name), text), path.join(dir, name))
  const log = file('calls.jsonl', `${JSON.stringify({ tool: 'create_ticket', chars: 40 })}\n`)
  const check = (task: string, answer: string, calls?: string) =>
    node([
      path.join(REPO, 'bench', 'check.mjs'),
      '--task',
      task,
      '--answer',
      file(`${task}.txt`, answer),
      ...(calls ? ['--log', calls] : []),
    ])
  const right = check('ticket', 'The key is INC-101.', log)
  assert.equal(right.status, 0, right.stderr)
  assert.equal(JSON.parse(right.stdout).correct, true)
  assert.equal(check('ticket', 'The key is INC-101.').status, 1, 'no create_ticket call is wrong')
  assert.equal(check('logs', 'search had 910').status, 1)
  assert.equal(check('nope', 'x').status, 2)
})

test('interactive.mjs counts the saved runs of a resumed --out toward --max-spend', async () => {
  const { spentSoFar, estimate } = await import('../bench/spend.mjs')
  const saved = [
    { task: 'issues', arm: 'toolscript', costUsd: 2.5 },
    { task: 'issues', arm: 'toolscript', costUsd: 2.4 },
  ]
  assert.equal(spentSoFar(saved, 0.1).toFixed(2), '5.00')
  assert.equal(spentSoFar([], 0.1), 0.1)
  assert.equal(estimate(saved, 'toolscript', 'issues'), 2.5)
  assert.equal(estimate(saved, 'toolscript', 'logs'), 2.5)
  assert.equal(estimate(saved, 'direct', 'issues'), 0.25)
})

// With no PATH, an interactive.mjs that starts a run cannot find claude, and a --pty-dir with no
// node-pty stops it before the first run. So these cases never spend money.
const NO_PATH = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
const interactive = (name: string, args: string[], env: NodeJS.ProcessEnv = NO_PATH) => {
  const dir = path.join(ROOT, name)
  const flags = ['--root', path.join(dir, 'root'), '--out', path.join(dir, 'out'), '--tasks', 'ticket']
  return node([path.join(REPO, 'bench', 'interactive.mjs'), ...flags, '--arms', 'direct', '--reps', '1', ...args], {
    env,
  })
}

test('interactive.mjs refuses a spend that is not a number of dollars, and a model with no price', () => {
  const noPty = ['--pty-dir', path.join(ROOT, 'no-pty')]
  const refused = [
    ['--max-spend', 'abc'],
    ['--max-spend=-1'],
    ['--spent', 'x'],
    ['--spent', 'Infinity'],
    ['--model', 'some-model'],
  ]
  for (const [i, args] of refused.entries()) {
    const run = interactive(`refused-${i}`, [...args, ...noPty])
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`)
    assert.match(run.stderr, /usage:/)
    assert.match(run.stderr, args[0]!.startsWith('--model') ? /no price for model some-model/ : /--max-spend|--spent/)
    assert.equal(fs.existsSync(path.join(ROOT, `refused-${i}`)), false, 'a refused start made a folder')
  }
})

// A pseudo-terminal whose claude spends $1 on input tokens and exits at once.
const FAKE_PTY = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
exports.spawn = (file, args, { cwd }) => {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const message = { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 500000 } }
  fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({ type: 'assistant', message }) + '\\n')
  let onExit
  setImmediate(() => onExit?.({ exitCode: 1 }))
  return { onData() {}, onExit: f => (onExit = f), write() {}, kill() {} }
}`
const FAKE_TERMINAL = `exports.Terminal = class { buffer = { active: { length: 0 } }; write() {} }`

test('interactive.mjs saves the cost of a run that fails, and a resumed --out counts it', () => {
  const pty = path.join(ROOT, 'fake-pty')
  for (const [name, source] of [
    ['node-pty', FAKE_PTY],
    ['@xterm/headless', FAKE_TERMINAL],
  ] as const) {
    fs.mkdirSync(path.join(pty, 'node_modules', name), { recursive: true })
    fs.writeFileSync(path.join(pty, 'node_modules', name, 'index.js'), source)
  }
  const home = path.join(ROOT, 'fake-home')
  const env = { ...NO_PATH, HOME: home, USERPROFILE: home }
  const args = ['--pty-dir', pty, '--bash', process.execPath]
  const results = path.join(ROOT, 'failed-run', 'out', 'results.jsonl')

  const failed = interactive('failed-run', [...args, '--max-spend', '5'], env)
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  const rows = fs
    .readFileSync(results, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { ...rows[0], error: undefined },
    {
      task: 'ticket',
      arm: 'direct',
      rep: 1,
      correct: false,
      costUsd: 1,
      error: undefined,
    },
  )
  assert.match(rows[0].error, /claude exited/)

  const resumed = interactive('failed-run', [...args, '--max-spend', '1.5'], env)
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  assert.match(resumed.stdout, /1 runs to do .*; spent so far \$1\.0000, cap \$1\.5/)
  assert.match(resumed.stdout, /stop: \$1\.0000 spent/)
  assert.equal(fs.readFileSync(results, 'utf8').trim().split('\n').length, 1)
})

test('run.mjs answers --help and an unknown flag with the usage, and starts no run', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  const out = path.join(ROOT, 'help')
  const help = node([path.join(REPO, 'bench', 'run.mjs'), '--help', '--out', out], { env })
  assert.equal(help.status, 0, help.stdout + help.stderr)
  assert.match(help.stdout, /^usage: node bench\/run\.mjs/)
  const typo = node([path.join(REPO, 'bench', 'run.mjs'), '--rep', '1', '--out', out], { env })
  assert.equal(typo.status, 2, typo.stdout + typo.stderr)
  assert.match(typo.stderr, /--rep/)
  assert.match(typo.stderr, /usage:/)
  assert.equal(fs.existsSync(out), false, 'a refused start made the out dir')
})

// npm ci builds dist/host/main.js, which the probe of the toolscript arms starts.
test('run.mjs --dry-run lists the direct tools and toolscript-mcp together in the arm both, and starts no run', () => {
  const out = path.join(ROOT, 'dry')
  const run = node([path.join(REPO, 'bench', 'run.mjs'), '--dry-run', '--arms', 'both', '--out', out], { env: NO_PATH })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const allows = run.stdout.match(/^both allows: (.*)$/m)?.[1]?.split(',') ?? []
  assert.ok(allows.includes('mcp__bench__query_logs'), run.stdout)
  assert.ok(allows.includes(TOOL.run_code), run.stdout)
  const defs = JSON.parse(fs.readFileSync(path.join(out, 'definitions.json'), 'utf8'))
  assert.ok(defs.both.instructionChars > 0, 'toolscript-mcp sent no instructions')
  assert.deepEqual(fs.readdirSync(out).sort(), ['definitions.json', 'probe'])
})

test('run.mjs --report counts the runs of the arm both that picked run_code or the direct tools', () => {
  const out = path.join(ROOT, 'picks')
  const runs = [
    { rep: 1, tools: [TOOL.search_tools, TOOL.run_code] },
    { rep: 2, tools: ['mcp__bench__query_logs', 'mcp__bench__query_logs'] },
    { rep: 3, tools: ['mcp__bench__query_logs', TOOL.run_code] },
  ]
  for (const { rep, tools } of runs) {
    const dir = path.join(out, `logs-both-${rep}`)
    fs.mkdirSync(dir, { recursive: true })
    const content = tools.map((name, i) => ({ type: 'tool_use', id: `t${i}`, name, input: {} }))
    const events = [
      { type: 'assistant', message: { id: 'm1', content, usage: { input_tokens: 100 } } },
      { type: 'result', result: 'no answer', usage: { input_tokens: 100 }, total_cost_usd: 0.01, num_turns: 2 },
    ]
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))
  }
  const rows = runs.map(({ rep }) => JSON.stringify({ task: 'logs', arm: 'both', rep, seconds: 1 }))
  fs.writeFileSync(path.join(out, 'results.jsonl'), `${rows.join('\n')}\n`)

  const run = node([path.join(REPO, 'bench', 'run.mjs'), '--report', out], { env: NO_PATH })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /^\| logs \| 2\/3 \| 2\/3 \| 2 \| 3 \|$/m)
  assert.match(run.stdout, /^\| all \| 2\/3 \| 2\/3 \| 2 \| 3 \|$/m)
})

test('forget.mjs removes the project folder of a run when given a relative out dir', () => {
  const home = path.join(ROOT, 'home')
  const work = path.join(ROOT, 'work')
  const cwd = path.join(work, 'out', 'logs-direct-1', 'cwd')
  fs.mkdirSync(cwd, { recursive: true })
  const project = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(project, { recursive: true })

  const run = node([path.join(REPO, 'bench', 'forget.mjs'), 'out'], {
    cwd: work,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })

  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(fs.existsSync(project), false)
  assert.match(run.stdout, /removed /)
})
