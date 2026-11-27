// Workspace against the Claude Code bridge (issue #151): the same four questions about one disposable repository, asked
// through toolscript-mcp hosts that have the built-in Workspace (a) or the Claude Code bridge (b, claude mcp serve).
//
//   node bench/workspace-bridge.mjs                      1 and 6 sessions, 5 warm repeats of each question
//   node bench/workspace-bridge.mjs --counts 1,2 --reps 2 --json out.json
//   node bench/workspace-bridge.mjs --claude <path>      the claude executable (default: claude.exe or claude on PATH)
//
// Run `npm run build` first. Every call is a run_code of one program, as a model sends it, so the result characters are
// what goes back into the context. No model, no spend. The fixture, the home of the hosts and the config folder of
// Claude Code are temp folders made here: no real project, no real toolscript config, no ~/.claude.json. The bridge is
// started by the host (the key claude-code makes it lazy: it starts at the first call) with the executable itself,
// windowsHide, never claude.ps1. Memory is private bytes and private working set of every process of every host, each
// process once, on Windows only. The script ends only the hosts that it started, and what it can see below them.
// Nothing from a result is printed: only sizes, times and counts.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readTable } from './memory.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = path.join(REPO, 'dist', 'host', 'main.js')
const MB = 1048576
const LIMIT = 120_000
const SETTLE_MS = 4000
const CALLS = ['list', 'find', 'search', 'read']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = line => console.error(line)
const median = list => {
  const s = [...list].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mb = n => (n === null || n === undefined ? 'n/a' : (n / MB).toFixed(0))

// The fixture: 1,500 files in 120 folders under src/ (.ts) and docs/ (.md), from a fixed seed, so a run repeats.
const seeded = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const NEEDLE = 'needle-3'
const makeFixture = dir => {
  const rand = seeded(151)
  const words = Array.from({ length: 300 }, (_, i) => 'w' + i.toString(36) + Math.floor(rand() * 1e4))
  const folders = [{ dir: 'src', ext: 'ts' }]
  for (let i = 1; i < 100; i++) folders.push({ dir: 'src/d' + i, ext: 'ts' })
  for (let i = 0; i < 20; i++) folders.push({ dir: 'docs/g' + i, ext: 'md' })
  for (const f of folders) fs.mkdirSync(path.join(dir, f.dir), { recursive: true })
  let needles = 0
  for (let i = 0; i < 1500; i++) {
    const f = folders[i % folders.length]
    const lines = []
    for (let size = 0, goal = 1024 + rand() * 5120; size < goal; ) {
      let line = Array.from({ length: 8 }, () => words[Math.floor(rand() * words.length)]).join(' ')
      if (needles < 8 && rand() < 0.004) ((line += ' ' + NEEDLE), needles++)
      lines.push(line)
      size += line.length + 1
    }
    fs.writeFileSync(path.join(dir, f.dir, 'f' + i + '.' + f.ext), lines.join('\n'))
  }
  return needles
}

// The same four questions for each arm: the entries of src/, the markdown files of docs/, the lines with a needle, one file.
const READ_FILE = 'src/d7/f7.ts'
const PROGRAMS = (fix, arm) =>
  arm === 'workspace'
    ? {
        list: 'return await call("mcp__workspace__list", { path: "src/d7", depth: 1 })',
        find: 'return await call("mcp__workspace__list", { path: "docs", depth: 4, include: ["**/*.md"] })',
        search: 'return await call("mcp__workspace__search", { query: "' + NEEDLE + '" })',
        read: 'return await call("mcp__workspace__read", { path: "' + READ_FILE + '" })',
      }
    : {
        list: 'return await call("mcp__claude-code__Glob", { pattern: "src/d7/*", path: ' + JSON.stringify(fix) + ' })',
        find:
          'return await call("mcp__claude-code__Glob", { pattern: "docs/**/*.md", path: ' + JSON.stringify(fix) + ' })',
        search:
          'return await call("mcp__claude-code__Grep", { pattern: "' +
          NEEDLE +
          '", path: ' +
          JSON.stringify(fix) +
          ', output_mode: "content", "-n": true })',
        read:
          'return await call("mcp__claude-code__Read", { file_path: ' +
          JSON.stringify(path.join(fix, READ_FILE)) +
          ' })',
      }

const findClaude = () => {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter))
    for (const n of names) {
      const file = path.join(dir, n)
      if (dir !== '' && fs.existsSync(file)) return file
    }
  return undefined
}

// One host over stdio and the MCP client of this script.
class Session {
  constructor(n, args, env, cwd) {
    this.n = n
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.pid = this.child.pid
    this.exited = new Promise(resolve => this.child.on('exit', resolve))
    this.child.on('error', () => {})
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('data', () => {})
    this.child.stdout.on('data', d => {
      this.buffer += d
      let i
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i)
        this.buffer = this.buffer.slice(i + 1)
        try {
          const msg = JSON.parse(line)
          const waiter = this.pending.get(msg.id)
          if (waiter) (this.pending.delete(msg.id), clearTimeout(waiter.timer), waiter.resolve(msg))
        } catch {}
      }
    })
    this.child.on('exit', () => {
      for (const w of this.pending.values()) (clearTimeout(w.timer), w.reject(new Error('the host ended')))
      this.pending.clear()
    })
  }
  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(method + ' timed out'))), LIMIT)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async init() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'workspace-bridge-bench', version: '0' },
    })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return r
  }
  /** One run_code: the time, the characters of the text that the model would get, and whether the program was an error. */
  async run(code) {
    const start = performance.now()
    const r = await this.request('tools/call', { name: 'run_code', arguments: { code } })
    const ms = performance.now() - start
    const text = (r.result?.content ?? []).map(c => c.text ?? '').join('')
    return { ms, chars: text.length, ok: r.result?.isError !== true && !/^(error|refused|could not)/i.test(text) }
  }
  async close() {
    this.child.stdin.end()
    await Promise.race([this.exited, sleep(15_000)])
  }
}

// The hosts and everything below them in the process table, each once. A child is never older than its parent.
const treeOf = (table, roots) => {
  const byPid = new Map(table.map(e => [e.pid, e]))
  const mine = new Map()
  for (const e of [...table].sort((a, b) => a.t - b.t || a.pid - b.pid)) {
    const root = roots.get(e.pid)
    if (root !== undefined && root.t === e.t) mine.set(e.pid, e)
    else if (mine.has(e.ppid) && byPid.get(e.ppid).t <= e.t) mine.set(e.pid, e)
  }
  return [...mine.values()]
}
const sample = async (hostsByPid, label) => {
  const procs = treeOf(await readTable(), hostsByPid)
  const sumOf = field =>
    procs.length > 0 && procs.every(p => p[field] === null) ? null : procs.reduce((a, p) => a + (p[field] ?? 0), 0)
  const images = {}
  for (const p of procs) images[p.name.toLowerCase()] = (images[p.name.toLowerCase()] ?? 0) + 1
  return {
    label,
    processes: procs.length,
    images,
    pb: sumOf('pb'),
    ws: sumOf('ws'),
    pids: procs.map(p => ({ pid: p.pid, t: p.t })),
  }
}

const cachedEntries = home => {
  try {
    const file = path.join(home, '.toolscript-mcp', 'learned', 'tools.json')
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? {}).length
  } catch {
    return 0
  }
}

const killTree = pid =>
  new Promise(resolve => {
    if (process.platform === 'win32') {
      const c = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      c.on('error', resolve)
      c.on('close', resolve)
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
      resolve()
    }
  })

const runArm = async (arm, count, reps, ctx) => {
  log('arm ' + arm + ', ' + count + ' session(s)')
  const config =
    arm === 'workspace'
      ? { mcpServers: {}, workspace: { roots: [{ path: ctx.fix }] } }
      : {
          mcpServers: {
            'claude-code': {
              command: ctx.claude,
              args: ['mcp', 'serve'],
              env: { CLAUDE_CONFIG_DIR: ctx.ccDir },
              cwd: ctx.fix,
            },
          },
          policy: ['Glob', 'Grep', 'Read'].map(t => ({ match: 'mcp__claude-code__' + t, action: 'allow' })),
        }
  const cfgFile = path.join(ctx.base, arm + '-' + count + '.json')
  fs.writeFileSync(cfgFile, JSON.stringify(config))
  const env = { ...ctx.env, HOME: ctx.home, USERPROFILE: ctx.home }
  // The first start of a host has no tool list of the lazy bridge yet, so it starts the bridge at once. One host fills
  // the list (learned/tools.json of the temp home), as the memory bench does, so the rounds start as a later session does.
  let firstStart
  if (arm === 'bridge' && cachedEntries(ctx.home) === 0) {
    log('warm-up: one host fills the tool list of the bridge')
    const w = new Session(0, [MAIN, '--config', cfgFile], env, ctx.fix)
    const t0 = performance.now()
    await w.init()
    const ms = performance.now() - t0
    for (const end = Date.now() + LIMIT; cachedEntries(ctx.home) < 1 && Date.now() < end; ) await sleep(200)
    await sleep(SETTLE_MS)
    const rootsW = new Map([[w.pid, { t: (await readTable()).find(e => e.pid === w.pid)?.t }]])
    const s = await sample(rootsW, 'first start')
    firstStart = { ms, processes: s.processes, pb: s.pb, ws: s.ws }
    await w.close()
    await sleep(2000)
    for (const e of treeOf(await readTable(), rootsW)) await killTree(e.pid)
  }
  const sessions = []
  const startedAt = Date.now()
  const starts = []
  for (let n = 1; n <= count; n++) {
    const s = new Session(n, [MAIN, '--config', cfgFile], env, ctx.fix)
    sessions.push(s)
    const t0 = performance.now()
    await s.init()
    starts.push(performance.now() - t0)
  }
  const roots = new Map(sessions.map(s => [s.pid, { t: undefined }]))
  // The creation time of each host, from the table: the pid must be ours and newer than the start of the round.
  const first = await readTable()
  for (const s of sessions) {
    const row = first.find(e => e.pid === s.pid && e.t >= startedAt - 5000)
    roots.set(s.pid, { t: row?.t })
  }
  await sleep(SETTLE_MS)
  const idle = await sample(roots, 'idle, before the first call')
  const programs = PROGRAMS(ctx.fix, arm)
  const cold = Object.fromEntries(CALLS.map(c => [c, []]))
  const warm = Object.fromEntries(CALLS.map(c => [c, []]))
  const chars = {}
  let calls = 0
  let bad = 0
  for (const s of sessions) {
    for (const c of CALLS) {
      const r = await s.run(programs[c])
      calls++
      if (!r.ok) bad++
      cold[c].push(r.ms)
      chars[c] ??= r.chars
    }
  }
  for (const s of sessions)
    for (let k = 0; k < reps; k++)
      for (const c of CALLS) {
        const r = await s.run(programs[c])
        calls++
        if (!r.ok) bad++
        warm[c].push(r.ms)
        if (r.chars !== chars[c]) chars[c] = Math.max(chars[c], r.chars)
      }
  await sleep(SETTLE_MS)
  const used = await sample(roots, 'after the calls, idle')
  const seen = new Set([...idle.pids, ...used.pids].map(p => p.pid + ':' + p.t))
  for (const s of sessions) await s.close()
  // Only what this round started and the table still shows is ended, by pid and creation time.
  await sleep(2000)
  const left = treeOf(await readTable(), roots).filter(e => seen.has(e.pid + ':' + e.t) || roots.has(e.pid))
  for (const e of left) if (roots.has(e.pid) || seen.has(e.pid + ':' + e.t)) await killTree(e.pid)
  return { arm, count, firstStart, starts, idle, used, cold, warm, chars, calls, bad, leftovers: left.length }
}

const render = (data, opts) => {
  const out = []
  out.push(
    'Fixture: ' +
      data.meta.files +
      ' files, ' +
      data.meta.folders +
      ' folders, ' +
      data.meta.needles +
      ' needle lines.',
  )
  out.push(
    'Warm repeats per session and question: ' +
      opts.reps +
      '. Times are ms; a cold time is the first call of a question in a fresh session.',
  )
  out.push('')
  out.push(
    '| arm | sessions | question | result chars | cold ms (median) | cold ms (max) | warm ms (median) | warm ms (max) |',
  )
  out.push('|---|---|---|---|---|---|---|---|')
  for (const r of data.rounds)
    for (const c of CALLS)
      out.push(
        '| ' +
          [
            r.arm,
            r.count,
            c,
            r.chars[c],
            median(r.cold[c]).toFixed(0),
            Math.max(...r.cold[c]).toFixed(0),
            median(r.warm[c]).toFixed(0),
            Math.max(...r.warm[c]).toFixed(0),
          ].join(' | ') +
          ' |',
      )
  out.push('')
  out.push(
    '| arm | sessions | host start ms (median) | calls | failed calls | processes idle | private MB idle | processes after calls | private MB after | private working set MB after | images after | leftovers |',
  )
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of data.rounds)
    out.push(
      '| ' +
        [
          r.arm,
          r.count,
          median(r.starts).toFixed(0),
          r.calls,
          r.bad,
          r.idle.processes,
          mb(r.idle.pb),
          r.used.processes,
          mb(r.used.pb),
          mb(r.used.ws),
          Object.entries(r.used.images)
            .map(([k, v]) => v + ' ' + k)
            .join(', '),
          r.leftovers,
        ].join(' | ') +
        ' |',
    )
  for (const r of data.rounds.filter(r => r.firstStart))
    out.push(
      '',
      'Bridge, first start of a host with an empty tool list (it starts the bridge at once): host ready in ' +
        r.firstStart.ms.toFixed(0) +
        ' ms, ' +
        r.firstStart.processes +
        ' processes, ' +
        mb(r.firstStart.pb) +
        ' MB private bytes, ' +
        mb(r.firstStart.ws) +
        ' MB private working set.',
    )
  return out.join('\n')
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      counts: { type: 'string' },
      reps: { type: 'string' },
      json: { type: 'string' },
      claude: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help)
    return void console.log(
      'usage: node bench/workspace-bridge.mjs [--counts 1,6] [--reps 5] [--json FILE] [--claude PATH]',
    )
  const counts = (values.counts ?? '1,6').split(',').map(Number)
  const reps = Number(values.reps ?? 5)
  if (!fs.existsSync(MAIN)) throw new Error('run npm run build first')
  const claude = values.claude ?? findClaude()
  if (claude === undefined) throw new Error('no claude executable on PATH: pass --claude')
  if (/\.ps1$/i.test(claude)) throw new Error('never claude.ps1: pass the executable')
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bridge-bench-')))
  const fix = path.join(base, 'fixture')
  const home = path.join(base, 'home')
  const ccDir = path.join(base, 'claude-config')
  for (const d of [fix, home, ccDir]) fs.mkdirSync(d, { recursive: true })
  const needles = makeFixture(fix)
  const claudeVersion = spawnSync(claude, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: ccDir, HOME: home, USERPROFILE: home },
  }).stdout?.trim()
  const ctx = { base, fix, home, ccDir, claude, env: { ...process.env } }
  const data = {
    meta: {
      node: process.version,
      os: os.type() + ' ' + os.release(),
      claude: claudeVersion,
      files: 1500,
      folders: 120,
      needles,
      cpus: os.cpus().length,
    },
    rounds: [],
  }
  try {
    for (const count of counts) {
      if (os.freemem() / MB < 3000) throw new Error('less than 3 GB of free RAM: no session starts')
      for (const arm of ['workspace', 'bridge']) data.rounds.push(await runArm(arm, count, reps, ctx))
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  }
  console.log(JSON.stringify(data.meta))
  console.log(render(data, { reps }))
  if (values.json) fs.writeFileSync(values.json, JSON.stringify(data))
}

await main()
