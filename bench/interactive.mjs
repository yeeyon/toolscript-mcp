// Cost bench in interactive Claude Code, three arms on the tasks of data.mjs:
//   direct      the fake server's tools, called one at a time as mcp__bench__*
//   codemode    the same server, with Claude Code's own Code Mode on (the REPL tool)
//   toolscript  only toolscript-mcp, whose config lists the fake server as bench
//
//   node bench/interactive.mjs --reps 3 --max-spend 5 --spent 0.11
//   node bench/interactive.mjs --reps 1 --tasks ticket --arms codemode
//   node bench/interactive.mjs --report <out dir>
//
// Code Mode exists only in the interactive TUI, so this script drives `claude` in a pseudo-terminal
// (node-pty) and reads the screen through @xterm/headless. Neither is a dependency of this repo:
// node-pty is a native module. Install both in a folder outside the repo and pass it with --pty-dir:
//   mkdir %TEMP%\ptytry && cd %TEMP%\ptytry && npm init -y && npm i node-pty@1 @xterm/headless@6
//
// Each arm has one fixed cwd, <root>/<arm>/cwd, outside the home folder, so no user CLAUDE.md loads as
// ancestor memory. The first run of an arm accepts the folder-trust prompt for that cwd. The codemode arm
// accepts the Code Mode opt-in prompt if it shows. Any other prompt stops the run. Before and after each
// run, the Claude Code project folder of the cwd is removed (forget.mjs), so no run sees another's
// transcript or memory. The transcript is copied to the run folder first.
//
// Flags of every run: --model sonnet --setting-sources project (no user settings, hooks or plugins)
// --disallowedTools Bash,PowerShell --permission-mode dontAsk (a tool that is not allowed is refused
// without a prompt, as in claude -p) --strict-mcp-config --mcp-config <arm file> --allowedTools <arm tools>.
// Cost comes from the usage of each API call in the transcript at the list prices below.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { TASKS } from './data.mjs'
import { forgetRuns } from './forget.mjs'
import { estimate, spentSoFar } from './spend.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FAKE_SERVER = path.join(REPO, 'bench', 'fake-server.mjs')
const TOOLSCRIPT = path.join(REPO, 'dist', 'host', 'main.js')
const PROJECTS = path.join(os.homedir(), '.claude', 'projects')

// USD per million tokens. Source: the claude-api skill of Claude Code 2.1.325 (model table, and
// shared/prompt-caching.md: a 5-minute cache write is 1.25x the input price, a 1-hour write 2x).
const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, write5m: 2.5, write1h: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, write5m: 0.125, write1h: 0.2 },
}

const USAGE = `usage: node bench/interactive.mjs [--reps N] [--max-spend USD] [--spent USD] [--model NAME]
       [--tasks ${TASKS.map(t => t.id).join(',')}] [--arms direct,codemode,toolscript]
       [--root DIR] [--pty-dir DIR] [--bash PATH] [--out DIR]
       node bench/interactive.mjs --report DIR
Each run starts interactive Claude Code and costs money. Before each run, the bench adds the most that a
run of the same arm and task has cost so far, and stops when that passes --max-spend (default 5). This is an
estimate: one run can cost more, so the total can pass the cap. The spend counts the saved runs of --out.
--spent adds money spent outside them.`

let opts
try {
  opts = parseArgs({
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      reps: { type: 'string' },
      'max-spend': { type: 'string' },
      spent: { type: 'string' },
      model: { type: 'string' },
      tasks: { type: 'string' },
      arms: { type: 'string' },
      root: { type: 'string' },
      'pty-dir': { type: 'string' },
      bash: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'string' },
    },
  }).values
} catch (err) {
  console.error(`${err.message}\n${USAGE}`)
  process.exit(2)
}
if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}

const ROOT = path.resolve(opts.root ?? 'C:/tsbench')
const cwdOf = arm => path.join(ROOT, arm, 'cwd')

const benchServer = log => ({ command: 'node', args: [FAKE_SERVER], env: { BENCH_LOG: log } })
const BENCH_TOOLS = ['search_messages', 'list_issues', 'query_logs', 'create_ticket', 'get_deploys']
const FILE_TOOLS = ['Read', 'Grep', 'Glob']

// What each arm puts in front of the model. `allowed` is the whole --allowedTools list.
const ARMS = {
  direct: {
    codeMode: false,
    servers: ({ log }) => ({ bench: benchServer(log) }),
    allowed: [...BENCH_TOOLS.map(t => `mcp__bench__${t}`), ...FILE_TOOLS],
  },
  codemode: {
    codeMode: true,
    servers: ({ log }) => ({ bench: benchServer(log) }),
    allowed: [...BENCH_TOOLS.map(t => `mcp__bench__${t}`), 'REPL', ...FILE_TOOLS],
  },
  toolscript: {
    codeMode: false,
    servers: ({ dir, log }) => {
      const config = path.join(dir, 'toolscript.json')
      fs.writeFileSync(
        config,
        JSON.stringify({
          mcpServers: { bench: benchServer(log) },
          policy: [{ match: 'mcp__bench__*', action: 'allow' }],
        }),
      )
      return { toolscript: { command: 'node', args: [TOOLSCRIPT, '--config', config] } }
    },
    allowed: ['mcp__toolscript__run_code', 'mcp__toolscript__search_tools', ...FILE_TOOLS],
  },
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

const priceOf = (model, u) => {
  const p = PRICES[model]
  if (!p) throw new Error(`no price for model ${model}`)
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - write1h
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      write5m * p.write5m +
      write1h * p.write1h) /
    1e6
  )
}

const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => (b.type === 'text' ? b.text : JSON.stringify(b))).join('')
      : JSON.stringify(content ?? '')

const count = names => names.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})

// The row of one run, from its transcript files and its BENCH_LOG. `main` is the session transcript,
// `all` adds the transcripts of any subagents, whose API calls cost money too.
const measure = ({ task, arm, rep, main, all, calls, seconds }) => {
  const realApi = entries => {
    const byId = new Map()
    for (const e of entries)
      if (e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>' && e.message.id)
        byId.set(e.message.id, e.message)
    return [...byId.values()]
  }
  const api = realApi(all)
  const mainApi = realApi(main)
  const sum = f => api.reduce((n, m) => n + (f(m.usage ?? {}) ?? 0), 0)
  const assistant = main.filter(e => e.type === 'assistant')
  const blocks = (entries, type) =>
    entries.flatMap(e => (Array.isArray(e.message?.content) ? e.message.content : [])).filter(b => b.type === type)
  const outerUses = new Map(
    blocks(
      assistant.filter(e => e.message.model !== '<synthetic>'),
      'tool_use',
    ).map(b => [b.id, b]),
  )
  const innerUses = blocks(
    assistant.filter(e => e.message.model === '<synthetic>'),
    'tool_use',
  )
  const results = blocks(
    main.filter(e => e.type === 'user'),
    'tool_result',
  ).filter(b => outerUses.has(b.tool_use_id))
  const uniqueResults = [...new Map(results.map(b => [b.tool_use_id, b])).values()]
  const failed = uniqueResults.filter(b => b.is_error === true || /^<repl-output>\s*<error>/.test(textOf(b.content)))
  const lastText = mainApi.findLast(m => (m.content ?? []).some(b => b.type === 'text'))
  const answer = (lastText?.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  const first = mainApi[0]?.usage ?? {}
  const firstInput =
    (first.input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0) + (first.cache_creation_input_tokens ?? 0)
  const turn = main.find(e => e.type === 'system' && e.subtype === 'turn_duration')
  return {
    task: task.id,
    arm,
    rep,
    correct: task.check(answer, calls),
    // A cold run wrote most of its fixed context to the cache on the first call instead of reading it.
    cold: (first.cache_read_input_tokens ?? 0) < firstInput / 2,
    costUsd: api.reduce((n, m) => n + priceOf(m.model, m.usage ?? {}), 0),
    // The same cost in three parts: reading the cache, writing it (fresh input too), and output.
    costRead: api.reduce(
      (n, m) => n + priceOf(m.model, { cache_read_input_tokens: m.usage?.cache_read_input_tokens }),
      0,
    ),
    costOutput: api.reduce((n, m) => n + priceOf(m.model, { output_tokens: m.usage?.output_tokens }), 0),
    models: [...new Set(api.map(m => m.model))],
    freshInput: sum(u => u.input_tokens),
    cacheRead: sum(u => u.cache_read_input_tokens),
    cacheWrite5m: sum(u => u.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: sum(u => u.cache_creation?.ephemeral_1h_input_tokens),
    cacheWrite: sum(u => u.cache_creation_input_tokens),
    output: sum(u => u.output_tokens),
    firstCallInput: firstInput,
    firstCallCacheRead: first.cache_read_input_tokens ?? 0,
    apiCalls: api.length,
    subagentApiCalls: api.length - mainApi.length,
    toolCalls: count([...outerUses.values()].map(b => b.name)),
    innerCalls: count(innerUses.map(b => b.name)),
    toolResultChars: uniqueResults.reduce((n, b) => n + textOf(b.content).length, 0),
    failedTools: count(failed.map(b => outerUses.get(b.tool_use_id).name)),
    permissionDenials: uniqueResults.filter(
      b => b.is_error === true && /permission|denied|not allowed/i.test(textOf(b.content)),
    ).length,
    stillConnecting: uniqueResults.filter(b => /still connecting/i.test(textOf(b.content))).length,
    mcpCalls: calls.length,
    // Calls with the same tool and arguments as an earlier call of the run: the data was fetched again.
    repeatedCalls: calls.length - new Set(calls.map(c => JSON.stringify([c.tool, c.args]))).size,
    serverChars: calls.reduce((n, c) => n + c.chars, 0),
    replMode: main.some(e => e.type === 'repl-mode' && e.replMode === true),
    turnSeconds: (turn?.durationMs ?? NaN) / 1000,
    seconds,
    answer: answer.slice(0, 600),
  }
}

// --- the terminal driver ----------------------------------------------------------------------------

const loadPty = dir => {
  const req = createRequire(path.join(dir, 'package.json'))
  return { pty: req('node-pty'), Terminal: req('@xterm/headless').Terminal }
}

const findBash = given => {
  const candidates = [
    given,
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ]
  return candidates.find(c => c && fs.existsSync(c))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// The prompts a run may accept: [the text of the accept option, which arms may accept it].
const DIALOGS = [
  ['Yes, I trust this folder', () => true],
  ['Yes, turn on Code Mode', arm => ARMS[arm].codeMode],
]

const projectDir = cwd => path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'))

// One interactive session: start, accept the allowed prompts, send the task, wait for the end of the
// turn in the transcript, copy the transcript, exit.
const drive = async ({ term: { pty, Terminal }, bash, arm, argv, prompt, dir }) => {
  const cwd = cwdOf(arm)
  const env = { ...process.env }
  // The parent session's variables would leak into the child: session ids, the messaging socket, effort.
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k]
  if (ARMS[arm].codeMode) env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  env.CLAUDE_CODE_GIT_BASH_PATH = bash
  const term = new Terminal({ cols: 160, rows: 50, allowProposedApi: true })
  const child = pty.spawn('claude.exe', argv, {
    name: 'xterm-256color',
    cols: 160,
    rows: 50,
    cwd,
    env,
    useConpty: true,
  })
  let exited = false
  child.onData(d => term.write(d))
  child.onExit(() => (exited = true))
  const screen = () => {
    const b = term.buffer.active
    const lines = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true))
    return lines.join('\n')
  }
  const keys = async ks => {
    for (const k of ks) {
      child.write(k)
      await sleep(400)
    }
  }
  const fail = async why => {
    fs.writeFileSync(path.join(dir, 'screen.txt'), screen())
    child.kill()
    throw new Error(`${why} (screen in ${dir})`)
  }
  const accepted = []
  const until = async (ready, ms, what) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (exited) return fail(`claude exited while waiting for ${what}`)
      const s = screen()
      const dialog = DIALOGS.find(([text]) => s.includes(text))
      if (dialog) {
        if (!dialog[1](arm)) return fail(`prompt not allowed in arm ${arm}: ${dialog[0]}`)
        // A prompt can show before it takes keys: move down until the cursor is on the accept line, then Enter.
        const onAccept = () =>
          screen()
            .split('\n')
            .some(l => l.includes('❯') && l.includes(dialog[0]))
        for (let i = 0; i < 20 && !onAccept(); i++) {
          await sleep(500)
          if (!onAccept()) child.write('\x1b[B')
        }
        if (!onAccept()) return fail(`could not select: ${dialog[0]}`)
        accepted.push(dialog[0])
        await keys(['\r'])
        await sleep(2000)
        continue
      }
      if (/Enter to confirm · Esc to/.test(s)) return fail(`unexpected prompt while waiting for ${what}`)
      const value = ready(s)
      if (value) return value
      await sleep(300)
    }
    return fail(`timeout waiting for ${what}`)
  }
  await until(s => /for shortcuts|don't ask on/.test(s) && s.includes('❯'), 90_000, 'the input box')
  // A person takes a few seconds to type the task. The MCP servers connect in that time.
  await sleep(3000)
  child.write(prompt)
  await until(s => s.includes(prompt.slice(0, 40)) || s.includes('[Pasted text'), 15_000, 'the typed prompt')
  await sleep(500)
  child.write('\r')
  const started = Date.now()
  const transcript = await until(
    () =>
      jsonlFiles(projectDir(cwd)).find(f =>
        readJsonl(f).some(e => e.type === 'system' && e.subtype === 'turn_duration'),
      ),
    360_000,
    'the end of the turn',
  )
  const seconds = (Date.now() - started) / 1000
  await sleep(1500)
  fs.writeFileSync(path.join(dir, 'screen.txt'), screen())
  await keys(['/exit'])
  await keys(['\r'])
  for (let i = 0; i < 20 && !exited; i++) await sleep(250)
  if (!exited) {
    await keys(['\x03', '\x03'])
    await sleep(1500)
  }
  if (!exited) child.kill()
  const saved = path.join(dir, 'transcript')
  fs.mkdirSync(saved, { recursive: true })
  for (const f of jsonlFiles(projectDir(cwd)))
    fs.copyFileSync(f, path.join(saved, path.relative(projectDir(cwd), f).replace(/[\\/]/g, '__')))
  return { seconds, accepted, mainName: path.basename(transcript) }
}

// --- the report -------------------------------------------------------------------------------------

const sorted = xs => [...xs].sort((a, b) => a - b)
const median = xs => {
  const s = sorted(xs)
  const m = Math.floor(s.length / 2)
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = xs => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length)
const fmt = (v, d = 0) => (Number.isNaN(v) ? '-' : d === 0 ? Math.round(v).toLocaleString('en-US') : v.toFixed(d))
const stat = (xs, d) =>
  xs.length === 0
    ? '-'
    : `${fmt(mean(xs), d)} / ${fmt(median(xs), d)} / ${fmt(Math.min(...xs), d)}-${fmt(Math.max(...xs), d)}`
const sumOf = obj => Object.values(obj).reduce((a, b) => a + b, 0)

const METRICS = [
  ['cost USD', r => r.costUsd, 4],
  ['  of which cache reads', r => r.costRead, 4],
  ['  of which cache writes and fresh input', r => r.costUsd - r.costRead - r.costOutput, 4],
  ['  of which output', r => r.costOutput, 4],
  ['API calls', r => r.apiCalls],
  ['first-call input tokens', r => r.firstCallInput],
  ['cache read tokens', r => r.cacheRead],
  ['cache write tokens', r => r.cacheWrite],
  ['output tokens', r => r.output],
  ['tool calls (model)', r => sumOf(r.toolCalls)],
  ['calls inside a program', r => sumOf(r.innerCalls)],
  ['failed tool calls', r => sumOf(r.failedTools)],
  ['MCP calls (server log)', r => r.mcpCalls],
  ['repeated MCP calls', r => r.repeatedCalls],
  ['server result chars', r => r.serverChars],
  ['tool result chars in context', r => r.toolResultChars],
  ['seconds', r => r.seconds, 1],
]

const report = rows => {
  const arms = Object.keys(ARMS).filter(a => rows.some(r => r.arm === a))
  const tasks = TASKS.map(t => t.id).filter(t => rows.some(r => r.task === t))
  const warm = rows.filter(r => !r.cold)
  const of = (rs, arm, task) => rs.filter(r => r.arm === arm && (task === undefined || r.task === task))
  console.log(
    `runs: ${arms.map(a => `${a} ${of(rows, a).length}`).join(', ')}; cold: ${rows.filter(r => r.cold).length}`,
  )
  console.log(`total spend: $${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(4)}`)
  console.log(`models: ${[...new Set(rows.flatMap(r => r.models))].join(', ')}`)
  console.log(`\n### Warm runs per arm: mean / median / min-max\n`)
  console.log(`| metric | ${arms.join(' | ')} |`)
  console.log(`|---|${arms.map(() => '---:').join('|')}|`)
  console.log(
    `| correct | ${arms.map(a => `${of(warm, a).filter(r => r.correct).length}/${of(warm, a).length}`).join(' | ')} |`,
  )
  for (const [name, f, d] of METRICS)
    console.log(`| ${name} | ${arms.map(a => stat(of(warm, a).map(f), d)).join(' | ')} |`)
  console.log(`\n### Warm runs per task: median cost USD (min-max), correct\n`)
  console.log(`| task | ${arms.join(' | ')} |`)
  console.log(`|---|${arms.map(() => '---:').join('|')}|`)
  for (const task of tasks)
    console.log(
      `| ${task} | ${arms
        .map(a => {
          const rs = of(warm, a, task)
          const xs = rs.map(r => r.costUsd)
          return rs.length
            ? `${fmt(median(xs), 4)} (${fmt(Math.min(...xs), 4)}-${fmt(Math.max(...xs), 4)}) ${rs.filter(r => r.correct).length}/${rs.length}`
            : '-'
        })
        .join(' | ')} |`,
    )
  console.log(`\n### Warm runs per task: median API calls / tool result chars in context / output tokens\n`)
  console.log(`| task | ${arms.join(' | ')} |`)
  console.log(`|---|${arms.map(() => '---:').join('|')}|`)
  for (const task of tasks)
    console.log(
      `| ${task} | ${arms
        .map(a => {
          const rs = of(warm, a, task)
          return `${fmt(median(rs.map(r => r.apiCalls)))} / ${fmt(median(rs.map(r => r.toolResultChars)))} / ${fmt(median(rs.map(r => r.output)))}`
        })
        .join(' | ')} |`,
    )
  console.log(`\n### Every run\n`)
  console.log(
    '| run | ok | cold | USD | API | write | read | out | ctx chars | tools (model) | inside programs | failed | s |',
  )
  console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|')
  const names = o =>
    Object.entries(o)
      .map(([n, k]) => `${n.replace(/^mcp__(bench|toolscript)__/, '')} ${k}`)
      .join(', ')
  for (const r of rows)
    console.log(
      `| ${r.task}-${r.arm}-${r.rep} | ${r.correct ? 'yes' : 'NO'} | ${r.cold ? 'cold' : ''} | ${r.costUsd.toFixed(4)} | ${r.apiCalls} | ${fmt(r.cacheWrite)} | ${fmt(r.cacheRead)} | ${fmt(r.output)} | ${fmt(r.toolResultChars)} | ${names(r.toolCalls)} | ${names(r.innerCalls)} | ${names(r.failedTools)} | ${r.seconds.toFixed(0)} |`,
    )
  const wrong = rows.filter(r => !r.correct)
  if (wrong.length) {
    console.log('\n### Wrong answers\n')
    for (const r of wrong) console.log(`- ${r.task}-${r.arm}-${r.rep}: ${r.answer.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
}

// --- main -------------------------------------------------------------------------------------------

// The rows again from each run's saved transcript and BENCH_LOG, so a metric added later covers old runs.
// Wall time and the accepted prompts are not in the transcript, so they come from the saved row.
const remeasure = (dir, saved) =>
  saved.map(r => {
    const run = path.join(dir, `${r.task}-${r.arm}-${r.rep}`)
    const files = fs.readdirSync(path.join(run, 'transcript')).map(f => path.join(run, 'transcript', f))
    const main = files.find(f => !path.basename(f).includes('__'))
    const log = path.join(run, 'calls.jsonl')
    return {
      ...measure({
        task: TASKS.find(t => t.id === r.task),
        arm: r.arm,
        rep: r.rep,
        main: readJsonl(main),
        all: files.flatMap(readJsonl),
        calls: fs.existsSync(log) ? readJsonl(log) : [],
        seconds: r.seconds,
      }),
      accepted: r.accepted,
    }
  })

if (opts.report) {
  const dir = path.resolve(opts.report)
  report(remeasure(dir, readJsonl(path.join(dir, 'results.jsonl'))))
  process.exit(0)
}

const reps = Number(opts.reps ?? 3)
const maxSpend = Number(opts['max-spend'] ?? 5)
const model = opts.model ?? 'sonnet'
const taskIds = opts.tasks?.split(',') ?? TASKS.map(t => t.id)
const armIds = (opts.arms ?? 'direct,codemode,toolscript').split(',')
for (const a of armIds) if (!ARMS[a]) throw new Error(`unknown arm ${a}`)
const term = loadPty(path.resolve(opts['pty-dir'] ?? path.join(os.tmpdir(), 'ptytry')))
const bash = findBash(opts.bash)
if (!bash) throw new Error('no Git Bash found: Code Mode on Windows needs it, pass --bash')
const out = path.resolve(opts.out ?? path.join(ROOT, 'runs', new Date().toISOString().replace(/[:.]/g, '-')))
fs.mkdirSync(out, { recursive: true })
const resultsFile = path.join(out, 'results.jsonl')
const done = fs.existsSync(resultsFile) ? readJsonl(resultsFile) : []
let spent = spentSoFar(done, Number(opts.spent ?? 0))
for (const a of armIds) fs.mkdirSync(cwdOf(a), { recursive: true })

// Arms alternate inside each task, and their order flips every rep, so drift in load and cache hits all arms.
const jobs = []
for (let rep = 1; rep <= reps; rep++)
  for (const task of TASKS.filter(t => taskIds.includes(t.id)))
    for (const arm of rep % 2 ? armIds : [...armIds].reverse()) jobs.push({ task, arm, rep })
const todo = jobs.filter(j => !done.some(r => r.task === j.task.id && r.arm === j.arm && r.rep === j.rep))
const rows = [...done]
console.log(`${todo.length} runs to do into ${out}; spent so far $${spent.toFixed(4)}, cap $${maxSpend}`)

for (const [i, { task, arm, rep }] of todo.entries()) {
  const est = estimate(rows, arm, task.id)
  if (spent + est > maxSpend) {
    console.log(
      `stop: $${spent.toFixed(4)} spent, the next run (${task.id}-${arm}-${rep}) is estimated at $${est.toFixed(4)}`,
    )
    break
  }
  const dir = path.join(out, `${task.id}-${arm}-${rep}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, 'calls.jsonl')
  const mcp = path.join(dir, 'mcp.json')
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: ARMS[arm].servers({ dir, log }) }))
  const argv = [
    '--model',
    model,
    '--setting-sources',
    'project',
    '--disallowedTools',
    'Bash,PowerShell',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    mcp,
    '--allowedTools',
    ARMS[arm].allowed.join(','),
  ]
  forgetRuns([cwdOf(arm)])
  let result
  try {
    result = await drive({ term, bash, arm, argv, prompt: task.prompt, dir })
  } catch (err) {
    console.error(`${task.id}-${arm}-${rep}: ${err.message}`)
    const files = jsonlFiles(projectDir(cwdOf(arm)))
    const partial = files.flatMap(readJsonl)
    const cost = [
      ...new Map(
        partial
          .filter(e => e.type === 'assistant' && e.message?.id && e.message.model !== '<synthetic>')
          .map(e => [e.message.id, e.message]),
      ).values(),
    ].reduce((n, m) => n + priceOf(m.model, m.usage ?? {}), 0)
    spent += cost
    console.error(`stopped; that run cost $${cost.toFixed(4)}; total $${spent.toFixed(4)}`)
    forgetRuns([cwdOf(arm)])
    process.exit(1)
  }
  const saved = path.join(dir, 'transcript')
  const files = fs.readdirSync(saved).map(f => path.join(saved, f))
  const main = readJsonl(path.join(saved, result.mainName))
  const all = files.flatMap(readJsonl)
  const calls = fs.existsSync(log) ? readJsonl(log) : []
  const row = { ...measure({ task, arm, rep, main, all, calls, seconds: result.seconds }), accepted: result.accepted }
  for (const removed of forgetRuns([cwdOf(arm)])) console.log(`removed ${removed}`)
  rows.push(row)
  spent += row.costUsd
  fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`)
  console.log(
    `${String(i + 1).padStart(2)}/${todo.length} ${task.id}-${arm}-${rep} ${row.correct ? 'ok   ' : 'WRONG'}${row.cold ? ' cold' : '     '} api=${row.apiCalls} tools=${JSON.stringify(row.toolCalls)} inner=${JSON.stringify(row.innerCalls)} ctx=${row.toolResultChars} $${row.costUsd.toFixed(4)} total $${spent.toFixed(4)}`,
  )
}
report(rows)
