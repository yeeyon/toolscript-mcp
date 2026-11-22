// Memory bench: what N toolscript-mcp sessions cost in private bytes, processes and start time.
//
//   node bench/memory.mjs                         fixture: 1, 3 and 6 sessions, 60 s idle, 3 fake stdio servers
//   node bench/memory.mjs --counts 1,2 --idle 1   the CI smoke
//   node bench/memory.mjs --json out.json         also write every process of every sample
//   node bench/memory.mjs --report out.json       the tables again from a saved JSON, with no run
//   node bench/memory.mjs --config <file>         real mode, for the owner only: the file as given, the real home
//
// Run `npm run build` first. A session is one `dist/host/main.js --config <file>` over stdio, started by this
// script, which is the MCP client. No Claude Code, no model, no spend. Sessions of a round start one after the
// other. The memory figure is private bytes (commit) summed over every process of every session, each process once
// by pid and creation time. It is never RSS or working set. The share switch is not an option here: "share" in the
// config and TOOLSCRIPT_SHARE in the environment pass through to the hosts, so the same command measures a shared run.
// Nothing from the config goes into the output: only server keys, image basenames, pids, counts and numbers.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ISSUES } from './data.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = path.join(REPO, 'dist', 'host', 'main.js')
// The broker of slice 3 of #63, if this build has one. A process counts as a broker only with the switch on, as a node
// process whose argv[1] is this exact file and whose pid the broker.log of the bench home names (see `isBroker`), so an
// unrelated process that mentions the path is never counted or ended.
const BROKER = path.join(REPO, 'dist', 'host', 'broker.js')
const FAKE_SERVER = path.join(REPO, 'bench', 'fake-server.mjs')
const MB = 1048576
/** In the arg, an env value, a header and the URL of the fixture: no output may hold it. tests/memory.e2e.mjs checks that. */
export const MARKER = 'bench-marker-7c1e9a52'
// One server of each class of the share rules (src/core/share.ts): "share": true, a cwd, no key, "share": false.
const FIXTURE_KEYS = ['bench1', 'bench2', 'bench3', 'bench4']
// Slice 5 of #63: a fake Claude Code bridge (the key makes it a bridge, so it is lazy by default), and "lazy": true on
// bench4, the "share": false server. Both start on the first call of a program and stop after the idle time.
const BRIDGE_KEY = 'claude-code'
const ALL_KEYS = [...FIXTURE_KEYS, BRIDGE_KEY]
// The line of a host that a lazy server logs when a call starts it: <key>: started on first use, <ms> ms, <n> tools.
const WAKE_LINE = /^toolscript-mcp: ([A-Za-z0-9_-]+): started on first use, (\d+) ms, \d+ tools$/
/** The longest wait for a start, a connect and a table read, in ms. */
const LIMIT = 120_000
const EXIT_WAIT = 15_000
const STDIN_WAIT = 5_000

const USAGE = `usage: node bench/memory.mjs [--counts 1,3,6] [--idle SECONDS] [--after-run SECONDS] [--closed SECONDS]
       [--after-idle SECONDS] [--min-free-mb MB] [--folders A,B,...] [--call TOOL]... [--json FILE] [--config FILE]
       node bench/memory.mjs --report FILE
Fixture mode (default) starts hosts with 5 fake stdio servers (one of each share class, and a fake Claude Code bridge) and a temp home. --config FILE is real mode: the owner's
config and home, a run_code that only returns 1, and no tool call. Run \`npm run build\` first.
--counts       sessions per round, one fresh round each (default 1,3,6)
--idle         seconds without traffic before the first sample (default 60)
--after-run    seconds from the last run_code result to the second sample (default 5)
--after-idle   seconds from the second sample to the third, the phase after-idle, and then one run_code that must
               still work. Default: TOOLSCRIPT_LAZY_IDLE_MS in seconds plus 5 when that variable is set, else no phase
--closed       seconds from the end of every host to the list of leftovers (default 10)
--min-free-mb  a session does not start when free RAM is below this (default 2048)
--folders      session k starts in folder k modulo the count. Real mode: the folders must exist. Fixture mode makes
               one temp folder for each name in the list and never uses the names as paths
--call TOOL    real mode only, repeatable: each session calls the tool once with {} through run_code (a full id,
               mcp__<key>__<tool>), and the report says ok or failed for each server key. A result is never printed
--json FILE    write every process, timing and leftover as JSON
--report FILE  print the tables of a saved JSON and run nothing`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = line => console.error(line)
const median = list => {
  const s = [...list].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = list => list.reduce((a, b) => a + b, 0)
const norm = text =>
  String(text ?? '')
    .toLowerCase()
    .replaceAll('\\', '/')
    .replaceAll('"', '')

// The process table. One read gives every process: pid, parent pid, creation time (ms since the epoch), image
// basename, command line (kept in memory, never printed), private bytes and private working set (null when unknown).

const WINDOWS_READ = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$perf=@{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess]=$_ }
Get-CimInstance Win32_Process | ForEach-Object {
  $m=$perf[[int]$_.ProcessId]
  [pscustomobject]@{p=[int]$_.ProcessId;pp=[int]$_.ParentProcessId;t=$(if($_.CreationDate){[int64]($_.CreationDate.ToFileTimeUtc()/10000)}else{0});n=$_.Name;c=$_.CommandLine;pb=$(if($m){[int64]$m.PrivateBytes}else{$null});ws=$(if($m){[int64]$m.WorkingSetPrivate}else{$null})}
} | ConvertTo-Json -Compress`

const readWindows = () =>
  new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_READ, 'utf16le').toString('base64'),
    ]
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    const timer = setTimeout(() => child.kill(), LIMIT)
    child.stdout.on('data', d => chunks.push(d))
    child.on('error', () => reject(new Error('the process table is not readable')))
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(
          rows.map(r => ({
            pid: r.p,
            ppid: r.pp,
            t: r.t - 11644473600000,
            name: r.n,
            cmd: r.c ?? '',
            pb: r.pb,
            ws: r.ws,
          })),
        )
      } catch {
        reject(new Error('the process table is not readable'))
      }
    })
  })

const readLinux = () => {
  const text = file => fs.readFileSync(file, 'utf8')
  const boot = Number(/^btime (\d+)/m.exec(text('/proc/stat'))?.[1] ?? 0)
  const rows = []
  for (const dir of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      const stat = text(`/proc/${dir}/stat`)
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      // Field 22 of stat is the start in clock ticks after boot. 100 ticks a second is the value of every common kernel.
      const t = Math.round((boot + Number(fields[19]) / 100) * 1000)
      let cmd = ''
      let ws = null
      try {
        cmd = text(`/proc/${dir}/cmdline`).replaceAll('\0', ' ')
      } catch {}
      try {
        const roll = text(`/proc/${dir}/smaps_rollup`)
        const read = key => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(roll)?.[1] ?? 0)
        ws = (read('Private_Clean') + read('Private_Dirty') + read('Swap')) * 1024
      } catch {}
      rows.push({
        pid: Number(dir),
        ppid: Number(fields[1]),
        t,
        name: stat.slice(stat.indexOf('(') + 1, close),
        cmd,
        pb: null,
        ws,
      })
    } catch {}
  }
  return Promise.resolve(rows)
}

const readMac = () =>
  new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks = []
    child.stdout.on('data', d => chunks.push(d))
    child.on('error', () => reject(new Error('the process table is not readable')))
    child.on('close', () => {
      const rows = []
      for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line)
        if (!m) continue
        const cmd = m[4]
        rows.push({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          t: Date.parse(m[3]),
          name: path.basename(cmd.split(' ')[0]),
          cmd,
          pb: null,
          ws: null,
        })
      }
      resolve(rows)
    })
  })

export const readTable = () =>
  process.platform === 'win32' ? readWindows() : process.platform === 'linux' ? readLinux() : readMac()

const MEMORY_NOTE = {
  win32: { headline: 'private bytes (commit)', second: 'private working set' },
  linux: {
    headline: 'not measured on linux',
    second: 'private memory from smaps_rollup (Private_Clean + Private_Dirty + Swap)',
  },
}[process.platform] ?? { headline: 'not measured on this system', second: 'not measured on this system' }

// The groups of stdio entries: entries with the same command and args are one group with their keys joined. A
// process matches a group when its command line holds the command basename and every arg that has no ${VAR}.

const stdioGroups = servers => {
  const groups = new Map()
  const http = []
  for (const [key, entry] of Object.entries(servers)) {
    if (typeof entry?.command !== 'string' || entry.type === 'http' || entry.type === 'sse') {
      http.push(key)
      continue
    }
    const args = Array.isArray(entry.args) ? entry.args.filter(a => typeof a === 'string' && !a.includes('${')) : []
    const id = JSON.stringify([entry.command, entry.args ?? []])
    const group = groups.get(id) ?? {
      keys: [],
      needle: norm(path.basename(entry.command).replace(/\.(exe|cmd|bat)$/i, '')),
      args: args.map(norm),
    }
    group.keys.push(key)
    groups.set(id, group)
  }
  return { groups: [...groups.values()], http }
}

// Which processes belong to which session. `known` holds every process seen in any sample by pid and creation
// time, so a grandchild whose parent died stays attributed. A process joins when it is a host that this script
// started, a new broker (a process of broker.js created after the round began), or the child of a process that
// joined (parents are older than children, so one pass in creation order is enough).

// `brokerPids` returns the pids that the broker.log of the home of the hosts names (`start pid N`). It is empty with the
// switch off, so a run with sharing off attributes no broker at all and ends nothing that it did not start.
export const newTracker = (groups, since, brokerPids = () => new Set()) => ({
  groups,
  since,
  brokerPids,
  known: new Map(),
  hosts: new Map(),
})

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BROKER_CMD = new RegExp(`(^|/)node(\\.exe)?\\s+${escapeRe(norm(BROKER))}\\s*$`)

// A broker is a node process whose argv[1] is the broker.js of this build, that this script's hosts started after the
// round began, and whose pid the broker.log of the bench home names. Nothing else is ever a broker: not a shell whose
// text names the path, and not the broker of a parallel run.
const isBroker = (tracker, e) => e.t >= tracker.since && tracker.brokerPids().has(e.pid) && BROKER_CMD.test(norm(e.cmd))

/** The pids of `start pid N` lines in a broker.log, read fresh each time (the file is small and may not exist). */
export const brokerPidsOf = logFile => () => {
  try {
    return new Set([...fs.readFileSync(logFile, 'utf8').matchAll(/start pid (\d+)/g)].map(m => Number(m[1])))
  } catch {
    return new Set()
  }
}

/** Whether the share switch is on for hosts with this environment and this top-level `share` of the config. */
export const shareIsOn = (env, configShare) =>
  env.TOOLSCRIPT_SHARE === '1' ||
  ((env.TOOLSCRIPT_SHARE === undefined || env.TOOLSCRIPT_SHARE === '') && configShare === true)

const classify = (tracker, entry, parent) => {
  const cmd = norm(entry.cmd)
  if (cmd.includes('runner.mjs')) return { role: 'runner', key: null }
  const group = tracker.groups.find(g => cmd.includes(g.needle) && g.args.every(a => cmd.includes(a)))
  if (group) return { role: `server ${group.keys.join('+')}`, key: group.keys.join('+') }
  if (parent.role.startsWith('server ') || parent.role === 'runner') return { role: parent.role, key: parent.key }
  return { role: parent.role === 'broker' ? 'broker' : 'other', key: null }
}

export const update = (tracker, table) => {
  const alive = []
  const byPid = new Map()
  // Creation times tie on macOS (1 s resolution), so a child can come before its parent in this order. A pass that
  // leaves rows unattached runs again over those rows, until a pass attaches nothing more.
  let open = [...table].sort((a, b) => a.t - b.t || a.pid - b.pid)
  while (open.length > 0) {
    const next = []
    for (const e of open) {
      const id = `${e.pid}:${e.t}`
      let info = tracker.known.get(id)
      if (!info) {
        const parent = byPid.get(e.ppid)
        const session = tracker.hosts.get(e.pid)
        if (session !== undefined && e.ppid === process.pid) {
          info = { session, role: 'host', key: null }
        } else if (isBroker(tracker, e)) {
          // A broker is its own tree, also while the host that started it lives and is its parent: it belongs to no
          // session, and it counts once in the union.
          info = { session: null, role: 'broker', key: null }
        } else if (parent !== undefined && parent.t <= e.t) {
          // A child is never older than its parent. An older row only holds a stale ppid that a new process reused.
          info = { session: parent.session, ...classify(tracker, e, parent) }
        } else {
          next.push(e)
          continue
        }
        info = { ...info, pid: e.pid, ppid: e.ppid, t: e.t, image: e.name }
        tracker.known.set(id, info)
      }
      info.pb = e.pb
      info.ws = e.ws
      byPid.set(e.pid, info)
      alive.push(info)
    }
    if (next.length === open.length) break
    open = next
  }
  return alive
}

const procRow = i => ({
  pid: i.pid,
  ppid: i.ppid,
  session: i.session,
  role: i.role,
  key: i.key,
  image: i.image,
  pb: i.pb,
  ws: i.ws,
})
const total = (procs, field) =>
  procs.length > 0 && procs.every(p => p[field] === null) ? null : sum(procs.map(p => p[field] ?? 0))

const killTree = pids =>
  Promise.all(
    pids.map(
      pid =>
        new Promise(resolve => {
          if (process.platform === 'win32') {
            const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            child.on('error', resolve)
            child.on('close', resolve)
          } else {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
            resolve()
          }
        }),
    ),
  )

// Ends what a table read shows alive. Only a process that `update` attributed is ended: a host, a broker, or a
// descendant of one.
const endAlive = async tracker => {
  const alive = update(tracker, await readTable())
  const pids = new Set(alive.map(i => i.pid))
  // taskkill /T takes the descendants, so only the roots go by tree. Elsewhere each process is ended by pid.
  const targets = process.platform === 'win32' ? alive.filter(i => !pids.has(i.ppid)) : alive
  await killTree(targets.map(i => i.pid))
  return alive
}

// One session: a host over stdio and the MCP client of this script.

class Session {
  constructor(n, command, args, env, cwd) {
    this.n = n
    this.exit = undefined
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    // The wake lines of the host, as {key, ms}: nothing else of its stderr is kept.
    this.wakes = []
    this.errBuffer = ''
    this.exited = new Promise(resolve => {
      this.child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      this.pid = this.child.pid
      this.child.on('error', err => {
        this.exit ??= { code: null, error: err.code ?? 'spawn' }
        this.fail()
        resolve()
      })
      this.child.on('exit', code => {
        this.exit ??= { code }
        this.fail()
        resolve()
      })
    })
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('error', () => {})
    this.child.stderr.on('data', d => {
      this.errBuffer += d
      let i
      while ((i = this.errBuffer.indexOf('\n')) >= 0) {
        const m = WAKE_LINE.exec(this.errBuffer.slice(0, i).replace(/\r$/, ''))
        this.errBuffer = this.errBuffer.slice(i + 1)
        if (m) this.wakes.push({ key: m[1], ms: Number(m[2]) })
      }
      // A line that never ends is not kept.
      if (this.errBuffer.length > 65536) this.errBuffer = ''
    })
    this.child.stdout.on('data', d => {
      this.buffer += d
      let i
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i)
        this.buffer = this.buffer.slice(i + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          clearTimeout(waiter.timer)
          waiter.resolve(msg)
        }
      }
    })
  }
  fail() {
    for (const w of this.pending.values()) {
      clearTimeout(w.timer)
      w.reject(new Error('the host ended'))
    }
    this.pending.clear()
  }
  request(method, params, timeout) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('no answer in time'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }
  end() {
    this.child.stdin.end()
  }
}

/** Memory a new process can use, in MB: process.availableMemory() where Node has it, else os.freemem(). */
const freeMb = () => (typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem()) / MB

const ms = t0 => Math.round(performance.now() - t0)

const RUN_FIXTURE = [
  'const r = await Promise.all([',
  ...ALL_KEYS.map(k => `  call("mcp__${k}__list_issues", { project: "OPS" }),`),
  '])',
  'return r.map(x => x.total)',
].join('\n')
const RUN_REAL = 'return 1'

const startSession = async (ctx, n) => {
  const rec = { n, ok: false }
  const t0 = performance.now()
  const folder = ctx.folders.length === 0 ? undefined : ctx.folders[(n - 1) % ctx.folders.length]
  if (folder !== undefined) rec.folder = (n - 1) % ctx.folders.length
  const s = new Session(n, process.execPath, [MAIN, '--config', ctx.configFile], ctx.env, folder)
  ctx.live.add(s)
  rec.pid = s.pid
  try {
    ctx.tracker.hosts.set(s.pid, n)
    await s.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'toolscript-memory-bench', version: '0' },
      },
      LIMIT,
    )
    rec.initializeMs = ms(t0)
    s.notify('notifications/initialized')
    await s.request('tools/list', {}, LIMIT)
    rec.toolsListMs = ms(t0)
    rec.ok = true
  } catch {
    // Wait a moment: a host that exits at once has its code by then.
    await Promise.race([s.exited, sleep(500)])
    rec.exitCode = s.exit?.code ?? null
    rec.error = s.exit ? 'exited' : 'no answer in time'
    log(`session ${n} failed to start (${s.exit ? `exit code ${s.exit.code ?? s.exit.error}` : 'no answer in time'})`)
  }
  return { s, rec }
}

/**
 * Reads the "## Not connected" section of a search_tools result into the keys that are still connecting and the keys
 * that failed. A slow server is the line `- <key>: still connecting. Search again in a moment.` (notConnectedText in
 * src/core/catalog.ts, which tests/bench.test.ts runs against this); any other line of the section is a failure.
 */
export const parseNotConnected = (text, keys) => {
  const section = text.split('## Not connected\n')[1] ?? ''
  const lines = section.split('\n').filter(l => l.startsWith('- '))
  const keyOf = l => keys.find(k => l.startsWith(`- ${k}: `))
  const slow = l => /^- [^:]+: still connecting\./.test(l)
  return {
    connecting: lines.filter(slow).map(keyOf).filter(Boolean),
    failed: lines
      .filter(l => !slow(l))
      .map(keyOf)
      .filter(Boolean),
  }
}

/** A query that no tool holds: search_tools then lists the tool names of each server instead of matches. */
export const NO_MATCH = 'zqxbenchnomatchqzx'

/**
 * The tool count of each key from the search_tools result of NO_MATCH: the line `mcp__<key>__: a, b (+N more)` of each
 * server (namesByServer in src/core/catalog.ts, which tests/bench.test.ts runs against this) holds the names that it
 * shows and the count of the rest. A key with no line has no tool. Undefined when the text is not that form.
 */
export const parseToolCounts = (text, keys) => {
  if (!/^No MCP tool matches /.test(text)) return undefined
  const lines = text.split('\n')
  return Object.fromEntries(
    keys.map(k => {
      const head = `mcp__${k}__: `
      const line = lines.find(l => l.startsWith(head))
      if (line === undefined) return [k, 0]
      const more = / \(\+(\d+) more\)$/.exec(line)
      const names = line.slice(head.length, more?.index).split(', ')
      return [k, names.length + Number(more?.[1] ?? 0)]
    }),
  )
}

// Calls search_tools until no server is connecting. Records keys only: a failure reason can hold a URL.
const connect = async (ctx, s, rec) => {
  const keys = new Set(ctx.keys)
  const deadline = Date.now() + LIMIT
  let connecting = []
  let failed = []
  while (true) {
    let text = ''
    try {
      const reply = await s.request('tools/call', { name: 'search_tools', arguments: { query: '' } }, LIMIT)
      text = reply.result?.content?.[0]?.text ?? ''
    } catch {
      rec.ok = false
      rec.error = 'search_tools failed'
      return
    }
    ;({ connecting, failed } = parseNotConnected(text, ctx.keys))
    if (connecting.length === 0 || Date.now() > deadline) break
    await sleep(500)
  }
  if (connecting.length > 0) rec.connectTimeout = true
  rec.failed = [...new Set([...failed, ...connecting])].filter(k => keys.has(k)).sort()
  rec.connected = ctx.keys.filter(k => !rec.failed.includes(k))
  // The tool count of each connected key. A list of all tools stops at 100, so the count comes from the names by server.
  try {
    const reply = await s.request('tools/call', { name: 'search_tools', arguments: { query: NO_MATCH } }, LIMIT)
    const counts = parseToolCounts(reply.result?.content?.[0]?.text ?? '', rec.connected)
    if (counts !== undefined) rec.tools = counts
  } catch {}
}

/**
 * The value that a run_code result shows: the text before the footer, also when the run read untrusted content and the
 * host put the text in the wrapper of formatOutcome (src/core/protocol.ts, which tests/bench.test.ts runs against this).
 * Undefined when that text is not JSON.
 */
export const runValue = text => {
  const wrapped = /^<<([0-9a-f]+)>> \[UNTRUSTED TOOL CONTENT[^\n]*\n([\s\S]*?)\n<<\/\1>>/.exec(text)
  try {
    return JSON.parse((wrapped?.[2] ?? text).split('\n\n---')[0])
  } catch {
    return undefined
  }
}

/** The program of --call: a status for each tool and nothing else, so that no result reaches the output. */
const callProgram = tools =>
  [
    `const tools = ${JSON.stringify(tools)}`,
    'const out = {}',
    "for (const t of tools) { try { await call(t, {}); out[t] = 'ok' } catch { out[t] = 'failed' } }",
    'return out',
  ].join('\n')

const keyOfTool = (ctx, tool) => ctx.keys.find(k => tool.startsWith(`mcp__${k}__`))

/** Runs the --call tools in one session and records ok or failed for each server key. */
const callTools = async (ctx, s, rec) => {
  const status = {}
  try {
    const reply = await s.request(
      'tools/call',
      { name: 'run_code', arguments: { code: callProgram(ctx.calls) } },
      ctx.runLimit,
    )
    const out = runValue(reply.result?.content?.[0]?.text ?? '') ?? {}
    for (const tool of ctx.calls) {
      const key = keyOfTool(ctx, tool)
      status[key] = status[key] === 'failed' || out[tool] !== 'ok' ? 'failed' : 'ok'
    }
  } catch {
    for (const tool of ctx.calls) status[keyOfTool(ctx, tool)] = 'failed'
  }
  rec.calls = status
}

const sample = async (ctx, round, phase) => {
  const alive = update(ctx.tracker, await readTable())
  const procs = alive.map(procRow)
  round.samples[phase] = {
    freeMb: Math.round(freeMb()),
    processes: procs.length,
    privateBytes: total(procs, 'pb'),
    workingSetPrivate: total(procs, 'ws'),
    unmeasured: procs.filter(p => p.pb === null && p.ws === null).length,
    procs,
  }
  log(`  sample ${phase}: ${procs.length} processes`)
}

const closeAll = async sessions => {
  for (const s of sessions) s.end()
  let timer
  const limit = new Promise(resolve => {
    timer = setTimeout(resolve, EXIT_WAIT)
  })
  await Promise.race([Promise.all(sessions.map(s => s.exited)), limit])
  clearTimeout(timer)
}

/** The entries of the tool cache that the hosts of the home wrote: one for each lazy server that connected. */
const cachedEntries = home => {
  try {
    const file = path.join(home, '.toolscript-mcp', 'learned', 'tools.json')
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? {}).length
  } catch {
    return 0
  }
}

/**
 * Fixture mode with lazy start on: one host fills the tool cache of the two lazy servers before round 1, as the first
 * session after an install does. A host with a cache has no lazy child until a call. It runs with sharing off, so it
 * leaves no broker for the rounds. Nothing of it goes into the data.
 */
const warmUp = async (ctx, home) => {
  log('warm-up: one host fills the tool cache of the lazy servers')
  ctx.tracker = newTracker(ctx.groups.groups, Date.now() - 2000, () => new Set())
  const warm = { ...ctx, env: { ...ctx.env, TOOLSCRIPT_SHARE: '0' } }
  const { s, rec } = await startSession(warm, 0)
  if (!rec.ok) log('warm-up: the host did not start')
  if (rec.ok) {
    await connect(ctx, s, rec)
    const end = Date.now() + LIMIT
    while (cachedEntries(home) < 2 && Date.now() < end) await sleep(200)
    if (cachedEntries(home) < 2) log('warm-up: the tool cache has fewer than 2 entries')
  }
  await closeAll([s])
  ctx.live.delete(s)
  await sleep(1000)
  await endAlive(ctx.tracker)
  ctx.tracker = undefined
  log(`warm-up: ${cachedEntries(home)} cache entries`)
}

const runRound = async (ctx, data, count) => {
  const round = { count, sessions: [], samples: {}, leftovers: [] }
  data.rounds.push(round)
  ctx.tracker = newTracker(ctx.groups.groups, Date.now() - 2000, ctx.brokerPids)
  log(`round ${count}: start`)
  const sessions = []
  for (let k = 1; k <= count; k++) {
    const free = freeMb()
    if (free < ctx.minFree) {
      round.stoppedAt = k - 1
      log(`  stopped at ${k - 1} sessions: free RAM ${Math.round(free)} MB is below ${ctx.minFree} MB`)
      break
    }
    const { s, rec } = await startSession(ctx, k)
    round.sessions.push(rec)
    if (rec.ok) {
      sessions.push(s)
      await connect(ctx, s, rec)
      log(
        `  session ${k} host pid ${s.pid}: initialize ${rec.initializeMs} ms, tools/list ${rec.toolsListMs} ms, ${rec.connected?.length ?? 0} connected, ${rec.failed?.length ?? 0} failed`,
      )
    } else {
      s.end()
    }
  }
  if (sessions.length > 0) {
    log(`  idle: ${ctx.idle} s with no traffic`)
    await sleep(ctx.idle * 1000)
    await sample(ctx, round, 'idle')
    log('  run: one run_code per session, then the same program again')
    for (const s of sessions) {
      const rec = round.sessions[s.n - 1]
      for (const field of ['run1Ms', 'run2Ms']) {
        const t0 = performance.now()
        try {
          const reply = await s.request(
            'tools/call',
            { name: 'run_code', arguments: { code: ctx.program } },
            ctx.runLimit,
          )
          rec[field] = ms(t0)
          const text = reply.result?.content?.[0]?.text ?? ''
          const good =
            !reply.result?.isError && (ctx.expect === undefined || text.replace(/\s/g, '').startsWith(ctx.expect))
          rec.runOk = (rec.runOk ?? true) && good
        } catch {
          rec.runOk = false
        }
      }
    }
    if (ctx.calls.length > 0) {
      log('  run: each --call tool once per session')
      for (const s of sessions) await callTools(ctx, s, round.sessions[s.n - 1])
    }
    log(`  after-run: ${ctx.afterRun} s`)
    await sleep(ctx.afterRun * 1000)
    await sample(ctx, round, 'after-run')
    if (ctx.afterIdle > 0) {
      log(`  after-idle: ${ctx.afterIdle} s with no traffic`)
      await sleep(ctx.afterIdle * 1000)
      await sample(ctx, round, 'after-idle')
      log('  run: the same program once more')
      for (const s of sessions) {
        const rec = round.sessions[s.n - 1]
        const t0 = performance.now()
        try {
          const reply = await s.request(
            'tools/call',
            { name: 'run_code', arguments: { code: ctx.program } },
            ctx.runLimit,
          )
          rec.run3Ms = ms(t0)
          const text = reply.result?.content?.[0]?.text ?? ''
          rec.afterIdleOk =
            !reply.result?.isError && (ctx.expect === undefined || text.replace(/\s/g, '').startsWith(ctx.expect))
        } catch {
          rec.afterIdleOk = false
        }
      }
    }
    for (const s of sessions) round.sessions[s.n - 1].wakes = s.wakes
  }
  log('  closed: end of stdin of every host')
  await closeAll(sessions)
  for (const s of sessions) {
    const rec = round.sessions[s.n - 1]
    rec.exitCode = s.exit?.code ?? null
    ctx.live.delete(s)
  }
  await sleep(ctx.closed * 1000)
  const left = update(ctx.tracker, await readTable())
  round.leftovers = left.map(procRow)
  log(`  leftovers: ${left.length}`)
  if (left.length > 0) {
    log('  ending the leftovers by tree')
    await endAlive(ctx.tracker)
    round.leftoversEnded = true
  }
  ctx.tracker = undefined
}

// The report. Every table is rendered from the data object, so --report prints the same text as a run.

const mbOf = n => (n === null || n === undefined ? null : n / MB)
const fmt = (n, digits = 1) => (n === null || n === undefined ? 'not measured' : n.toFixed(digits))
let headlineMark = MEMORY_NOTE.headline
const fmtHeadline = n => (n === null || n === undefined ? headlineMark : n.toFixed(1))
const spread = list =>
  list.length === 0
    ? '-'
    : list.length === 1
      ? String(list[0])
      : `${Math.round(median(list))} (${Math.min(...list)} to ${Math.max(...list)})`

const copiesOf = (procs, allKeys) => {
  const roleOf = new Map(procs.map(p => [p.pid, p.role]))
  const byKey = new Map()
  for (const p of procs) {
    if (!p.role.startsWith('server ')) continue
    const entry = byKey.get(p.role) ?? { copies: 0, images: new Map() }
    if (roleOf.get(p.ppid) !== p.role) entry.copies++
    entry.images.set(p.image, (entry.images.get(p.image) ?? 0) + 1)
    byKey.set(p.role, entry)
  }
  const cells = [...byKey].map(
    ([role, e]) => `${role.slice(7)}: ${e.copies} copies, ${[...e.images].map(([i, c]) => `${i} ${c}`).join(' ')}`,
  )
  const seen = new Set([...byKey.keys()].flatMap(r => r.slice(7).split('+')))
  for (const k of allKeys) if (!seen.has(k)) cells.push(`${k}: 0 processes`)
  return cells.join('; ')
}

const countBy = list => {
  const m = new Map()
  for (const p of list) m.set(`${p.role} ${p.image}`, (m.get(`${p.role} ${p.image}`) ?? 0) + 1)
  return [...m].map(([k, c]) => `${k} ${c}`).join(', ')
}

export const render = data => {
  headlineMark = data.meta.memory.headline
  const m = data.meta
  const lines = [
    `## Memory bench ${m.date}`,
    '',
    `${m.date}, ${m.os}, Node ${m.node}, commit ${m.commit}, mode ${m.mode}, idle ${m.idleSeconds} s, RAM ${m.ramTotalMb} MB total and ${m.ramFreeMb} MB free at the start.`,
    '',
    `Memory is ${m.memory.headline} in the headline columns and ${m.memory.second} in the second. MB is 1,048,576 bytes. A process counts once, by pid and creation time, over every tree of the round.`,
    '',
    '| sessions | phase | private bytes total (MB) | per session (MB) | private working set total (MB) | processes | copies per server key | leftovers |',
    '| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ]
  for (const r of data.rounds) {
    const ok = r.sessions.filter(s => s.ok).length
    const label = r.stoppedAt === undefined ? String(ok) : `${ok} (stopped at ${r.stoppedAt} sessions)`
    const left = r.leftovers.length === 0 ? 'none' : `${r.leftovers.length}: ${countBy(r.leftovers)}`
    for (const phase of ['idle', 'after-run', 'after-idle']) {
      const s = r.samples[phase]
      if (!s) continue
      const pb = mbOf(s.privateBytes)
      lines.push(
        `| ${label} | ${phase} | ${fmtHeadline(pb)} | ${pb === null || ok === 0 ? fmtHeadline(null) : fmt(pb / ok)} | ${fmt(mbOf(s.workingSetPrivate))} | ${s.processes} | ${copiesOf(s.procs, data.meta.keys)} | ${left} |`,
      )
    }
  }
  const failedRounds = data.rounds.flatMap(r =>
    r.sessions
      .filter(
        s => !s.ok || s.runOk === false || s.afterIdleOk === false || (s.failed?.length ?? 0) > 0 || s.connectTimeout,
      )
      .map(s => ({ count: r.count, s })),
  )
  const notes = []
  for (const { count, s } of failedRounds) {
    if (!s.ok)
      notes.push(`round ${count} session ${s.n}: failed to start (${s.error}, exit code ${s.exitCode ?? 'none'})`)
    else {
      if (s.runOk === false) notes.push(`round ${count} session ${s.n}: a run_code failed or gave a wrong result`)
      if (s.afterIdleOk === false)
        notes.push(`round ${count} session ${s.n}: the run_code after the idle phase failed or gave a wrong result`)
      if (s.connectTimeout)
        notes.push(`round ${count} session ${s.n}: a server was still connecting after ${LIMIT / 1000} s`)
    }
  }
  const failedKeys = [...new Set(data.rounds.flatMap(r => r.sessions.flatMap(s => s.failed ?? [])))].sort()
  if (failedKeys.length > 0) notes.push(`servers that failed to connect (by key): ${failedKeys.join(', ')}`)
  const unmeasured = data.rounds.reduce((n, r) => n + sum(Object.values(r.samples).map(s => s.unmeasured)), 0)
  if (unmeasured > 0) notes.push(`${unmeasured} process rows had no memory figure and count as 0`)
  if (data.rounds.some(r => r.leftoversEnded)) notes.push('the bench ended each leftover by tree after it listed them')
  if (data.meta.folders > 0) notes.push(`session k started in folder k modulo ${data.meta.folders}`)
  if (notes.length > 0) lines.push('', ...notes.map(n => `- ${n}`))

  const served = data.rounds.filter(r => r.sessions.some(s => s.connected !== undefined))
  if (served.length > 0) {
    lines.push(
      '',
      '### Servers',
      '',
      '| sessions | key | connected | failed | tools | calls |',
      '| ---: | --- | ---: | ---: | --- | --- |',
    )
    for (const r of served) {
      const ok = r.sessions.filter(x => x.ok)
      for (const key of data.meta.keys) {
        const connected = ok.filter(x => x.connected?.includes(key))
        const failed = ok.filter(x => x.failed?.includes(key))
        const counts = connected.map(x => x.tools?.[key]).filter(n => n !== undefined)
        const called = ok.filter(x => x.calls?.[key] !== undefined)
        const calls =
          called.length === 0
            ? '-'
            : `${called.filter(x => x.calls[key] === 'ok').length} ok, ${called.filter(x => x.calls[key] === 'failed').length} failed`
        lines.push(`| ${ok.length} | ${key} | ${connected.length} | ${failed.length} | ${spread(counts)} | ${calls} |`)
      }
    }
  }

  // The wake time of each lazy server, from the log line of the host: the time of its start for the first call.
  const woken = data.rounds.filter(r => r.sessions.some(s => (s.wakes?.length ?? 0) > 0))
  if (woken.length > 0) {
    lines.push(
      '',
      '### Wake time (ms)',
      '',
      '| sessions | key | wakes | median (min to max) |',
      '| ---: | --- | ---: | --- |',
    )
    for (const r of woken) {
      const all = r.sessions.flatMap(s => s.wakes ?? [])
      for (const key of [...new Set(all.map(w => w.key))].sort()) {
        const times = all.filter(w => w.key === key).map(w => w.ms)
        lines.push(`| ${r.sessions.filter(x => x.ok).length} | ${key} | ${times.length} | ${spread(times)} |`)
      }
    }
  }

  const last = [...data.rounds].reverse().find(r => r.samples.idle)
  if (last) {
    const procs = last.samples.idle.procs
    const groups = new Map()
    for (const p of procs) {
      const id = `${p.role}\0${p.image}`
      const g = groups.get(id) ?? { role: p.role, image: p.image, list: [] }
      g.list.push(p)
      groups.set(id, g)
    }
    lines.push(
      '',
      `### Per role, ${last.sessions.filter(s => s.ok).length} sessions, idle`,
      '',
      '| role | image | processes | private bytes total (MB) | private bytes each, median (min to max) (MB) | private working set each, median (MB) |',
      '| --- | --- | ---: | ---: | --- | ---: |',
    )
    const each = (list, f) => (list.some(x => f(x) === null) ? null : list.map(x => f(x) / MB))
    const rowsOut = [...groups.values()].sort((a, b) => a.role.localeCompare(b.role) || a.image.localeCompare(b.image))
    for (const g of rowsOut) {
      const pb = each(g.list, p => p.pb)
      const ws = each(g.list, p => p.ws)
      lines.push(
        `| ${g.role} | ${g.image} | ${g.list.length} | ${pb ? fmt(sum(pb)) : fmtHeadline(null)} | ${pb ? `${fmt(median(pb))} (${fmt(Math.min(...pb))} to ${fmt(Math.max(...pb))})` : fmtHeadline(null)} | ${ws ? fmt(median(ws)) : fmt(null)} |`,
      )
    }
    const pbTotal = mbOf(last.samples.idle.privateBytes)
    lines.push(`| total | | ${procs.length} | ${fmtHeadline(pbTotal)} | | |`)
  }

  lines.push(
    '',
    '### Timings (ms)',
    '',
    '| sessions | measure | session 1 | sessions 2 to N, median (min to max) |',
    '| ---: | --- | ---: | --- |',
  )
  for (const r of data.rounds) {
    for (const [field, name] of [
      ['initializeMs', 'initialize'],
      ['toolsListMs', 'tools/list'],
      ['run1Ms', 'first run_code'],
      ['run2Ms', 'second run_code'],
    ]) {
      const first = r.sessions.find(s => s.n === 1)?.[field]
      const rest = r.sessions.filter(s => s.n > 1 && s[field] !== undefined).map(s => s[field])
      lines.push(`| ${r.count} | ${name} | ${first ?? '-'} | ${spread(rest)} |`)
    }
  }
  lines.push(
    '',
    `run_code program: ${m.program}. Times run from spawn for initialize and tools/list, and from the request to the result for run_code.`,
  )
  return lines.join('\n')
}

// Setup

const fixtureConfig = cwd => {
  const extra = { bench1: { share: true }, bench2: { cwd }, bench3: {}, bench4: { share: false, lazy: true } }
  const servers = Object.fromEntries(
    FIXTURE_KEYS.map(k => [
      k,
      {
        command: process.execPath,
        args: [FAKE_SERVER, k, `--note=${MARKER}`],
        env: { BENCH_NOTE: MARKER },
        ...extra[k],
      },
    ]),
  )
  servers[BRIDGE_KEY] = {
    command: process.execPath,
    args: [FAKE_SERVER, BRIDGE_KEY, `--note=${MARKER}`],
    env: { BENCH_NOTE: MARKER },
  }
  // An HTTP entry that nothing answers: it costs no process, and holds a header and a URL for the secrets test.
  servers.down = { type: 'http', url: `http://127.0.0.1:9/${MARKER}`, headers: { 'X-Bench-Note': MARKER } }
  return {
    sandbox: { timeoutSeconds: 30, callTimeoutSeconds: 20 },
    policy: ALL_KEYS.map(k => ({ match: `mcp__${k}__list_issues`, action: 'allow' })),
    mcpServers: servers,
  }
}

const DIR_PREFIX = 'toolscript-memory-'
const STALE_DIR = /^toolscript-memory-(\d+)-(\d+)-/

/** Removes the temp dirs of benches that no longer live: no process has the pid and creation time in the name. */
const sweepStale = table => {
  const live = new Set(table.map(r => `${r.pid}:${r.t}`))
  const base = os.tmpdir()
  for (const name of fs.readdirSync(base)) {
    const m = STALE_DIR.exec(name)
    if (!m || live.has(`${m[1]}:${m[2]}`)) continue
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true, maxRetries: 5 })
    } catch {}
  }
}

const commitOf = () => {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

const parseOptions = () => {
  try {
    return parseArgs({
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        counts: { type: 'string' },
        idle: { type: 'string' },
        'after-run': { type: 'string' },
        'after-idle': { type: 'string' },
        closed: { type: 'string' },
        'min-free-mb': { type: 'string' },
        json: { type: 'string' },
        report: { type: 'string' },
        config: { type: 'string' },
        folders: { type: 'string' },
        call: { type: 'string', multiple: true },
      },
    }).values
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`)
    process.exit(2)
  }
}

const bad = text => {
  console.error(`${text}\n${USAGE}`)
  process.exit(2)
}

const main = async () => {
  const opts = parseOptions()
  if (opts.help) return void console.log(USAGE)
  if (opts.report !== undefined) {
    let data
    try {
      data = JSON.parse(fs.readFileSync(opts.report, 'utf8'))
    } catch {
      return bad('--report: the file is missing or is not JSON')
    }
    return void console.log(render(data))
  }
  const counts = (opts.counts ?? '1,3,6').split(',').map(Number)
  if (counts.some(c => !Number.isInteger(c) || c < 1 || c > 64))
    bad('--counts: whole numbers from 1 to 64, separated by commas')
  const seconds = (name, fallback) => {
    const value = Number(opts[name] ?? fallback)
    if (!Number.isFinite(value) || value < 0) bad(`--${name}: a number of seconds, 0 or more`)
    return value
  }
  const idle = seconds('idle', 60)
  const afterRun = seconds('after-run', 5)
  // The phase after-idle runs past the idle time of a lazy server: its seconds come from the variable that shortens it.
  const idleEnv = Number(process.env.TOOLSCRIPT_LAZY_IDLE_MS)
  const afterIdle = seconds(
    'after-idle',
    Number.isFinite(idleEnv) && idleEnv >= 1000 ? Math.ceil(idleEnv / 1000) + 5 : 0,
  )
  const closed = seconds('closed', 10)
  const minFree = Number(opts['min-free-mb'] ?? 2048)
  if (!Number.isFinite(minFree) || minFree < 0) bad('--min-free-mb: a number of megabytes, 0 or more')
  const real = opts.config !== undefined
  const calls = opts.call ?? []
  if (calls.length > 0 && !real) bad('--call: real mode only (with --config)')
  const folderNames = opts.folders === undefined ? [] : opts.folders.split(',')
  if (opts.folders !== undefined && (folderNames.some(n => n === '') || folderNames.length > 64))
    bad('--folders: names or paths separated by commas, at most 64')
  if (!fs.existsSync(MAIN)) {
    console.error('dist/host/main.js is missing: run npm run build first')
    process.exit(1)
  }

  let root
  let configFile
  let env = process.env
  let servers
  let folders = []
  let configShare
  let home = os.homedir()
  if (real) {
    configFile = path.resolve(opts.config)
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      servers = parsed.mcpServers ?? {}
      configShare = parsed.share
    } catch {
      return bad('--config: the file is missing or is not JSON')
    }
    folders = folderNames.map(n => path.resolve(n))
    for (const folder of folders)
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return bad('--folders: a folder does not exist')
    for (const tool of calls)
      if (!Object.keys(servers).some(k => tool.startsWith(`mcp__${k}__`)))
        return bad('--call: a tool id must start with mcp__<key>__ of a server of the config')
  } else {
    // A temp home and temp dir, as in tests/server.e2e.mjs: the real run log, shapes file and OAuth store stay out of it.
    // The dir name holds this script's pid and creation time. A hard kill leaves the dir, so each start removes the
    // dirs whose owner no longer lives with that creation time.
    const table = await readTable()
    sweepStale(table)
    const own = table.find(r => r.pid === process.pid)?.t ?? 0
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${DIR_PREFIX}${process.pid}-${own}-`)))
    home = path.join(root, 'home')
    const tmp = path.join(root, 'tmp')
    fs.mkdirSync(home)
    fs.mkdirSync(tmp)
    fs.mkdirSync(path.join(root, 'cwd'))
    folders = folderNames.map((_, i) => {
      const folder = path.join(root, 'folders', `f${i}`)
      fs.mkdirSync(folder, { recursive: true })
      return folder
    })
    const config = fixtureConfig(path.join(root, 'cwd'))
    servers = config.mcpServers
    configFile = path.join(root, 'config.json')
    fs.writeFileSync(configFile, JSON.stringify(config))
    configShare = config.share
    env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp }
  }
  const groups = stdioGroups(servers)
  const ctx = {
    configFile,
    env,
    groups,
    keys: Object.keys(servers),
    idle,
    afterRun,
    afterIdle,
    closed,
    minFree,
    folders,
    calls,
    live: new Set(),
    tracker: undefined,
    // Only with the switch on is a broker attributed, and only a pid that the broker.log of this home names.
    brokerPids: shareIsOn(env, configShare)
      ? brokerPidsOf(path.join(home, '.toolscript-mcp', 'broker', 'broker.log'))
      : () => new Set(),
    program: real ? RUN_REAL : RUN_FIXTURE,
    expect: real ? undefined : JSON.stringify(ALL_KEYS.map(() => ISSUES.length)),
    runLimit: 45_000,
  }
  const data = {
    meta: {
      date: new Date().toLocaleDateString('sv'), // the local date as YYYY-MM-DD
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      node: process.version,
      commit: commitOf(),
      mode: real ? 'real' : 'fixture',
      idleSeconds: idle,
      afterIdleSeconds: afterIdle,
      ramTotalMb: Math.round(os.totalmem() / MB),
      ramFreeMb: Math.round(freeMb()),
      keys: ctx.keys,
      folders: folders.length,
      memory: MEMORY_NOTE,
      program: real
        ? calls.length === 0
          ? 'real: `return 1`, no tool call'
          : `real: \`return 1\`, then ${calls.length} tool call${calls.length === 1 ? '' : 's'} (--call) in each session`
        : 'fixture: one list_issues call on each of the 5 servers, checked',
    },
    rounds: [],
  }

  // Ctrl+C, SIGTERM and an error end the hosts by their stdin, wait, end what remains by tree, remove the temp dir
  // and write what was measured. A hard kill of this script needs none of it: each host ends with its stdin.
  let aborting = false
  const abort = async code => {
    if (aborting) return
    aborting = true
    log('aborting: ending the hosts')
    const sessions = [...ctx.live]
    for (const s of sessions) s.end()
    await Promise.race([Promise.all(sessions.map(s => s.exited)), sleep(STDIN_WAIT)])
    if (ctx.tracker) {
      try {
        await endAlive(ctx.tracker)
      } catch {
        log('the leftovers could not be listed')
      }
    }
    let exit = code
    try {
      if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      log('the temp dir could not be removed')
    }
    try {
      if (opts.json) fs.writeFileSync(opts.json, JSON.stringify({ ...data, aborted: true }))
    } catch {
      log('--json: the file could not be written')
      exit ||= 1
    }
    process.exit(exit)
  }
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGBREAK', 130],
    ['SIGHUP', 129],
  ]) {
    process.on(signal, () => void abort(code))
  }
  process.on('uncaughtException', err => {
    log(`error: ${err?.code ?? err?.name ?? 'unknown'}`)
    void abort(1)
  })
  process.on('unhandledRejection', err => {
    log(`error: ${err?.code ?? err?.name ?? 'unknown'}`)
    void abort(1)
  })

  if (!real && env.TOOLSCRIPT_LAZY !== '0') await warmUp(ctx, home)
  const started = Date.now()
  for (const count of counts) await runRound(ctx, data, count)
  data.meta.wallSeconds = Math.round((Date.now() - started) / 1000)
  try {
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    log('the temp dir could not be removed')
  }
  // The report first: a bad --json path still gives it, and then the exit code is 1.
  console.log(render(data))
  try {
    if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(data))
  } catch {
    log('--json: the file could not be written')
    process.exitCode = 1
  }
  log(`done in ${data.meta.wallSeconds} s`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main()
