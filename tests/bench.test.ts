// The bench scripts as a user runs them: bench/run.mjs and bench/forget.mjs
// started with node. No case here starts Claude Code.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
