// Interactive Claude Code, with toolscript-mcp as its only MCP server: the permission-mode matrix of the Claude Code
// bridge (issue #94) and the two-session broker check G10 of issue #63. It drives the real claude binary in a
// pseudo-terminal (node-pty) and reads the screen through @xterm/headless. It costs money, a few cents a cell on
// Haiku: --max-spend is the cap (default 3 USD), and the run stops before a cell that would pass it.
//
//   node bench/bridge-modes.mjs cell --mode default --kind W --run-code not --out DIR [--print]
//   node bench/bridge-modes.mjs matrix --out DIR [--print]     the 16 interactive cells, and with --print the -p cells
//   node bench/bridge-modes.mjs g10 --out DIR                  two sessions on one broker (Windows only)
//
// node-pty and @xterm/headless are not dependencies of this repo: install them in a folder outside it and pass it
// with --pty-dir (see bench/interactive.mjs). Run npm run build first.
//
// Safety: every cell has a temp HOME for toolscript-mcp and the bridge, a fixture project, and a cwd for Claude Code
// under --root, which must be outside the home folder. On Windows the default root is C:/tsbench94, not the temp
// folder, because TEMP is inside the home folder and a cwd inside it would load the user's own CLAUDE.md as ancestor
// memory. Elsewhere --root is required. Each cell's folder is removed after the cell, and the root at the end of a run. Claude Code runs with --setting-sources project,
// --strict-mcp-config and --tools "", so toolscript-mcp is the only tool that it lists. The project folder of each cwd
// is removed after the cell (forget.mjs). Nothing here reads the real toolscript config or ~/.claude.json. The
// evidence is one text file for each cell, with the home folder replaced.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DEPLOYS } from './data.mjs'
import { forgetRuns } from './forget.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TOOLSCRIPT = path.join(REPO, 'dist', 'host', 'main.js')
const FAKE_SERVER = path.join(REPO, 'bench', 'fake-server.mjs')
const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const MODES = ['default', 'auto', 'plan', 'dontAsk']

// USD per million tokens, as bench/interactive.mjs.
const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, write5m: 2.5, write1h: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2 },
}
const priceOf = (model, u) => {
  const p = PRICES[model]
  if (!p) throw new Error('no price for model ' + model)
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - w1
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      w5 * p.write5m +
      w1 * p.write1h) /
    1e6
  )
}
const readJsonl = file =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(line => {
      try {
        return line.trim() ? [JSON.parse(line)] : []
      } catch {
        return []
      }
    })
const jsonlFiles = dir =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true })
        .filter(f => String(f).endsWith('.jsonl'))
        .map(f => path.join(dir, String(f)))
    : []
const projectDir = cwd => path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const entriesOf = cwd => jsonlFiles(projectDir(cwd)).flatMap(readJsonl)
/** The cost of every API call in the transcripts of one cwd. */
const costOf = cwd => {
  const byId = new Map()
  for (const e of entriesOf(cwd))
    if (e.type === 'assistant' && e.message?.id && e.message.model && e.message.model !== '<synthetic>')
      byId.set(e.message.id, e.message)
  return [...byId.values()].reduce((n, m) => n + priceOf(m.model, m.usage ?? {}), 0)
}
const turnsOf = cwd => entriesOf(cwd).filter(e => e.type === 'system' && e.subtype === 'turn_duration').length
const runCodeCalls = cwd =>
  new Set(
    entriesOf(cwd)
      .flatMap(e => (Array.isArray(e.message?.content) ? e.message.content : []))
      .filter(b => b.type === 'tool_use' && b.name === 'mcp__toolscript__run_code')
      .map(b => b.id),
  ).size
const toolResults = cwd =>
  entriesOf(cwd)
    .flatMap(e => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter(b => b.type === 'tool_result')
    .map(b => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))

// No home path in the evidence.
const clean = text => {
  let out = String(text)
  for (const h of new Set([
    os.homedir(),
    os.homedir().replaceAll('\\', '/'),
    os.tmpdir(),
    os.tmpdir().replaceAll('\\', '/'),
  ]))
    out = out.replace(new RegExp(h.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'gi'), '<home>')
  return out
}

const findClaude = () => {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(d, process.platform === 'win32' ? 'claude.exe' : 'claude')
    if (d && fs.existsSync(f)) return f
  }
  throw new Error('no claude binary on PATH')
}
const findBash = () =>
  [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].find(f => fs.existsSync(f))

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: 'string' },
    kind: { type: 'string' },
    'run-code': { type: 'string' },
    print: { type: 'boolean' },
    model: { type: 'string' },
    out: { type: 'string' },
    root: { type: 'string' },
    'pty-dir': { type: 'string' },
    'max-spend': { type: 'string' },
    spent: { type: 'string' },
  },
})
const COMMAND = positionals[0]
if (opts.root === undefined && process.platform !== 'win32')
  throw new Error('--root is required: a folder outside the home folder')
const ROOT = path.resolve(opts.root ?? 'C:/tsbench94')
const OUT = path.resolve(opts.out ?? path.join(os.tmpdir(), 'bridge-modes-out'))
const MODEL = opts.model ?? 'haiku'
const CAP = Number(opts['max-spend'] ?? 3)
let spent = Number(opts.spent ?? 0)
if (ROOT.toLowerCase().startsWith(os.homedir().toLowerCase())) throw new Error('--root must be outside the home folder')
const claudeExe = findClaude()
const loadPty = () => {
  const req = createRequire(
    path.join(path.resolve(opts['pty-dir'] ?? path.join(os.tmpdir(), 'ptytry')), 'package.json'),
  )
  return { pty: req('node-pty'), Terminal: req('@xterm/headless').Terminal }
}
const hostEnv = () => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k]
  const bash = findBash()
  if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash
  return env
}
const forward = p => p.replaceAll('\\', '/')

// --- the fixture of one cell --------------------------------------------------------------------------------

const BROKEN = 'export function add(a, b) {\n  return a - b\n}\n'
const FIXED = BROKEN.replace('a - b', 'a + b')

/** A new base folder, a cwd for Claude Code, and the fixture project. */
const freshCell = name => {
  const base = path.join(ROOT, name)
  fs.rmSync(base, { recursive: true, force: true })
  const cwd = path.join(base, 'cwd')
  const project = path.join(base, 'project')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src', 'calc.mjs'), BROKEN)
  return { base, cwd, project, file: path.join(project, 'src', 'calc.mjs'), home: path.join(base, 'home') }
}

/** The toolscript-mcp config of a bridge cell: Read is allow, Edit is ask, the rest of the bridge is deny. */
const bridgeConfig = ({ base, project }) => {
  const config = path.join(base, 'toolscript.json')
  const claudeHome = path.join(base, 'claude-home')
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(
    config,
    JSON.stringify({
      share: false,
      mcpServers: {
        'claude-code': {
          command: claudeExe,
          args: ['mcp', 'serve'],
          cwd: project,
          env: { HOME: claudeHome, USERPROFILE: claudeHome },
        },
      },
      policy: [
        { match: 'mcp__claude-code__Read', action: 'allow' },
        { match: 'mcp__claude-code__Edit', action: 'ask' },
        { match: 'mcp__claude-code__*', action: 'deny' },
      ],
    }),
  )
  return config
}

/** The MCP config of the host: only toolscript-mcp, with its own HOME and any extra env. */
const hostMcp = ({ base, config, home, env = {} }) => {
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(base, 'host-mcp.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        toolscript: {
          command: process.execPath,
          args: [TOOLSCRIPT, '--config', config],
          env: { HOME: home, USERPROFILE: home, ...env },
        },
      },
    }),
  )
  return file
}

const hostArgv = ({ mcp, mode, allowRunCode }) => [
  '--model',
  MODEL,
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--mcp-config',
  mcp,
  '--tools',
  '',
  '--permission-mode',
  mode,
  '--allowedTools',
  allowRunCode ? 'mcp__toolscript__run_code,mcp__toolscript__search_tools' : 'mcp__toolscript__search_tools',
]

const readProgram = project =>
  'return await call("mcp__claude-code__Read", {file_path: "' + forward(project) + '/src/calc.mjs"})'
const editProgram = (project, from, to) =>
  'await call("mcp__claude-code__Read", {file_path: "' +
  forward(project) +
  '/src/calc.mjs"}); return await call("mcp__claude-code__Edit", {file_path: "' +
  forward(project) +
  '/src/calc.mjs", old_string: "return a ' +
  from +
  ' b", new_string: "return a ' +
  to +
  ' b"})'
const askFor = program =>
  'Call the run_code tool exactly one time with this program: ' + program + '. Use no other tool. Then say done.'

const runLines = home => {
  const f = path.join(home, '.toolscript-mcp', 'runs.jsonl')
  return fs.existsSync(f) ? readJsonl(f) : []
}
const summaryOfRuns = home =>
  runLines(home).map(r => ({
    ended: r.ended ?? r.end ?? r.status,
    calls: (r.calls ?? []).map(c => ({ tool: c.tool, ok: c.ok, error: c.error, decision: c.decision })),
  }))

// --- the terminal -------------------------------------------------------------------------------------------

const openSession = ({ term: { pty, Terminal }, argv, cwd }) => {
  const term = new Terminal({ cols: 160, rows: 50, allowProposedApi: true })
  const child = pty.spawn(claudeExe, argv, {
    name: 'xterm-256color',
    cols: 160,
    rows: 50,
    cwd,
    env: hostEnv(),
    useConpty: true,
  })
  let exited = false
  child.onData(d => term.write(d))
  // Claude Code asks the terminal questions, and waits for the answers that xterm gives.
  term.onData(d => child.write(d))
  child.onExit(() => (exited = true))
  const lines = from => {
    const b = term.buffer.active
    const out = []
    for (let i = from; i < b.length; i++) out.push(b.getLine(i).translateToString(true).trimEnd())
    return out.join('\n').replace(/\n+$/, '')
  }
  return {
    get exited() {
      return exited
    },
    screen: () => lines(0),
    view: () => lines(term.buffer.active.baseY),
    write: d => child.write(d),
    kill: () => child.kill(),
  }
}
const KEYS = { enter: '\r', esc: '\x1b', down: '\x1b[B', up: '\x1b[A' }

/** Which dialog the viewport shows: the host's tool prompt, the MCP form of toolscript-mcp, the folder trust, or another. */
const dialogOf = view => {
  if (/Yes, I trust this folder/.test(view)) return 'trust'
  if (/requests your input/.test(view)) return 'toolscript'
  if (/Do you want to proceed/.test(view)) return 'host'
  if (/Enter to confirm|Esc to cancel/.test(view)) return 'other'
  return undefined
}

/**
 * One interactive cell: start, accept the trust prompt, then for each prompt of the cell send it and answer the
 * dialogs until the turn ends. answer(kind, n, step) gives the keys for the n-th dialog of that kind in that step.
 */
const interactive = async ({ term, argv, cwd, steps, evidence }) => {
  const T0 = Date.now()
  const log = line => evidence.push('[' + Math.round((Date.now() - T0) / 1000) + ' s] ' + line)
  const s = openSession({ term, argv, cwd })
  const dialogs = []
  const wait = async (ready, ms, what) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (s.exited) throw new Error('claude exited while waiting for ' + what)
      const v = s.view()
      if (/Yes, I trust this folder/.test(v)) {
        if (/❯ Yes, I trust/.test(v)) s.write('\r')
        else s.write(KEYS.down)
        await sleep(1200)
        continue
      }
      if (ready(v)) return v
      await sleep(300)
    }
    throw new Error('timeout waiting for ' + what)
  }
  try {
    await wait(v => v.includes('❯') && /for shortcuts|mode on|shift\+tab|don't ask on/.test(v), 90_000, 'the input box')
    log('--- ready: ' + s.view().split('\n').slice(-3).join(' | '))
    await sleep(3000)
    for (const [index, step] of steps.entries()) {
      const before = turnsOf(cwd)
      log('--- step ' + (index + 1) + ' prompt: ' + step.prompt)
      s.write(step.prompt)
      await sleep(1500)
      s.write('\r')
      const t0 = Date.now()
      let handled
      const counts = {}
      while (Date.now() - t0 < 150_000) {
        if (s.exited) {
          log('claude exited')
          break
        }
        if (turnsOf(cwd) > before) break
        const v = s.view()
        const kind = dialogOf(v)
        if (kind && kind !== handled) {
          await sleep(1500)
          const shown = s.view()
          counts[kind] = (counts[kind] ?? 0) + 1
          dialogs.push({ step: index + 1, kind, screen: shown })
          log('--- step ' + (index + 1) + ' dialog ' + kind + ' #' + counts[kind] + ' screen:\n' + shown)
          const keys = step.answer(kind, counts[kind])
          log('--- keys sent: ' + keys.join(', '))
          for (const k of keys) {
            s.write(KEYS[k])
            await sleep(500)
          }
          await sleep(1500)
          // A second dialog can follow at once. Only the same kind still on the screen counts as handled.
          handled = dialogOf(s.view()) === kind ? kind : undefined
        } else if (!kind) handled = undefined
        await sleep(300)
      }
      await sleep(2500)
      log('--- step ' + (index + 1) + ' end screen:\n' + s.view())
      if (step.after) await step.after(s, log)
    }
    return { dialogs, final: s.screen() }
  } finally {
    s.write('/exit')
    await sleep(400)
    s.write('\r')
    for (let i = 0; i < 20 && !s.exited; i++) await sleep(250)
    if (!s.exited) {
      s.write('\x03')
      await sleep(300)
      s.write('\x03')
      await sleep(1500)
    }
    if (!s.exited) s.kill()
    log('session closed')
  }
}

// --- the cells ----------------------------------------------------------------------------------------------

const cellName = ({ mode, kind, runCode, print }) =>
  (print ? 'p-' : '') + mode + '-' + kind + '-' + (runCode ? 'allowed' : 'not')

const ACCEPT = ['enter']
const DECLINE = ['down', 'enter']

const saveEvidence = (name, lines) => {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name + '.txt'), clean(lines.join('\n')) + '\n')
}

/** One interactive cell. A cell where the model made no run_code call in 2 tries is not observed. */
/** Whether one more paid session fits under the cap. A NaN cap or spend fits nothing. */
const fits = need => spent + need <= CAP
/** The process of this run that are still alive, by pid and creation time, whether or not the broker that made them lives. */
const alive = (list, seen) => list.filter(p => seen.has(p.p + '@' + p.t))

const runCell = async ({ mode, kind, runCode }) => {
  const name = cellName({ mode, kind, runCode })
  const term = loadPty()
  const result = { name, mode, kind, runCode, observed: false }
  const evidence = []
  for (let attempt = 1; attempt <= 2 && !result.observed; attempt++) {
    if (!fits(0.15)) {
      result.reason = 'the spend cap'
      break
    }
    const cell = freshCell(name)
    forgetRuns([cell.cwd])
    const config = bridgeConfig(cell)
    const mcp = hostMcp({ base: cell.base, config, home: cell.home })
    const argv = hostArgv({ mcp, mode, allowRunCode: runCode })
    evidence.push('=== attempt ' + attempt + ' ===')
    evidence.push('command: claude ' + argv.map(a => (a === '' ? '""' : a)).join(' '))
    evidence.push('cwd: ' + cell.cwd + '; MODEL ' + MODEL)
    const hostAnswers = (k, n) =>
      k === 'host' ? ACCEPT : k === 'toolscript' ? (n === 1 && !askedLater ? ACCEPT : ACCEPT) : ['esc']
    let askedLater = false
    const steps = [
      {
        prompt: askFor(kind === 'R' ? readProgram(cell.project) : editProgram(cell.project, '-', '+')),
        answer: hostAnswers,
      },
    ]
    if (kind === 'W')
      steps.push({
        prompt: askFor(editProgram(cell.project, '+', '-')),
        answer: (k, n) => (k === 'toolscript' ? DECLINE : k === 'host' ? ACCEPT : ['esc']),
      })
    let run
    try {
      run = await interactive({ term, argv, cwd: cell.cwd, steps, evidence })
    } catch (err) {
      evidence.push('error: ' + err.message)
    }
    const calls = runCodeCalls(cell.cwd)
    const cost = costOf(cell.cwd)
    spent += cost
    evidence.push(
      'run_code tool calls by the model: ' +
        calls +
        '; cost USD ' +
        cost.toFixed(4) +
        '; total spend ' +
        spent.toFixed(4),
    )
    evidence.push(
      'file after: ' +
        (fs.readFileSync(cell.file, 'utf8') === FIXED
          ? 'changed (return a + b)'
          : fs.readFileSync(cell.file, 'utf8') === BROKEN
            ? 'unchanged (return a - b)'
            : 'other'),
    )
    evidence.push('run log: ' + JSON.stringify(summaryOfRuns(cell.home)))
    evidence.push('tool results seen by the model:\n' + toolResults(cell.cwd).join('\n---\n').slice(0, 3000))
    if (run && calls > 0) {
      result.observed = true
      result.dialogs = run.dialogs.map(d => ({ step: d.step, kind: d.kind }))
      result.fileChanged = fs.readFileSync(cell.file, 'utf8') === FIXED
      result.runLog = summaryOfRuns(cell.home)
    } else
      result.reason = run
        ? 'the model made no run_code call in ' + attempt + ' try'
        : 'the screen could not be read: ' + evidence.at(-4)
    forgetRuns([cell.cwd])
    fs.rmSync(cell.base, { recursive: true, force: true })
  }
  result.spent = spent
  if (!result.observed)
    evidence.push('NOT OBSERVED: ' + (result.reason ?? 'the model made no run_code call in 2 tries'))
  saveEvidence(name, evidence)
  return result
}

/** One claude -p cell (kind W). */
const runPrintCell = async ({ mode, runCode }) => {
  const name = cellName({ mode, kind: 'W', runCode, print: true })
  const evidence = []
  if (!fits(0.15)) {
    saveEvidence(name, ['NOT OBSERVED: the spend cap'])
    return { name, observed: false, reason: 'the spend cap', spent }
  }
  const cell = freshCell(name)
  forgetRuns([cell.cwd])
  const config = bridgeConfig(cell)
  const mcp = hostMcp({ base: cell.base, config, home: cell.home })
  const prompt = askFor(editProgram(cell.project, '-', '+'))
  const argv = ['-p', prompt, ...hostArgv({ mcp, mode, allowRunCode: runCode }), '--output-format', 'json']
  evidence.push(
    'command: claude -p <prompt> ' +
      argv
        .slice(2)
        .map(a => (a === '' ? '""' : a))
        .join(' '),
  )
  evidence.push('prompt: ' + prompt)
  const out = await new Promise(resolve => {
    const child = spawn(claudeExe, argv, {
      cwd: cell.cwd,
      env: hostEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const timer = setTimeout(() => child.kill(), 180_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
  const cost = costOf(cell.cwd)
  spent += cost
  const calls = runCodeCalls(cell.cwd)
  evidence.push('exit code: ' + out.code + '; stderr: ' + out.stderr.slice(0, 500))
  evidence.push('stdout: ' + out.stdout.slice(0, 3000))
  evidence.push(
    'run_code tool calls by the model: ' +
      calls +
      '; cost USD ' +
      cost.toFixed(4) +
      '; total spend ' +
      spent.toFixed(4),
  )
  evidence.push(
    'file after: ' +
      (fs.readFileSync(cell.file, 'utf8') === FIXED ? 'changed (return a + b)' : 'unchanged (return a - b)'),
  )
  evidence.push('run log: ' + JSON.stringify(summaryOfRuns(cell.home)))
  evidence.push('tool results seen by the model:\n' + toolResults(cell.cwd).join('\n---\n').slice(0, 3000))
  if (calls === 0) evidence.push('NOT OBSERVED: the model made no run_code call')
  saveEvidence(name, evidence)
  forgetRuns([cell.cwd])
  const row = {
    name,
    observed: calls > 0,
    fileChanged: fs.readFileSync(cell.file, 'utf8') === FIXED,
    runLog: summaryOfRuns(cell.home),
    spent,
  }
  fs.rmSync(cell.base, { recursive: true, force: true })
  return row
}

// --- G10: two sessions on one broker --------------------------------------------------------------------------

const processes = () => {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{p=[int]$_.ProcessId;pp=[int]$_.ParentProcessId;t=$(if($_.CreationDate){[int64]($_.CreationDate.ToFileTimeUtc()/10000)}else{0});n=$_.Name;c=$_.CommandLine} } | ConvertTo-Json -Compress'
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const parsed = JSON.parse(r.stdout)
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean)
}

const runG10 = async () => {
  if (process.platform !== 'win32') throw new Error('g10 is written for Windows: the process list uses PowerShell')
  if (!fits(0.05)) return { steps: {}, reason: 'the spend cap', spent }
  const evidence = []
  const log = line => evidence.push(line)
  const term = loadPty()
  const IDLE_MS = 5000
  const base = path.join(ROOT, 'g10')
  fs.rmSync(base, { recursive: true, force: true })
  const home = path.join(base, 'home')
  const benchLog = path.join(base, 'bench.jsonl')
  fs.mkdirSync(base, { recursive: true })
  const config = path.join(base, 'toolscript.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      share: true,
      // share: true makes the class shared: without it a server with no cwd is per folder, and the two sessions here run in two folders.
      mcpServers: {
        bench: { command: process.execPath, args: [FAKE_SERVER], env: { BENCH_LOG: benchLog }, share: true },
      },
      policy: [{ match: 'mcp__bench__*', action: 'allow' }],
    }),
  )
  const mark = base.toLowerCase().replaceAll('\\', '/')
  const mine = list => list.filter(p => (p.c ?? '').toLowerCase().replaceAll('\\', '/').includes(mark))
  const brokerLog = () => {
    const f = path.join(home, '.toolscript-mcp', 'broker', 'broker.log')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  }
  const starts = () => [...brokerLog().matchAll(/start pid (\d+)/g)].map(m => Number(m[1]))
  // Every broker and child that a snapshot saw, as pid@creation time. A child outlives its broker only by a leak, and
  // then it has no live parent: step 4 asks for these identities, not for the children of a live broker.
  const seen = new Set()
  const snapshot = label => {
    const list = processes()
    const pids = starts()
    const broker = list.filter(p => pids.includes(p.p))
    const children = list.filter(p => broker.some(b => b.p === p.pp) && /fake-server/.test(p.c ?? ''))
    for (const p of [...broker, ...children]) seen.add(p.p + '@' + p.t)
    const kept = alive(list, seen)
    const hosts = mine(list).filter(p => /main\.js/.test(p.c ?? ''))
    log(
      '[' +
        label +
        '] start pid lines: ' +
        pids.length +
        '; broker processes: ' +
        broker.map(b => b.p + '@' + b.t).join(',') +
        '; shared children: ' +
        children.map(c => c.p + '@' + c.t).join(',') +
        '; toolscript-mcp hosts of this run: ' +
        hosts.map(h => h.p).join(',') +
        '; observed broker or child still running: ' +
        kept.map(k => k.p + '@' + k.t).join(','),
    )
    return { startLines: pids.length, broker, children, hosts, kept }
  }
  const prompt = askFor('const r = await call("mcp__bench__get_deploys", {date: "2026-10-09"}); return r.count')
  const answered = cwd => toolResults(cwd).some(t => t.includes(String(DEPLOYS.length)))
  const mkSession = name => {
    const cell = freshCell('g10-' + name)
    forgetRuns([cell.cwd])
    const mcp = hostMcp({ base: cell.base, config, home, env: { TOOLSCRIPT_BROKER_IDLE_MS: String(IDLE_MS) } })
    return { ...cell, argv: hostArgv({ mcp, mode: 'default', allowRunCode: true }) }
  }
  const A = mkSession('A')
  const B = mkSession('B')
  const result = { steps: {}, spent: 0 }
  const answers = () => ['enter']
  // Step 1 and 2 need A open while B runs, so the sessions are driven by hand here, not by interactive().
  const open = async cell => {
    const s = openSession({ term, argv: cell.argv, cwd: cell.cwd })
    const ready = async () => {
      const end = Date.now() + 90_000
      while (Date.now() < end) {
        const v = s.view()
        if (/Yes, I trust this folder/.test(v)) s.write(/❯ Yes, I trust/.test(v) ? '\r' : KEYS.down)
        else if (v.includes('❯') && /for shortcuts|mode on|shift\+tab/.test(v)) return
        await sleep(400)
      }
      throw new Error('no input box')
    }
    await ready()
    await sleep(3000)
    const ask = async () => {
      const before = turnsOf(cell.cwd)
      s.write(prompt)
      await sleep(1500)
      s.write('\r')
      const t0 = Date.now()
      while (Date.now() - t0 < 150_000 && turnsOf(cell.cwd) <= before && !s.exited) {
        const k = dialogOf(s.view())
        if (k === 'host') {
          await sleep(1500)
          log('host dialog:\n' + s.view())
          s.write('\r')
          await sleep(1500)
        }
        await sleep(300)
      }
      await sleep(2000)
    }
    const exit = async () => {
      s.write('/exit')
      await sleep(400)
      s.write('\r')
      for (let i = 0; i < 20 && !s.exited; i++) await sleep(250)
      if (!s.exited) s.kill()
    }
    return { s, ask, exit }
  }
  let a, b
  try {
    a = await open(A)
    await a.ask()
    const s1 = snapshot('step 1, after A answered')
    log(
      'A tool calls by the model: ' +
        runCodeCalls(A.cwd) +
        '; A saw the fixture count: ' +
        answered(A.cwd) +
        '\nA tool results:\n' +
        toolResults(A.cwd).join('\n---\n').slice(0, 1500),
    )
    result.steps[1] = answered(A.cwd) && s1.startLines === 1 && s1.broker.length === 1
    b = await open(B)
    await b.ask()
    const s2 = snapshot('step 2, after B answered')
    log(
      'B tool calls by the model: ' +
        runCodeCalls(B.cwd) +
        '; B saw the fixture count: ' +
        answered(B.cwd) +
        '\nB tool results:\n' +
        toolResults(B.cwd).join('\n---\n').slice(0, 1500),
    )
    result.steps[2] =
      answered(B.cwd) &&
      s2.startLines === 1 &&
      s2.broker.length === 1 &&
      s2.children.length === 1 &&
      s2.hosts.length === 2
    await a.exit()
    await sleep(2000)
    const s3a = snapshot('step 3, after A exited')
    const callsBefore = fs.existsSync(benchLog) ? readJsonl(benchLog).length : 0
    B.second = true
    const beforeTurns = runCodeCalls(B.cwd)
    await b.ask()
    const callsAfter = fs.existsSync(benchLog) ? readJsonl(benchLog).length : 0
    const s3b = snapshot('step 3, after B answered a second call')
    log(
      'fake server calls: ' +
        callsBefore +
        ' -> ' +
        callsAfter +
        '; B run_code calls ' +
        beforeTurns +
        ' -> ' +
        runCodeCalls(B.cwd),
    )
    result.steps[3] =
      s3a.broker.length === 1 &&
      s3a.children.length === 1 &&
      callsAfter > callsBefore &&
      s3b.children.length === 1 &&
      s3b.children[0].p === s2.children[0]?.p &&
      s3b.broker[0].p === s2.broker[0]?.p
    await b.exit()
    const t0 = Date.now()
    let left
    while (Date.now() - t0 < IDLE_MS + 10_000) {
      left = snapshot('step 4, ' + Math.round((Date.now() - t0) / 1000) + ' s after B exited')
      if (left.kept.length === 0 && left.hosts.length === 0) break
      await sleep(1000)
    }
    result.steps[4] = left.kept.length === 0 && left.hosts.length === 0
    log('broker.log:\n' + brokerLog())
  } catch (err) {
    log('error: ' + err.message)
  } finally {
    for (const x of [a, b]) if (x && !x.s.exited) x.s.kill()
    result.spent = costOf(A.cwd) + costOf(B.cwd)
    spent += result.spent
    forgetRuns([A.cwd, B.cwd])
    for (const gone of [A.base, B.base, base]) fs.rmSync(gone, { recursive: true, force: true })
  }
  log('steps: ' + JSON.stringify(result.steps) + '; spend USD ' + result.spent.toFixed(4))
  saveEvidence('g10', evidence)
  return result
}

// --- main ---------------------------------------------------------------------------------------------------

if (COMMAND === 'cell') {
  console.log(
    JSON.stringify(await runCell({ mode: opts.mode, kind: opts.kind, runCode: opts['run-code'] === 'allowed' })),
  )
} else if (COMMAND === 'matrix') {
  const rows = []
  for (const mode of MODES)
    for (const kind of ['R', 'W'])
      for (const runCode of [false, true]) {
        const r = await runCell({ mode, kind, runCode })
        rows.push(r)
        console.log(JSON.stringify(r))
      }
  if (opts.print)
    for (const mode of MODES)
      for (const runCode of [false, true]) {
        const r = await runPrintCell({ mode, runCode })
        rows.push(r)
        console.log(JSON.stringify(r))
      }
  fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(rows, null, 2))
  console.log('total spend USD ' + spent.toFixed(4))
} else if (COMMAND === 'print') {
  console.log(JSON.stringify(await runPrintCell({ mode: opts.mode, runCode: opts['run-code'] === 'allowed' })))
} else if (COMMAND === 'selftest') {
  // No model, no session: the cap check and the leftover check on injected values.
  const assert = (await import('node:assert/strict')).default
  const seen = new Set(['10@5', '20@6'])
  assert.deepEqual(
    alive(
      [
        { p: 10, t: 5 },
        { p: 99, t: 7 },
      ],
      seen,
    ).map(p => p.p),
    [10],
    'an orphan with no broker still counts',
  )
  assert.deepEqual(alive([{ p: 10, t: 8 }], seen), [], 'a reused pid with another creation time does not count')
  assert.deepEqual(alive([], seen), [])
  assert.equal(fits(Number.POSITIVE_INFINITY), false)
  console.log('selftest passed; fits(0.15) is ' + fits(0.15) + ' with cap ' + CAP + ' and spent ' + spent)
} else if (COMMAND === 'g10') {
  console.log(JSON.stringify(await runG10()))
} else {
  console.error('usage: node bench/bridge-modes.mjs cell|print|matrix|g10 ...')
  process.exit(2)
}
// The root goes when no cell folder is left in it (a folder that the person made keeps it).
try {
  fs.rmdirSync(ROOT)
} catch {}
// node-pty keeps the event loop alive after its child exited.
process.exit(0)
