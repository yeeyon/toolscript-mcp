// Repeats one test target many times and reports each test that failed at least once (the stress workflow,
// .github/workflows/stress.yml). Node built-ins only.
//
//   node scripts/stress.mjs run --target tests/lazy.e2e.mjs [--pattern <name>] [--count 30] [--box 10] [--deadline 50] [--out DIR]
//   node scripts/stress.mjs profile flakes [--config tests/stress.json] [--deadline 50] [--out DIR]
//   node scripts/stress.mjs baseline --base DIR --head DIR [--out DIR]
//   node scripts/stress.mjs plan        the jobs of a run of stress.yml, from the environment (EVENT_NAME, INPUT_*)
//
// run: each repeat is one `node --test --test-reporter=junit` of the target (a plain script is one test named by its file), with
// STRESS_RUN=<n> and STRESS_SEED=<seed base + n> in the environment, so a seeded test can shift its seeds. A repeat has a time
// limit (--timeout seconds, default 600), and the target stops repeating after --box minutes. A process that fails with no
// failed test in its junit file (a crash, a time limit) is a failed test named "(process)". --deadline MIN is the end of the whole
// command, counted from its start: no repeat starts after it, a repeat that it cuts is dropped (not a failure), and a profile
// target that never ran because of it is a failed result, so a green run never hides a target that did not run.
// profile: the entries of one profile of tests/stress.json, one after the other. An entry with "optional": true that is not
// in the checkout is skipped with a line. "kind": "script" runs `node <target> <args>` and passes on exit code 0.
// baseline: the budgets of v2 phase 1 for the build in --head against the build in --base (both built), measured in turns.
//
// The summary goes to stdout and to $GITHUB_STEP_SUMMARY, a profile writes the block of each target when the target ends, so a job
// that is killed still shows the targets that finished. The junit file, the stdout and the stderr of each failed repeat go
// to --out (default stress-out). The exit code is 1 when any repeat failed.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MB = 1048576
const TAIL = 1_000_000
const LINES = 30

// ---------------------------------------------------------------------------------------------------------------
// The junit file

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }
export const decode = text =>
  text.replace(/&(lt|gt|quot|apos|amp|#[0-9]+|#x[0-9a-fA-F]+);/g, (whole, e) => {
    if (e in ENTITIES) return ENTITIES[e]
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })

const attr = (attrs, name) => {
  const m = new RegExp('\\s' + name + '="([^"]*)"').exec(attrs)
  return m === null ? undefined : decode(m[1])
}

const firstLines = (text, n = LINES) => text.trim().split('\n').slice(0, n).join('\n')

/**
 * The test cases of a junit file of node:test: the name of each one with the names of its suites ("suite > name"),
 * whether it failed or was skipped, and the text of its failure. A file that no tag of a test case is in gives none.
 */
export const parseJunit = xml => {
  const results = []
  const names = []
  const tag = /<(\/?)(testsuite|testcase)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g
  for (let m = tag.exec(xml); m !== null; m = tag.exec(xml)) {
    const [, close, kind, attrs, self] = m
    if (kind === 'testsuite') {
      if (close) names.pop()
      else if (!self) names.push(attr(attrs, 'name') ?? '')
      continue
    }
    if (close) continue
    const end = self ? -1 : xml.indexOf('</testcase>', tag.lastIndex)
    const body = self ? '' : xml.slice(tag.lastIndex, end < 0 ? xml.length : end)
    const failure = /<(failure|error)((?:\s+[\w:.-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    const failed = failure !== null || attr(attrs, 'failure') !== undefined
    results.push({
      name: [...names, attr(attrs, 'name') ?? ''].join(' > '),
      failed,
      skipped: /<skipped\b/.test(body),
      detail: failed ? firstLines(decode(failure?.[3] ?? attr(attrs, 'failure') ?? '')) : '',
    })
  }
  return results
}

// ---------------------------------------------------------------------------------------------------------------
// The report

/**
 * One row for each test that failed in at least one repeat: the repeats in which it ran, the failures, the rate, and the
 * repeat number, seed and first lines of its first failure. Worst rate first.
 */
export const summarize = runs => {
  const tests = new Map()
  for (const run of runs)
    for (const r of run.results) {
      if (r.skipped) continue
      const t = tests.get(r.name) ?? { name: r.name, runs: 0, fails: 0 }
      tests.set(r.name, t)
      t.runs++
      if (r.failed) {
        t.fails++
        t.first ??= { run: run.run, seed: run.seed, lines: r.detail }
      }
    }
  return [...tests.values()]
    .filter(t => t.fails > 0)
    .map(t => ({ ...t, rate: t.fails / t.runs }))
    .sort((a, b) => b.rate - a.rate || (a.name < b.name ? -1 : 1))
}

// The backslash first: a name with \| or a trailing \ must stay one cell.
export const cell = text =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
const pct = rate => (rate * 100).toFixed(rate < 0.1 && rate > 0 ? 1 : 0) + '%'

/** The markdown of a result: a line for the target, and a table with the first failures when any test failed. */
export const renderTarget = result => {
  const rows = summarize(result.runs)
  const failedRuns = result.runs.filter(r => r.results.some(t => t.failed)).length
  const head =
    '- ' +
    result.label +
    ': ' +
    result.runs.length +
    ' of ' +
    result.planned +
    ' runs' +
    (result.stopped === 'box'
      ? ' (stopped at the box of ' + result.box + ' min)'
      : result.stopped === 'deadline'
        ? ' (stopped at the deadline of the run)'
        : '') +
    ', ' +
    failedRuns +
    ' failed, ' +
    (result.ms / 60000).toFixed(1) +
    ' min' +
    (result.note ? ', ' + result.note : '')
  if (rows.length === 0) return [head]
  const out = [head, '', '| test | runs | fails | rate | first failure (run, seed) |', '|---|---|---|---|---|']
  for (const t of rows)
    out.push('| ' + [cell(t.name), t.runs, t.fails, pct(t.rate), t.first.run + ', ' + t.first.seed].join(' | ') + ' |')
  out.push('')
  for (const t of rows)
    out.push('<details><summary>' + cell(t.name) + '</summary>', '', '~~~', t.first.lines, '~~~', '', '</details>')
  out.push('')
  return out
}

/** The closing line of a run: targets, runs, failed runs and minutes. */
export const renderTotals = results => {
  const runs = results.reduce((n, r) => n + r.runs.length, 0)
  const failed = results.reduce((n, r) => n + r.runs.filter(x => x.results.some(t => t.failed)).length, 0)
  const minutes = results.reduce((n, r) => n + r.ms, 0) / 60000
  return results.length + ' targets, ' + runs + ' runs, ' + failed + ' failed runs, ' + minutes.toFixed(1) + ' min.'
}

export const renderSummary = (title, results) =>
  ['### ' + title, '', ...results.flatMap(renderTarget), '', renderTotals(results)].join('\n')

// ---------------------------------------------------------------------------------------------------------------
// One repeat, and a target

const endTree = child =>
  new Promise(resolve => {
    if (child.pid === undefined || child.exitCode !== null) return resolve()
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      k.on('error', () => resolve())
      return k.on('close', () => resolve())
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    resolve()
  })

/** The environment of a repeat. A run of node:test inside a test (this script under a test) must not pass its context on. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'))

const slug = text =>
  text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'target'

const tailOf = (chunks, size) => Buffer.concat(chunks).subarray(-Math.min(size, TAIL)).toString('utf8')

/** One repeat of `target` (see the header). Returns its results, and the files of a failed repeat when `keep` is set. */
const once = (entry, n, seed, out) =>
  new Promise(resolve => {
    const dir = path.join(out, slug(entry.label), 'run-' + n)
    fs.mkdirSync(dir, { recursive: true })
    const xml = path.join(dir, 'junit.xml')
    const script = entry.kind === 'script'
    const args = script
      ? [...(entry.flags ?? []), entry.target, ...(entry.args ?? [])]
      : [
          '--experimental-strip-types',
          '--test-reporter=junit',
          '--test-reporter-destination=' + xml,
          ...(entry.pattern === undefined ? [] : ['--test-name-pattern=' + entry.pattern]),
          '--test',
          // node reads a backslash of a path as an escape of a glob, so the path goes with slashes.
          entry.target.replaceAll('\\', '/'),
        ]
    const started = performance.now()
    const child = spawn(process.execPath, args, {
      cwd: entry.cwd ?? ROOT,
      env: { ...cleanEnv(), STRESS_RUN: String(n), STRESS_SEED: String(seed) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const outs = []
    const errs = []
    let timedOut = false
    child.stdout.on('data', d => (outs.push(d), outs.length > 64 && outs.splice(0, outs.length - 32)))
    child.stderr.on('data', d => (errs.push(d), errs.length > 64 && errs.splice(0, errs.length - 32)))
    child.on('error', () => {})
    const own = entry.timeout ?? 600
    const left = entry.deadline === undefined ? Infinity : Math.max(1, (entry.deadline - started) / 1000)
    const timer = setTimeout(() => ((timedOut = true), void endTree(child)), Math.min(own, left) * 1000)
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut && left < own) {
        // The deadline of the run cut this repeat: it is not a result, so it is neither a pass nor a failure.
        fs.rmSync(dir, { recursive: true, force: true })
        return resolve({ run: n, seed, ms: performance.now() - started, results: [], cut: true })
      }
      let results = []
      if (!script) {
        try {
          results = parseJunit(fs.readFileSync(xml, 'utf8'))
        } catch {}
      }
      const stdout = tailOf(outs, TAIL)
      const stderr = tailOf(errs, TAIL)
      if (script)
        results = [
          {
            name: entry.label,
            failed: code !== 0,
            skipped: false,
            detail: firstLines((stderr + '\n' + stdout).trim()),
          },
        ]
      else if (timedOut || (code !== 0 && !results.some(r => r.failed)) || (code === 0 && results.length === 0)) {
        const why = timedOut
          ? 'no end in ' + (entry.timeout ?? 600) + ' s'
          : code === 0
            ? 'no test result in the junit file'
            : 'exit code ' + code + ' with no failed test'
        results.push({
          name: '(process) ' + entry.label,
          failed: true,
          skipped: false,
          detail: why + '\n' + firstLines((stderr + '\n' + stdout).trim()),
        })
      }
      const failed = results.some(r => r.failed)
      if (failed || script) {
        fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout)
        fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr)
      }
      if (!failed && !script) fs.rmSync(dir, { recursive: true, force: true })
      resolve({ run: n, seed, ms: performance.now() - started, results })
    })
  })

/**
 * Repeats `entry` ({ target, label, count, box (minutes), pattern, kind, args, timeout }) until count repeats or the box ran out.
 */
export const runTarget = async (entry, { out = 'stress-out', seedBase = 0, deadline } = {}) => {
  const label = entry.label ?? entry.target + (entry.pattern === undefined ? '' : ' / ' + entry.pattern)
  const full = { ...entry, label, deadline }
  const planned = entry.count ?? 1
  const began = performance.now()
  const runs = []
  let stopped
  for (let n = 1; n <= planned; n++) {
    if (deadline !== undefined && n > 1 && performance.now() >= deadline) {
      stopped = 'deadline'
      break
    }
    const run = await once(full, n, seedBase + n, out)
    if (run.cut) {
      stopped = 'deadline'
      break
    }
    runs.push(run)
    if (entry.box !== undefined && performance.now() - began > entry.box * 60000 && n < planned) {
      stopped = 'box'
      break
    }
  }
  return { label, planned, runs, stopped, box: entry.box, note: entry.note, ms: performance.now() - began }
}

/** The entries of profile `name` of `config`, or why there are none. */
export const profileOf = (config, name) => {
  const entries = config !== null && typeof config === 'object' ? config[name] : undefined
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('no profile ' + name + ' in the targets file')
  for (const e of entries)
    if (typeof e.target !== 'string' || !(e.count >= 1)) throw new Error('a bad entry in profile ' + name)
  return entries
}

/** A target that failed to run at all: one failed test named after it. */
const failedResult = (label, detail) => ({
  label,
  planned: 1,
  ms: 0,
  runs: [{ run: 1, seed: 0, ms: 0, results: [{ name: '(process) ' + label, failed: true, skipped: false, detail }] }],
})

/**
 * Runs a profile. A missing optional target is a line, a missing other target is a failed result, and so is a target that the
 * deadline of the run stopped before its first repeat ended. `options.onResult` gets each result when its target ends.
 */
export const runProfile = async (entries, options = {}) => {
  const results = []
  const done = result => (results.push(result), options.onResult?.(result))
  for (const e of entries) {
    const label = e.label ?? e.target
    const file = path.join(e.cwd ?? ROOT, e.target.replace(/\{temp\}/g, os.tmpdir()))
    const glob = /[*?]/.test(e.target)
    if (!glob && !fs.existsSync(file)) {
      done(
        e.optional
          ? { label, planned: 0, runs: [], ms: 0, note: 'skipped: ' + e.target + ' is not in this checkout' }
          : failedResult(label, e.target + ' is not in this checkout'),
      )
      continue
    }
    if (options.deadline !== undefined && performance.now() >= options.deadline) {
      done(failedResult(label, 'not run: the deadline of the run passed before this target started'))
      continue
    }
    const args = (e.args ?? []).map(a => a.replace(/\{temp\}/g, os.tmpdir()))
    const result = await runTarget({ ...e, args }, options)
    done(
      result.runs.length === 0
        ? failedResult(label, 'not run: the deadline of the run passed in its first repeat')
        : result,
    )
  }
  return results
}

export const anyFailed = results => results.some(r => r.runs.some(x => x.results.some(t => t.failed)))

// ---------------------------------------------------------------------------------------------------------------
// baseline

/** The median of a list, or null for no number. */
export const median = list => {
  const s = list.filter(n => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b)
  if (s.length === 0) return null
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Whether bench/memory.mjs reads a private memory number for each process on this system: Windows (private bytes) and Linux
 * (smaps Private + Swap). macOS has none, `ps` has no such column. The two memory rows are then not judged, and say why.
 */
export const measuresMemory = platform => platform === 'win32' || platform === 'linux'

/**
 * The idle sample of 6 hosts in the JSON of bench/memory.mjs, in bytes: private bytes, else the private memory of Linux. Null
 * unless the round is healthy: 6 sessions that all started (the bench did not stop early on free RAM), each with every
 * server connected. A smaller process total divided by 6 would look like a saving.
 */
export const hostBytes = data => {
  const round = data?.rounds?.find(r => r.count === 6)
  const sessions = round?.sessions
  const healthy =
    Array.isArray(sessions) &&
    sessions.length === 6 &&
    round.stoppedAt === undefined &&
    sessions.every(
      x =>
        x.ok === true && Array.isArray(x.failed) && x.failed.length === 0 && !x.connectTimeout && x.error === undefined,
    )
  if (!healthy) return null
  const idle = round.samples?.idle
  const total = idle?.privateBytes ?? idle?.workingSetPrivate
  return typeof total === 'number' ? total : null
}

/**
 * The budgets: a value of head against base. `null` on either side is n/a: a metric that was not measured fails, it never
 * passes silently. `memory: false` (a system with no private memory number, see measuresMemory) leaves out the two memory
 * rows with the reason, and they do not fail.
 */
export const judge = (base, head, { memory = true } = {}) => {
  const rows = []
  const row = (metric, b, h, budget, ok, unit) =>
    rows.push({
      metric,
      base: b,
      head: h,
      budget,
      unit,
      ok: b === null || h === null ? false : ok(b, h),
      na: b === null || h === null,
    })
  const memoryRow = (...args) =>
    memory
      ? row(...args)
      : rows.push({
          metric: args[0],
          base: null,
          head: null,
          budget: args[3],
          unit: args[5],
          ok: true,
          na: false,
          skipped: 'not judged: this system has no private memory number for a process',
        })
  row(
    'start: tools/list ms (median)',
    base.startMs,
    head.startMs,
    '+10% or +50 ms',
    (b, h) => h <= b + Math.max(b * 0.1, 50),
    'ms',
  )
  memoryRow(
    'host memory MB (6 hosts, private memory a host)',
    base.hostMb,
    head.hostMb,
    '+10 MB',
    (b, h) => h <= b + 10,
    'MB',
  )
  memoryRow(
    'sharing: MB saved a host',
    base.sharedSavingMb,
    head.sharedSavingMb,
    'the saving of base',
    (b, h) => h >= b - 0.5,
    'MB',
  )
  row('tools/list bytes', base.listBytes, head.listBytes, '0 on legacy', (b, h) => h <= b, 'bytes')
  row('instructions bytes', base.instructionBytes, head.instructionBytes, '0 on legacy', (b, h) => h <= b, 'bytes')
  row('search_tools bytes', base.searchBytes, head.searchBytes, '0 on legacy', (b, h) => h <= b, 'bytes')
  row('npm pack size bytes', base.packBytes, head.packBytes, '+25%', (b, h) => h <= b * 1.25, 'bytes')
  row('dist/host/main.js bytes', base.mainBytes, head.mainBytes, '+25%', (b, h) => h <= b * 1.25, 'bytes')
  return rows
}

export const renderBaseline = rows => {
  const show = (v, unit) => (v === null ? 'n/a' : unit === 'bytes' ? String(Math.round(v)) : v.toFixed(1))
  return [
    '### baseline: head against base',
    '',
    '| metric | base | head | budget | result |',
    '|---|---|---|---|---|',
    ...rows.map(
      r =>
        '| ' +
        [
          r.metric,
          show(r.base, r.unit),
          show(r.head, r.unit),
          r.budget,
          r.skipped ? r.skipped : r.na ? 'FAIL (not measured)' : r.ok ? 'pass' : 'FAIL',
        ].join(' | ') +
        ' |',
    ),
    '',
    'Tokens and cost need a Claude login and stay on the laptop: the three byte rows are the free proxy.',
  ].join('\n')
}

/** The end of the baseline (a performance.now() time): each call below has at most 300 s, and none starts after it. */
let baselineEnd = Infinity

const runNode = (args, cwd, env = {}) => {
  const left = baselineEnd - performance.now()
  if (left <= 0) return { stdout: '', status: null }
  return spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: Math.min(300_000, left),
    windowsHide: true,
    maxBuffer: 64 * MB,
  })
}

/** The median tools/list time of `runs` starts, from the output of scripts/start-time.mjs. */
const startMs = (dir, runs) => {
  const r = runNode([path.join(dir, 'scripts', 'start-time.mjs'), '--runs', String(runs)], dir)
  const m = /tools\/list: median (\d+) ms/.exec(r.stdout ?? '')
  return m === null ? null : Number(m[1])
}

/** Private memory of each host at 6 hosts idle, in MB, from bench/memory.mjs. Null when the run lost the number. */
const hostMb = (dir, share, tmp) => {
  const file = path.join(tmp, 'mem-' + Math.random().toString(36).slice(2) + '.json')
  runNode(
    [path.join(dir, 'bench', 'memory.mjs'), '--counts', '6', '--idle', '1', '--json', file],
    dir,
    share ? { TOOLSCRIPT_SHARE: '1' } : { TOOLSCRIPT_SHARE: '' },
  )
  try {
    const total = hostBytes(JSON.parse(fs.readFileSync(file, 'utf8')))
    return total === null ? null : total / 6 / MB
  } catch {
    return null
  }
}

const NO_TEXT = { instructionBytes: null, listBytes: null, searchBytes: null }

/**
 * The bytes of the three replies, each null when its reply is not a real one: no instructions string, no tool in the list, an
 * RPC error, an isError result or no text in the search result. A broken reply is a failed row, never a small number.
 */
export const checkedBytes = (init, list, search) => {
  const bytes = value => Buffer.byteLength(JSON.stringify(value))
  const searchOk =
    !search?.error && search?.result?.isError !== true && typeof search?.result?.content?.[0]?.text === 'string'
  return {
    instructionBytes:
      !init?.error && typeof init?.result?.instructions === 'string' ? bytes(init.result.instructions) : null,
    listBytes:
      !list?.error && Array.isArray(list?.result?.tools) && list.result.tools.length > 0 ? bytes(list.result) : null,
    searchBytes: searchOk ? bytes(search.result) : null,
  }
}

/** The bytes the model pays for: the instructions, tools/list and a search_tools result, on the bench fake server. */
export const textBytes = async dir => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-bytes-'))
  const config = path.join(tmp, 'config.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      mcpServers: { bench1: { command: process.execPath, args: [path.join(dir, 'bench', 'fake-server.mjs')] } },
    }),
  )
  const child = spawn(process.execPath, [path.join(dir, 'dist', 'host', 'main.js'), '--config', config], {
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  let buffer = ''
  const waiting = new Map()
  child.stdout.on('data', d => {
    buffer += d
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      try {
        const msg = JSON.parse(line)
        waiting.get(msg.id)?.(msg)
      } catch {}
    }
  })
  let id = 0
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 60_000)
      waiting.set(mine, msg => {
        clearTimeout(timer)
        if (msg.error) reject(new Error(method + ' returned an error'))
        else resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n')
    })
  try {
    const init = await ask('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stress', version: '0' },
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const list = await ask('tools/list', {})
    const search = await ask('tools/call', { name: 'search_tools', arguments: { query: '' } })
    return checkedBytes(init, list, search)
  } finally {
    child.stdin.end()
    await endTree(child)
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
}

const packBytes = dir => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 64 * MB,
  })
  try {
    return JSON.parse(r.stdout)[0].size
  } catch {
    return null
  }
}

/** The metrics of one build, measured with the turns of `runs` already taken: lists of samples. */
const gather = (samples, dir, tmp) => ({
  startMs: median(samples.start),
  hostMb: median(samples.mem),
  sharedSavingMb:
    samples.mem.length > 0 && samples.shared.length > 0 ? median(samples.mem) - median(samples.shared) : null,
  mainBytes: fs.statSync(path.join(dir, 'dist', 'host', 'main.js')).size,
  packBytes: packBytes(dir),
  tmp,
})

/** `deadline`: a performance.now() time after which no measurement starts. What it leaves out is n/a, so the row fails. */
export const baseline = async (baseDir, headDir, out, deadline = Infinity) => {
  baselineEnd = deadline
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-baseline-'))
  const samples = { base: { start: [], mem: [], shared: [] }, head: { start: [], mem: [], shared: [] } }
  const dirs = { base: baseDir, head: headDir }
  // A, B, A, B: the noise of the runner hits both builds.
  for (const turn of ['base', 'head', 'base', 'head'])
    for (const [key, list] of [
      ['start', 10],
      ['mem', 1],
      ['shared', 1],
    ]) {
      const dir = dirs[turn]
      const v = key === 'start' ? startMs(dir, list) : hostMb(dir, key === 'shared', tmp)
      if (v !== null) samples[turn][key].push(v)
    }
  const result = {}
  for (const key of ['base', 'head']) {
    const g = gather(samples[key], dirs[key], tmp)
    result[key] = { ...g, ...(await textBytes(dirs[key]).catch(() => NO_TEXT)) }
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  baselineEnd = Infinity
  const rows = judge(result.base, result.head, { memory: measuresMemory(process.platform) })
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify({ result, rows }, null, 2))
  return rows
}

// ---------------------------------------------------------------------------------------------------------------
// plan: which jobs a run of stress.yml makes

export const SYSTEMS = ['ubuntu-latest', 'macos-latest', 'windows-latest']
/** The Node versions of a profile: the two of test.yml for flakes and one, Node 24 for the others. */
const NODES = { flakes: ['22.13', '24'], one: ['24'], cpu1: ['24'], load: ['24'], bench: ['24'], baseline: ['24'] }
const PROFILES = ['flakes', 'load', 'cpu1', 'bench', 'baseline', 'one']
const SAFE_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_./*-]*$/
const COUNT_MAX = 5000
const SAFE_REF = /^[A-Za-z0-9._/-]+$/

/**
 * The jobs of one run. `event` is the name of the GitHub event, `inputs` the inputs of a dispatch (profile, target, pattern,
 * count, os, node, base), `branch` the stress.json of a stress/** branch. A schedule is flakes and baseline. cpu1 has no macOS
 * job: macOS has no way to limit a job to one CPU. At most 3 macOS jobs run for one event (flakes 2, baseline 1), under the
 * unverified macOS limit of GitHub, which is taken as 5.
 */
export const planOf = ({ event, inputs = {}, branch = {}, latestTag }) => {
  const source = event === 'push' ? { profile: 'flakes', ...branch } : inputs
  const profiles = event === 'schedule' ? ['flakes', 'baseline'] : [source.profile || 'flakes']
  for (const p of profiles)
    if (!PROFILES.includes(p)) throw new Error('no profile ' + p + ': one of ' + PROFILES.join(', '))
  const os = source.os || 'all'
  if (os !== 'all' && !SYSTEMS.includes(os)) throw new Error('os is all or one of ' + SYSTEMS.join(', '))
  const node = source.node || 'default'
  if (!['default', '22.13', '24'].includes(node)) throw new Error('node is default, 22.13 or 24')
  const stress = []
  const baseline = []
  for (const profile of profiles) {
    const systems = (profile === 'cpu1' ? ['ubuntu-latest', 'windows-latest'] : SYSTEMS).filter(
      s => os === 'all' || s === os,
    )
    const nodes = node === 'default' ? NODES[profile] : [node]
    for (const runner of systems)
      for (const version of nodes) {
        const job = { profile, os: runner, node: version, name: profile + ' ' + runner + ' node ' + version }
        if (profile === 'baseline') baseline.push(job)
        else if (profile === 'one') {
          const target = String(source.target ?? '')
          if (!SAFE_TARGET.test(target) || target.includes('..'))
            throw new Error('target is a path of this repository: letters, digits and . _ / * -')
          const count = Number(source.count || 100)
          if (!Number.isInteger(count) || count < 1 || count > COUNT_MAX)
            throw new Error('count is a whole number from 1 to ' + COUNT_MAX)
          stress.push({ ...job, target, pattern: String(source.pattern ?? ''), count: String(count) })
        } else stress.push({ ...job, target: '', pattern: '', count: '' })
      }
  }
  // The base goes to $GITHUB_OUTPUT: a ref has no newline, no leading dash and no `..`, so no line of output can be forged.
  // The weekly run compares with the newest release, not with main: main against main shows nothing.
  if (event === 'schedule' && !latestTag)
    throw new Error('the weekly baseline needs a v* release tag, and there is none')
  const ref = String(event === 'schedule' ? latestTag : source.base || 'main')
  if (!SAFE_REF.test(ref) || ref.startsWith('-') || ref.includes('..'))
    throw new Error('base is a ref: letters, digits and . _ / -')
  const mac = [...stress, ...baseline].filter(j => j.os === 'macos-latest').length
  if (mac > 3) throw new Error('more than 3 macOS jobs: ' + mac)
  return { stress, baseline, base: ref }
}

/** The newest release tag (vX.Y.Z, no prerelease) in a list of tag names, one for each line, or undefined. */
export const newestTag = text =>
  text
    .split('\n')
    .map(t => t.trim())
    .filter(t => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const x = a.slice(1).split('.').map(Number)
      const y = b.slice(1).split('.').map(Number)
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
    })[0]

/** The lines for $GITHUB_OUTPUT of a plan. */
export const planOutputs = plan =>
  [
    'stress=' + JSON.stringify({ include: plan.stress }),
    'has_stress=' + String(plan.stress.length > 0),
    'baseline=' + JSON.stringify({ include: plan.baseline }),
    'has_baseline=' + String(plan.baseline.length > 0),
    'base=' + plan.base,
  ].join('\n')

// ---------------------------------------------------------------------------------------------------------------
// The command line

const publish = text => {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
}

const main = async () => {
  const [command, ...rest] = process.argv.slice(2)
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      pattern: { type: 'string' },
      count: { type: 'string' },
      box: { type: 'string' },
      timeout: { type: 'string' },
      out: { type: 'string', default: 'stress-out' },
      config: { type: 'string', default: path.join(ROOT, 'tests', 'stress.json') },
      kind: { type: 'string' },
      only: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      'seed-base': { type: 'string', default: '0' },
      deadline: { type: 'string' },
    },
  })
  const label = process.env.STRESS_LABEL ?? os.type() + ' node ' + process.versions.node
  const minutes = values.deadline === undefined ? undefined : Number(values.deadline)
  if (minutes !== undefined && !(minutes > 0)) throw new Error('--deadline is a number of minutes above 0')
  const options = {
    out: values.out,
    seedBase: Number(values['seed-base']),
    deadline: minutes === undefined ? undefined : performance.now() + minutes * 60000,
  }
  if (command === 'run') {
    if (values.target === undefined) throw new Error('run needs --target')
    const entry = {
      target: values.target,
      pattern: values.pattern,
      count: Number(values.count ?? 1),
      kind: values.kind,
      ...(values.box && { box: Number(values.box) }),
      ...(values.timeout && { timeout: Number(values.timeout) }),
      ...(positionals.length > 0 && { args: positionals }),
    }
    const results = [await runTarget(entry, options)]
    publish(renderSummary('stress: ' + label, results))
    process.exit(anyFailed(results) ? 1 : 0)
  }
  if (command === 'profile') {
    const name = positionals[0]
    const entries = profileOf(JSON.parse(fs.readFileSync(values.config, 'utf8')), name).filter(
      e => values.only === undefined || e.target.includes(values.only),
    )
    if (entries.length === 0) throw new Error('--only ' + values.only + ' matches no target of profile ' + name)
    publish('### stress ' + name + ': ' + label + '\n')
    const results = await runProfile(entries, {
      ...options,
      onResult: result => publish(renderTarget(result).join('\n')),
    })
    publish('\n' + renderTotals(results))
    process.exit(anyFailed(results) ? 1 : 0)
  }
  if (command === 'plan') {
    // The environment of the workflow: the event, the inputs of a dispatch, and the stress.json of a stress/** branch.
    const env = process.env
    let branch = {}
    try {
      branch = JSON.parse(fs.readFileSync(path.join(ROOT, 'stress.json'), 'utf8'))
    } catch {}
    const inputs = Object.fromEntries(
      ['profile', 'target', 'pattern', 'count', 'os', 'node', 'base'].map(k => [
        k,
        env['INPUT_' + k.toUpperCase()] ?? '',
      ]),
    )
    const event = env.EVENT_NAME ?? 'workflow_dispatch'
    const tags =
      event === 'schedule'
        ? spawnSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
        : null
    const latestTag = tags === null ? undefined : newestTag(tags.stdout ?? '')
    const text = planOutputs(planOf({ event, inputs, branch, latestTag }))
    console.log(text)
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, text + '\n')
    process.exit(0)
  }
  if (command === 'baseline') {
    if (!values.base || !values.head) throw new Error('baseline needs --base and --head')
    const rows = await baseline(path.resolve(values.base), path.resolve(values.head), values.out, options.deadline)
    publish(renderBaseline(rows))
    process.exit(rows.some(r => !r.ok) ? 1 : 0)
  }
  console.error(
    'usage: node scripts/stress.mjs run --target FILE [--pattern NAME] [--count N] [--box MIN] [--timeout SEC] [--deadline MIN] [--out DIR]\n       node scripts/stress.mjs profile NAME [--config FILE] [--only TEXT] [--deadline MIN] [--out DIR]\n       node scripts/stress.mjs baseline --base DIR --head DIR [--out DIR]',
  )
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
