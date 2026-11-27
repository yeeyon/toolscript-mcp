// Test of bench/memory.mjs in fixture mode, on Linux, macOS and Windows: the smoke run (2 rounds, 4 stdio servers
// each), the same with sharing on, the secrets rule, the bad --json path, the hard kill of the bench and the hard kill of the hosts while the lazy servers are awake (sharing off and on). It asserts no memory threshold. Run
// `npm run build` first.
//
//   node tests/memory.e2e.mjs

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MARKER, readTable } from '../bench/memory.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BENCH = path.join(ROOT, 'bench', 'memory.mjs')
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-memory-test-')))
// The bench makes its temp dirs here, so a test can see what it left.
const env = { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, TOOLSCRIPT_SHARE: '0' }
// Sharing on, with a short idle time, so a round can wait for the end of its broker.
const IDLE_MS = 1500
const shared = { ...env, TOOLSCRIPT_SHARE: '1', TOOLSCRIPT_BROKER_IDLE_MS: String(IDLE_MS) }
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

// No free-RAM floor: a small runner (macOS counts only free pages) must not stop round 1 at 0 sessions.
const FAST = ['--min-free-mb', '0']
const SMOKE = [...FAST, '--counts', '1,2', '--idle', '1', '--after-run', '1', '--closed', '3']
// The fixture has a fake Claude Code bridge and, with bench4 ("share": false, "lazy": true), 2 lazy servers: they have
// no child until a program calls them.
const LAZY_KEYS = ['bench4', 'claude-code']
const KEYS = ['bench1', 'bench2', 'bench3', 'bench4', 'claude-code']

test('an unknown flag exits 2 before any spawn', () => {
  const r = spawnSync(process.execPath, [BENCH, '--nope'], { encoding: 'utf8', env, windowsHide: true })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: node bench\/memory.mjs/)
  assert.deepEqual(fs.readdirSync(dir), [], 'no temp dir')
})

test('the smoke run: N hosts, N copies of each server, timings, no leftovers, no secrets', () => {
  const json = path.join(dir, 'smoke.json')
  const r = spawnSync(process.execPath, [BENCH, ...SMOKE, '--json', json], {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 180_000,
  })
  assert.equal(r.status, 0, r.stderr)
  const text = fs.readFileSync(json, 'utf8')
  const data = JSON.parse(text)
  assert.equal(data.meta.mode, 'fixture')
  assert.deepEqual(
    data.rounds.map(x => x.count),
    [1, 2],
  )
  for (const round of data.rounds) {
    const n = round.count
    assert.equal(round.sessions.filter(s => s.ok).length, n)
    for (const s of round.sessions) {
      assert.equal(typeof s.initializeMs, 'number')
      assert.equal(typeof s.toolsListMs, 'number')
      assert.equal(typeof s.run1Ms, 'number')
      assert.equal(typeof s.run2Ms, 'number')
      assert.equal(s.runOk, true)
      assert.deepEqual(s.connected, KEYS)
      assert.deepEqual(s.failed, ['down'])
    }
    for (const phase of ['idle', 'after-run']) {
      const procs = round.samples[phase].procs
      assert.equal(procs.filter(p => p.role === 'host').length, n, `${phase}: hosts`)
      for (const key of KEYS) {
        const tops = procs.filter(
          p => p.role === `server ${key}` && !procs.some(q => q.pid === p.ppid && q.role === p.role),
        )
        const asleep = phase === 'idle' && LAZY_KEYS.includes(key)
        assert.equal(tops.length, asleep ? 0 : n, `${phase}: copies of ${key}`)
      }
      const pb = procs.map(p => p.pb)
      const ws = procs.map(p => p.ws)
      if (process.platform === 'win32') {
        assert.ok(pb.every(Number.isFinite) && ws.every(Number.isFinite), 'both numbers on Windows')
        assert.equal(
          round.samples[phase].privateBytes,
          pb.reduce((a, b) => a + b, 0),
        )
      } else if (process.platform === 'linux') {
        assert.ok(
          pb.every(x => x === null),
          'headline not measured on linux',
        )
        assert.ok(ws.every(Number.isFinite), 'private memory from smaps_rollup')
      } else {
        assert.ok(pb.every(x => x === null) && ws.every(x => x === null), 'not measured on macOS')
      }
    }
    assert.deepEqual(round.leftovers, [])
  }
  assert.ok(
    !r.stdout.includes(MARKER) && !r.stderr.includes(MARKER) && !text.includes(MARKER),
    'the marker is in no output',
  )
  assert.match(r.stdout, /not measured|\d+\.\d/)
  // --report prints the same tables from the saved JSON, with no run.
  const again = spawnSync(process.execPath, [BENCH, '--report', json], { encoding: 'utf8', env, windowsHide: true })
  assert.equal(again.status, 0)
  assert.equal(again.stdout, r.stdout)
  assert.deepEqual(
    fs.readdirSync(dir).filter(f => f.startsWith('toolscript-memory-')),
    [],
    'the temp dir is gone',
  )
})

/** The server rows of one sample that are the top of a copy: their parent is not a row of the same server. */
const copies = (procs, key) =>
  procs.filter(p => p.role === `server ${key}` && !procs.some(q => q.pid === p.ppid && q.role === p.role)).length

test('sharing on, 6 sessions in 2 folders at --counts 1,2: one broker, the copies of each class, no leftover', () => {
  const json = path.join(dir, 'shared.json')
  const r = spawnSync(
    process.execPath,
    [
      BENCH,
      ...FAST,
      '--counts',
      '1,2',
      '--folders',
      'a,b',
      '--idle',
      '1',
      '--after-run',
      '1',
      '--closed',
      '8',
      '--json',
      json,
    ],
    { encoding: 'utf8', env: shared, windowsHide: true, timeout: 240_000 },
  )
  assert.equal(r.status, 0, r.stderr)
  const data = JSON.parse(fs.readFileSync(json, 'utf8'))
  assert.equal(data.meta.folders, 2)
  for (const round of data.rounds) {
    const n = round.count
    assert.equal(round.sessions.filter(s => s.ok && s.runOk).length, n)
    assert.deepEqual(
      round.sessions.map(s => s.folder),
      n === 1 ? [0] : [0, 1],
    )
    for (const phase of ['idle', 'after-run']) {
      const procs = round.samples[phase].procs
      const brokers = procs.filter(
        p => p.role === 'broker' && !procs.some(q => q.pid === p.ppid && q.role === 'broker'),
      )
      assert.equal(brokers.length, 1, `${phase}: one broker tree`)
      assert.equal(new Set(procs.map(p => p.pid)).size, procs.length, 'each process once')
      assert.equal(copies(procs, 'bench1'), 1, 'share true: one copy')
      assert.equal(copies(procs, 'bench2'), 1, 'cwd: one copy')
      assert.equal(copies(procs, 'bench3'), Math.min(n, 2), 'no key: one copy for each folder')
      const lazy = phase === 'idle' ? 0 : n
      assert.equal(copies(procs, 'bench4'), lazy, 'share false and lazy: one copy for each session that called it')
      assert.equal(copies(procs, 'claude-code'), lazy, 'a bridge: one copy for each session that called it')
      // The servers of the broker belong to no session.
      assert.ok(procs.filter(p => p.role === 'server bench1').every(p => p.session === null))
    }
    assert.deepEqual(round.leftovers, [], 'the broker ended at its idle time')
    for (const s of round.sessions) assert.deepEqual(s.connected, KEYS)
  }
  assert.ok(!r.stdout.includes(MARKER) && !r.stderr.includes(MARKER), 'the marker is in no output')
})

test('lazy start: the lazy servers have no copy at idle, a copy for each session after a run, none after the idle time, and a run still works', () => {
  const json = path.join(dir, 'lazy.json')
  const lazy = { ...env, TOOLSCRIPT_LAZY_IDLE_MS: '12000' }
  const r = spawnSync(
    process.execPath,
    [BENCH, ...FAST, '--counts', '1,3', '--idle', '1', '--after-run', '0', '--closed', '3', '--json', json],
    { encoding: 'utf8', env: lazy, windowsHide: true, timeout: 240_000 },
  )
  assert.equal(r.status, 0, r.stderr)
  const data = JSON.parse(fs.readFileSync(json, 'utf8'))
  assert.equal(data.meta.afterIdleSeconds, 17, 'the idle time in seconds plus 5')
  for (const round of data.rounds) {
    const n = round.count
    const at = phase => round.samples[phase].procs
    for (const key of LAZY_KEYS) {
      assert.equal(copies(at('idle'), key), 0, `idle: no copy of ${key}`)
      assert.equal(copies(at('after-run'), key), n, `after-run: a copy of ${key} for each session`)
      assert.equal(copies(at('after-idle'), key), 0, `after-idle: no copy of ${key}`)
    }
    for (const key of ['bench1', 'bench2', 'bench3']) assert.equal(copies(at('after-idle'), key), n, key)
    for (const s of round.sessions) {
      assert.equal(s.afterIdleOk, true, 'a run_code after the idle phase works')
      assert.deepEqual(s.connected, KEYS)
      // One wake of each lazy server for the run, and one for the run after the idle time.
      assert.deepEqual(
        s.wakes.map(w => w.key).sort(),
        [...LAZY_KEYS, ...LAZY_KEYS].sort(),
        'two wakes of each lazy server',
      )
    }
    assert.deepEqual(round.leftovers, [])
  }
  assert.ok(r.stdout.includes('### Wake time (ms)'))
  assert.ok(r.stdout.includes('| 3 | claude-code | 6 |'))
  assert.ok(!r.stdout.includes(MARKER) && !r.stderr.includes(MARKER), 'the marker is in no output')
})

test('TOOLSCRIPT_LAZY=0: every server has a copy at idle, after the run and after the idle time', () => {
  const json = path.join(dir, 'eager.json')
  const eager = { ...env, TOOLSCRIPT_LAZY: '0', TOOLSCRIPT_LAZY_IDLE_MS: '2000' }
  const r = spawnSync(
    process.execPath,
    [BENCH, ...FAST, '--counts', '3', '--idle', '1', '--after-run', '0', '--closed', '3', '--json', json],
    { encoding: 'utf8', env: eager, windowsHide: true, timeout: 240_000 },
  )
  assert.equal(r.status, 0, r.stderr)
  const [round] = JSON.parse(fs.readFileSync(json, 'utf8')).rounds
  for (const phase of ['idle', 'after-run', 'after-idle'])
    for (const key of KEYS) assert.equal(copies(round.samples[phase].procs, key), 3, `${phase}: ${key}`)
  for (const s of round.sessions) {
    assert.equal(s.afterIdleOk, true)
    assert.deepEqual(s.wakes, [], 'no lazy start')
  }
  assert.deepEqual(round.leftovers, [])
})

test('--folders and --call give bad values a message, and --call is for real mode only', () => {
  const run = args => spawnSync(process.execPath, [BENCH, ...args], { encoding: 'utf8', env, windowsHide: true })
  assert.match(run(['--folders', 'a,,b']).stderr, /--folders: names or paths/)
  assert.match(run(['--call', 'mcp__bench1__list_issues']).stderr, /--call: real mode only/)
  assert.equal(run(['--folders', '']).status, 2)
})

test('--min-free-mb names megabytes when its value is bad', () => {
  const r = spawnSync(process.execPath, [BENCH, '--min-free-mb', 'lots'], { encoding: 'utf8', env, windowsHide: true })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--min-free-mb: a number of megabytes/)
})

test('a bad --json path still prints the report and exits non-zero', () => {
  const bad = path.join(dir, 'no-such-dir', 'm.json')
  const r = spawnSync(
    process.execPath,
    [BENCH, ...FAST, '--counts', '1', '--idle', '0', '--after-run', '0', '--closed', '1', '--json', bad],
    { encoding: 'utf8', env, windowsHide: true, timeout: 120_000 },
  )
  assert.notEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /## Memory bench/)
  assert.match(r.stderr, /--json: the file could not be written/)
})

const waitFor = (child, pattern, ms) =>
  new Promise((resolve, reject) => {
    let seen = ''
    const timer = setTimeout(() => reject(new Error('the bench did not reach its idle phase')), ms)
    child.stderr.on('data', d => {
      seen += d
      if (pattern.test(seen)) {
        clearTimeout(timer)
        resolve(seen)
      }
    })
  })

const idOf = p => `${p.pid}:${p.t}`
/**
 * The ids (pid and creation time) of the hosts and of every process below them: their servers, the broker (detached,
 * its ppid still names the host that started it), its servers and their wrappers. A child is never older than its
 * parent. A process of another run, such as a broker of this build in another home, is in no such tree.
 */
const treeOf = (table, hostPids) => {
  const tree = new Map(table.filter(p => hostPids.includes(p.pid)).map(p => [p.pid, p.t]))
  for (let grew = true; grew; ) {
    grew = false
    for (const p of table) {
      if (tree.has(p.pid) || !tree.has(p.ppid) || tree.get(p.ppid) > p.t) continue
      tree.set(p.pid, p.t)
      grew = true
    }
  }
  return new Set([...tree].map(([pid, t]) => `${pid}:${t}`))
}
const benchDirs = () => fs.readdirSync(dir).filter(f => f.startsWith('toolscript-memory-'))

test('a hard kill of the bench leaves no host and no fake server, and the next start removes its temp dir', async () => {
  // A process of another run whose command line names the broker of this build: the test must neither count nor end it.
  const named = path.join(ROOT, 'dist', 'host', 'broker.js')
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', named], {
    stdio: 'ignore',
    windowsHide: true,
  })
  after(() => other.kill())
  const child = spawn(process.execPath, [BENCH, ...FAST, '--counts', '2', '--idle', '60'], {
    env: shared,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  const seen = await waitFor(child, /idle: 60 s/, 120_000)
  const pids = [...seen.matchAll(/host pid (\d+)/g)].map(m => Number(m[1]))
  assert.equal(pids.length, 2)
  const table = await readTable()
  const tree = treeOf(table, pids)
  // At idle with sharing on, the hosts have no stdio child: bench4 and the fake bridge are lazy and asleep, and the
  // broker holds bench1, bench2 and bench3. So the run is the 2 hosts, the broker and its 3 servers.
  const running = table.filter(p => tree.has(idOf(p))).map(p => p.cmd.replaceAll('\\', '/'))
  assert.ok(tree.size >= 6, 'the hosts, the broker and its servers run')
  assert.ok(
    running.some(c => c.includes('dist/host/broker.js')),
    'the broker runs',
  )
  for (const key of ['bench1', 'bench2', 'bench3']) {
    assert.ok(
      running.some(c => new RegExp(String.raw`fake-server\.mjs"? ${key}\b`).test(c)),
      `${key} runs`,
    )
  }
  child.kill('SIGKILL')
  await new Promise(resolve => child.on('exit', resolve))
  await new Promise(resolve => setTimeout(resolve, 10_000 + IDLE_MS * 2))
  const left = (await readTable()).filter(p => tree.has(idOf(p)))
  // Do not leave them running if the assertion fails: only rows that matched by pid and creation time.
  for (const p of left) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {}
  }
  const ended = await Promise.race([
    new Promise(resolve => other.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ])
  assert.equal(ended, false, 'the process of another run still lives')
  assert.deepEqual(
    left.map(p => `${p.name} ${p.pid}`),
    [],
  )
  // The hard kill leaves the temp dir of the killed bench, named with its pid.
  const stale = benchDirs()
  assert.equal(stale.length, 1, 'the killed bench left its dir')
  assert.ok(stale[0].startsWith(`toolscript-memory-${child.pid}-`), stale[0])
  // The next bench start sweeps it.
  const next = spawnSync(
    process.execPath,
    [BENCH, ...FAST, '--counts', '1', '--idle', '0', '--after-run', '0', '--closed', '1'],
    { encoding: 'utf8', env, windowsHide: true, timeout: 120_000 },
  )
  assert.equal(next.status, 0, next.stderr)
  assert.deepEqual(benchDirs(), [], 'the stale dir is gone and the next bench left none')
})

// A hard kill of each HOST while its lazy children are awake (#120). The case above kills the bench while the lazy
// servers sleep, so the hosts end in the normal way. Here the hosts get SIGKILL after a run woke bench4 (behind a
// wrapper process, BENCH_WRAP) and the fake bridge: no `close()` runs, and the children can only learn of it from the
// end of their stdin. The fake servers here ignore that EOF
// (BENCH_IGNORE_EOF, as a real server can), so only the child guard ends them: a /bin/sh watchdog outside Windows, and on
// Windows the Job Object program, which TOOLSCRIPT_CHILD_GUARD=1 turns on in this case. A leftover is a failure.
// The case that ignores EOF needs the guard. On Windows the guard compiles a program, which raises a Defender audit event for
// each new program, so a laptop runs the case without it (servers that end on EOF) and CI sets TOOLSCRIPT_TEST_CHILD_GUARD=1.
const guardCase = process.platform !== 'win32' || process.env.TOOLSCRIPT_TEST_CHILD_GUARD === '1'
const matches = (cmd, key) => new RegExp(String.raw`fake-server\.mjs"? ${key}\b`).test(cmd.replaceAll('\\', '/'))

for (const [label, base, limit] of [
  ['sharing off', env, 10_000],
  ['sharing on', shared, 10_000 + IDLE_MS * 2],
]) {
  test(`a hard kill of the hosts while the lazy servers are awake leaves no lazy child and no process below it, ${label}`, async () => {
    // A process of another run whose command line names the broker of this build: neither counted nor ended.
    const other = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', path.join(ROOT, 'dist', 'host', 'broker.js')],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    const child = spawn(process.execPath, [BENCH, ...FAST, '--counts', '2', '--idle', '1', '--after-run', '60'], {
      env: { ...base, BENCH_WRAP: '1', ...(guardCase ? { BENCH_IGNORE_EOF: '1', TOOLSCRIPT_CHILD_GUARD: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let tree = new Set()
    let left = []
    let ended = true
    try {
      const seen = await waitFor(child, /after-run: 60 s/, 120_000)
      const pids = [...seen.matchAll(/host pid (\d+)/g)].map(m => Number(m[1]))
      assert.equal(pids.length, 2)
      const table = await readTable()
      tree = treeOf(table, pids)
      // The lazy servers are awake: below each host, one copy of each key, and bench4 has its wrapper above its node.
      for (const pid of pids) {
        const own = treeOf(table, [pid])
        const rows = table.filter(p => own.has(idOf(p)))
        for (const key of LAZY_KEYS) {
          const of = rows.filter(p => matches(p.cmd, key))
          const tops = of.filter(p => !of.some(q => q.pid === p.ppid))
          assert.equal(tops.length, 1, `host ${pid}: one copy of ${key} is awake`)
          if (key === 'bench4') assert.ok(of.length >= 2, `host ${pid}: bench4 runs behind a wrapper`)
        }
      }
      for (const pid of pids) process.kill(pid, 'SIGKILL')
      const stop = Date.now() + limit
      for (;;) {
        left = (await readTable()).filter(p => tree.has(idOf(p)))
        if (left.length === 0 || Date.now() >= stop) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      ended = await Promise.race([
        new Promise(resolve => other.once('exit', () => resolve(true))),
        new Promise(resolve => setTimeout(() => resolve(false), 1000)),
      ])
    } finally {
      // Record what is left first, then end it by pid and creation time, so a failure leaves nothing running.
      const names = left.map(p => `${p.name} ${p.pid}`)
      const now = new Map((await readTable().catch(() => [])).map(p => [idOf(p), p.pid]))
      for (const [id, pid] of now) {
        if (!tree.has(id)) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      child.kill('SIGKILL')
      await new Promise(resolve =>
        child.exitCode !== null || child.signalCode !== null ? resolve() : child.on('exit', resolve),
      )
      other.kill()
      for (const d of benchDirs().filter(d => d.startsWith(`toolscript-memory-${child.pid}-`)))
        fs.rmSync(path.join(dir, d), { recursive: true, force: true, maxRetries: 5 })
      assert.deepEqual(names, [], 'a process of the killed hosts is still running')
    }
    assert.equal(ended, false, 'the process of another run still lives')
  })
}
