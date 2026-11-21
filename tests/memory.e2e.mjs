// Test of bench/memory.mjs in fixture mode, on Linux, macOS and Windows: the smoke run (2 rounds, 3 stdio servers
// each), the secrets rule and the hard kill of the bench. It asserts no memory threshold. Run `npm run build` first.
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
const env = { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir }
after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

const SMOKE = ['--counts', '1,2', '--idle', '1', '--after-run', '1', '--closed', '3']
const KEYS = ['bench1', 'bench2', 'bench3']

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
        assert.equal(tops.length, n, `${phase}: copies of ${key}`)
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

const alive = async hosts => {
  const table = await readTable()
  return table.filter(p => hosts.includes(p.pid) || p.cmd.includes(MARKER))
}

test('a hard kill of the bench leaves no host and no fake server', async () => {
  const child = spawn(process.execPath, [BENCH, '--counts', '2', '--idle', '60'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  const seen = await waitFor(child, /idle: 60 s/, 120_000)
  const hosts = [...seen.matchAll(/host pid (\d+)/g)].map(m => Number(m[1]))
  assert.equal(hosts.length, 2)
  assert.ok((await alive(hosts)).length >= 8, 'the hosts and their servers run')
  child.kill('SIGKILL')
  await new Promise(resolve => child.on('exit', resolve))
  await new Promise(resolve => setTimeout(resolve, 10_000))
  const left = await alive(hosts)
  // Do not leave them running if the assertion fails.
  for (const p of left) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {}
  }
  assert.deepEqual(
    left.map(p => `${p.name} ${p.pid}`),
    [],
  )
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
