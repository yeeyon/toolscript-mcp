// Probe for a rare macOS CI failure: the CPU limit of the sandbox (ulimit -t)
// sometimes loses to the host kill timer, so the busy loop of
// tests/runner.integration.mjs ends as { kind: 'timeout' }. This script runs
// that busy loop many times, between variants that each drop one part of the
// launch, and reads each process's CPU time with ps while it runs.
//
//   node scripts/probe-cpu-limit.mjs [--rounds 45] [--minutes 10]
//
// It lives only on the branch macos-cpu-probe, which is never merged.

import { execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Node 22.13 imports a .ts file only with type stripping, the same as the integration test.
let launch, makeExchangeDir, removeExchangeDir, KILL_GRACE_MS, RUNNER
try {
  ;({ launch, makeExchangeDir, removeExchangeDir, KILL_GRACE_MS, RUNNER } = await import('../src/host/launch.ts'))
} catch (err) {
  if (process.env.TOOLSCRIPT_STRIP === '1' || err?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err
  const self = fileURLToPath(import.meta.url)
  const again = spawnSync(process.execPath, ['--experimental-strip-types', self, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, TOOLSCRIPT_STRIP: '1' },
    windowsHide: true,
  })
  process.exit(again.status ?? 1)
}

const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}
const ROUNDS = option('rounds', 45)
const MINUTES = option('minutes', 10)
const TIMEOUT_MS = 1000
const POSIX = process.platform !== 'win32'
const DARWIN = process.platform === 'darwin'
// ps reads each run at these ms after the spawn. The last one is before the kill timer at 2000 ms.
const SAMPLE_AT = [300, 1000, 1800]
const BUSY = 'while (true) {}'

// Replaces the runner in variant B: it writes when it started and its CPU so far, then spins.
const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-probe-'))
const STAMP = path.join(stampDir, 'stamp.mjs')
fs.writeFileSync(
  STAMP,
  [
    "import fs from 'node:fs'",
    'const c = process.cpuUsage()',
    "const line = JSON.stringify({ t: Date.now(), up: process.uptime(), cpu: (c.user + c.system) / 1000 }) + '\\n'",
    'try { fs.writeSync(1, line) } catch { process.stdout.write(line) }',
    BUSY,
  ].join('\n'),
)

const FEW_THREADS = ['--v8-pool-size=1', '--single-threaded']
const fewThreads =
  spawnSync(process.execPath, [...FEW_THREADS, '-e', '0'], { windowsHide: true }).status === 0
    ? FEW_THREADS
    : FEW_THREADS.slice(0, 1)

/** Starts the real sandbox launch of src/host/launch.ts with this runner. */
const startLaunch = async runner => {
  const xdir = await makeExchangeDir()
  const spawnedAt = Date.now()
  const sandbox = launch({ node: process.execPath, runner, xdir, timeoutMs: TIMEOUT_MS, code: BUSY })
  return { ...sandbox, spawnedAt, cleanup: () => removeExchangeDir(xdir) }
}

/** Runs a shell script with the same stdin and kill timer as launch: the deadline plus KILL_GRACE_MS. */
const startShell = (script, args, xdir) => {
  const spawnedAt = Date.now()
  const deadline = spawnedAt + TIMEOUT_MS
  const child = spawn('/bin/sh', ['-c', script, 'probe', ...args], { stdio: 'pipe', windowsHide: true })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify({ code: BUSY, lib: {}, timeoutMs: TIMEOUT_MS, deadline }))
  let timedOut = false
  let failed
  const timer = setTimeout(() => (timedOut = child.kill('SIGKILL')), deadline + KILL_GRACE_MS - Date.now())
  child.on('error', error => (failed = error))
  const ended = new Promise(resolve =>
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve(
        failed
          ? { kind: 'failed', error: failed }
          : timedOut
            ? { kind: 'timeout', limitMs: TIMEOUT_MS }
            : { kind: 'exit', code, signal },
      )
    }),
  )
  return { child, ended, spawnedAt, cleanup: async () => xdir && removeExchangeDir(xdir) }
}

// The CPU limit of variants C to F, as launch derives it. --cpu-limit 5 makes them reach the kill timer, to test this script.
const LIMIT = String(option('cpu-limit', Math.ceil(TIMEOUT_MS / 1000)))
const VARIANTS = [
  { key: 'A', name: 'launch + runner', posix: false, start: () => startLaunch(RUNNER) },
  { key: 'B', name: 'launch + stamp', posix: false, start: () => startLaunch(STAMP) },
  {
    key: 'C',
    name: 'no sandbox-exec',
    posix: true,
    start: async () => {
      const xdir = await makeExchangeDir()
      const [runner, real] = [fs.realpathSync(RUNNER), fs.realpathSync(xdir)]
      const script = 'ulimit -t "$1"\nexec env -i "$2" --permission --allow-fs-read="$3" --allow-fs-read="$4" "$3" "$4"'
      return startShell(script, [LIMIT, process.execPath, runner, real], xdir)
    },
  },
  {
    key: 'D',
    name: 'plain node -e',
    posix: true,
    start: async () => startShell(`ulimit -t "$1"\nexec "$2" -e '${BUSY}'`, [LIMIT, process.execPath]),
  },
  {
    key: 'E',
    name: 'node few threads',
    posix: true,
    start: async () =>
      startShell(`ulimit -t "$1"\nexec "$2" ${fewThreads.join(' ')} -e '${BUSY}'`, [LIMIT, process.execPath]),
  },
  {
    key: 'F',
    name: 'sh loop, no node',
    posix: true,
    start: async () => startShell('ulimit -t "$1"\nwhile :; do :; done', [LIMIT]),
  },
].filter(v => POSIX || !v.posix)

const execFileP = promisify(execFile)
const ps = args =>
  execFileP('ps', args, { timeout: 1000, windowsHide: true }).then(
    r => r.stdout,
    () => undefined,
  )

/** ps prints CPU time as [[hh:]mm:]ss.hh. */
const cpuSeconds = text =>
  text
    .split(':')
    .reverse()
    .reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0)

// The processes that used the most CPU, by ps's decaying %CPU: who competed with a run that is still alive late.
const topCpu = async () =>
  (await ps(['-Ao', 'pcpu=,comm=']))
    ?.trim()
    .split('\n')
    .map(line => {
      const [pcpu, ...comm] = line.trim().split(/\s+/)
      return { pcpu: Number(pcpu), comm: path.basename(comm.join(' ')) }
    })
    .sort((a, b) => b.pcpu - a.pcpu)
    .slice(0, 6)
    .map(p => `${p.pcpu}% ${p.comm}`)
    .join(', ')

/** The CPU seconds, state and command of the process, at `at` ms after its spawn, or undefined once it ended. */
const sample = async (pid, spawnedAt, { threads: withThreads = false, top = false } = {}) => {
  const at = Date.now() - spawnedAt
  const [line, threads] = await Promise.all([
    ps(['-o', 'time=,stat=,comm=', '-p', String(pid)]),
    withThreads && DARWIN ? ps(['-M', '-p', String(pid)]) : undefined,
  ])
  if (!line?.trim()) return undefined
  const [time, stat, ...comm] = line.trim().split(/\s+/)
  return {
    at,
    cpu: cpuSeconds(time),
    stat,
    comm: path.basename(comm.join(' ')),
    threads: threads ? threads.trim().split('\n').length - 1 : undefined,
    top: top ? await topCpu() : undefined,
  }
}

const label = ending =>
  ending.kind === 'timeout' ? 'timer' : ending.kind === 'failed' ? 'failed' : (ending.signal ?? `exit ${ending.code}`)

const runOnce = async (variant, n) => {
  const load = os.loadavg()[0]
  const s = await variant.start()
  let stdout = ''
  let stderr = ''
  s.child.stdout.on('data', d => (stdout += d))
  s.child.stderr.on('data', d => (stderr += d))
  let over = false
  const pending = []
  const timers = POSIX
    ? SAMPLE_AT.map(at =>
        setTimeout(
          () =>
            over ||
            pending.push(sample(s.child.pid, s.spawnedAt, { threads: at === 1000, top: at === SAMPLE_AT.at(-1) })),
          s.spawnedAt + at - Date.now(),
        ),
      )
    : []
  const ending = await s.ended
  const wallMs = Date.now() - s.spawnedAt
  over = true
  timers.forEach(clearTimeout)
  const samples = (await Promise.all(pending)).filter(Boolean)
  await s.cleanup()
  let stamp
  try {
    const first = JSON.parse(stdout.split('\n')[0])
    if (typeof first.t === 'number')
      stamp = {
        nodeAt: Math.round(first.t - first.up * 1000 - s.spawnedAt),
        scriptAt: first.t - s.spawnedAt,
        cpu: first.cpu / 1000,
      }
  } catch {}
  return { key: variant.key, n, end: label(ending), wallMs, load, samples, stamp, stderr: stderr.slice(0, 200) }
}

const show = r =>
  [
    `${r.key} ${String(r.n).padStart(3)} ${r.end.padEnd(7)} ${String(r.wallMs).padStart(5)} ms  load ${r.load.toFixed(2)}`,
    ...r.samples.map(
      x =>
        `cpu ${x.cpu.toFixed(2)}@${x.at} ${x.comm} ${x.stat}${x.threads === undefined ? '' : ` ${x.threads}thr`}` +
        (x.top ? ` | top: ${x.top}` : ''),
    ),
    r.stamp && `node@${r.stamp.nodeAt} script@${r.stamp.scriptAt} cpu0 ${r.stamp.cpu.toFixed(2)}`,
    r.stderr && `stderr ${JSON.stringify(r.stderr)}`,
  ]
    .filter(Boolean)
    .join(' | ')

// The share of one core that the process got between the samples at 300 and 1000 ms.
const share = r => {
  const [a, b] = r.samples
  return a && b && b.at > a.at ? (b.cpu - a.cpu) / ((b.at - a.at) / 1000) : undefined
}
const quantile = (xs, q) => {
  const s = xs.filter(x => x !== undefined).sort((a, b) => a - b)
  return s.length === 0 ? '-' : s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
const fixed = x => (typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(2) : x)

const header = () => {
  const sh = cmd => (POSIX ? spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }).stdout.trim() : '')
  console.log(`node ${process.version} ${process.platform} ${process.arch} ${os.release()}`)
  console.log(`cpus ${os.cpus().length} x ${os.cpus()[0]?.model}  loadavg ${os.loadavg().map(fixed).join(' ')}`)
  if (DARWIN)
    console.log(`macOS ${sh('sw_vers -productVersion')}  hv_vmm_present ${sh('sysctl -n kern.hv_vmm_present')}`)
  if (POSIX)
    console.log(`sh: ulimit -t 1 gives soft ${sh('ulimit -t 1; ulimit -St')} hard ${sh('ulimit -t 1; ulimit -Ht')}`)
  console.log(`E flags: ${fewThreads.join(' ')}`)
  for (const v of VARIANTS) console.log(`variant ${v.key}: ${v.name}`)
  console.log(
    'per run: variant n ending wall | cpu <s>@<ms after spawn> <command> <stat> [threads] | B: node@ script@ cpu0',
  )
}

header()
const order = ['A', 'B', 'C', 'A', 'D', 'E', 'A', 'F'].map(k => VARIANTS.find(v => v.key === k)).filter(Boolean)
const results = []
const started = Date.now()
for (let round = 0; round < ROUNDS && Date.now() - started < MINUTES * 60_000; round++) {
  for (const v of order) {
    const r = await runOnce(v, results.filter(x => x.key === v.key).length + 1)
    results.push(r)
    console.log(show(r))
  }
}
fs.rmSync(stampDir, { recursive: true, force: true })

console.log(`\nsummary after ${Math.round((Date.now() - started) / 1000)} s`)
console.log('variant                runs SIGXCPU SIGKILL timer other  signal-end wall p50/max  share p10/p50/min')
for (const v of VARIANTS) {
  const rs = results.filter(r => r.key === v.key)
  const count = end => rs.filter(r => r.end === end).length
  const other = rs.length - count('SIGXCPU') - count('SIGKILL') - count('timer')
  const walls = rs.filter(r => r.end === 'SIGXCPU' || r.end === 'SIGKILL').map(r => r.wallMs)
  const shares = rs.map(share)
  console.log(
    [
      `${v.key} ${v.name}`.padEnd(22),
      String(rs.length).padStart(4),
      String(count('SIGXCPU')).padStart(7),
      String(count('SIGKILL')).padStart(7),
      String(count('timer')).padStart(5),
      String(other).padStart(5),
      `  ${quantile(walls, 0.5)}/${quantile(walls, 1)}`.padEnd(24),
      `${fixed(quantile(shares, 0.1))}/${fixed(quantile(shares, 0.5))}/${fixed(quantile(shares, 0))}`,
    ].join(' '),
  )
}
const stamps = results.filter(r => r.stamp).map(r => r.stamp)
const p50max = field => {
  const xs = stamps.map(s => s[field])
  return `${fixed(quantile(xs, 0.5))}/${fixed(quantile(xs, 1))}`
}
if (stamps.length > 0)
  console.log(
    `B startup p50/max: node@ ${p50max('nodeAt')} ms, script@ ${p50max('scriptAt')} ms, cpu0 ${p50max('cpu')} s`,
  )
const odd = results.filter(r => r.end !== 'SIGXCPU' && r.end !== 'SIGKILL')
console.log(odd.length === 0 ? 'no run ended other than by SIGXCPU or SIGKILL' : 'runs not ended by a CPU signal:')
for (const r of odd) console.log(`  ${show(r)}`)
