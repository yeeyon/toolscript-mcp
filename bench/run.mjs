// Token and cost bench: runs each task in headless Claude Code in two arms and
// compares them.
//   direct      the fake server's tools, listed to the model as mcp__bench__*
//   toolscript  only toolscript-mcp, whose config lists the fake server as bench
//
//   node bench/run.mjs                              5 reps of every task, both arms
//   node bench/run.mjs --reps 1 --tasks logs,ticket --arms toolscript
//   node bench/run.mjs --model haiku --parallel 3 --max-spend 3
//   node bench/run.mjs --report <out dir>           the tables again, with no new runs
//
// Run `npm run build` first. A run is `claude -p --restricted --strict-mcp-config`
// with `--no-session-persistence`: no user, project or local settings (so no
// user hooks and no user plugins), no other MCP servers, no Bash, and no
// transcript. --allowedTools lists exactly the arm's MCP tools. Each run has its
// own temp cwd, MCP config and BENCH_LOG. The stream of each run is kept in
// <out>/<run>/stream.jsonl, and <out>/results.jsonl holds one row per run.
// Claude Code still saves an MCP result that is too large to show in
// ~/.claude/projects/<cwd>/; forget.mjs removes that folder after each run.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { TASKS } from './data.mjs'
import { forgetRuns } from './forget.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FAKE_SERVER = path.join(REPO, 'bench', 'fake-server.mjs')
const TOOLSCRIPT = path.join(REPO, 'dist', 'host', 'main.js')
const NODE = process.execPath

const USAGE = `usage: node bench/run.mjs [--reps N] [--parallel N] [--max-spend USD] [--model NAME]
       [--tasks ${TASKS.map(t => t.id).join(',')}] [--arms direct,toolscript] [--out DIR]
       node bench/run.mjs --report DIR
Each run starts headless Claude Code and costs money. --max-spend stops the bench (default 3).`

// A flag this script does not know stops it before any run, so a typo or --help never spends money.
let opts
try {
  opts = parseArgs({
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      reps: { type: 'string' },
      parallel: { type: 'string' },
      'max-spend': { type: 'string' },
      model: { type: 'string' },
      tasks: { type: 'string' },
      arms: { type: 'string' },
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
const reps = Number(opts.reps ?? 5)
const parallel = Number(opts.parallel ?? 3)
const maxSpend = Number(opts['max-spend'] ?? 3)
const model = opts.model
const taskIds = opts.tasks?.split(',') ?? TASKS.map(t => t.id)
const armIds = (opts.arms ?? 'direct,toolscript').split(',')
const reportOnly = opts.report
const outArg =
  reportOnly ?? opts.out ?? path.join(os.tmpdir(), `toolscript-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(outArg, { recursive: true })
// The long form of the path: Claude Code's file tools refuse a cwd with a Windows short name such as USERNA~1.
const out = fs.realpathSync.native(outArg)
// A second run would write over the run folders of the first, and the report would count each new stream twice.
if (!reportOnly && fs.existsSync(path.join(out, 'results.jsonl'))) {
  console.error(`${path.join(out, 'results.jsonl')} exists: give --out a new folder, or use --report ${out}`)
  process.exit(1)
}

const benchServer = log => ({ command: NODE, args: [FAKE_SERVER], env: { BENCH_LOG: log } })

// What each arm puts in front of the model. `allowed` is the whole --allowedTools list.
const ARMS = {
  direct: {
    servers: ({ log }) => ({ bench: benchServer(log) }),
    allowed: benchTools => benchTools.map(t => `mcp__bench__${t}`),
  },
  toolscript: {
    servers: ({ dir, log }) => {
      const config = path.join(dir, 'toolscript.json')
      fs.writeFileSync(
        config,
        JSON.stringify({
          mcpServers: { bench: benchServer(log) },
          policy: [{ match: 'mcp__bench__*', action: 'allow' }],
        }),
      )
      return { toolscript: { command: NODE, args: [TOOLSCRIPT, '--config', config] } }
    },
    allowed: () => ['mcp__toolscript__run_code', 'mcp__toolscript__search_tools'],
  },
}

const readLines = file =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []

// The tools and instructions an MCP server lists, from initialize and tools/list over stdio.
const listServer = ({ command, args, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] })
    const replies = new Map()
    let buffer = ''
    child.stdout.on('data', d => {
      buffer += d
      for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
        const msg = JSON.parse(buffer.slice(0, i))
        replies.set(msg.id, msg.result)
        if (msg.id === 2) {
          child.stdin.end()
          resolve({ instructions: replies.get(1)?.instructions ?? '', tools: msg.result.tools })
        }
      }
    })
    child.on('error', reject)
    const send = msg => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } },
    })
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
  })

const sumUsage = u => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)

// The row of one run, from its stream-json events and its BENCH_LOG.
const measure = ({ task, arm, rep, events, calls, ms }) => {
  const result = events.findLast(e => e.type === 'result') ?? {}
  const init = events.find(e => e.type === 'system' && e.subtype === 'init') ?? {}
  // A message with several content blocks comes as several events with the same id and usage.
  const apiCalls = new Map()
  for (const e of events)
    if (e.type === 'assistant' && e.message?.id && !apiCalls.has(e.message.id)) apiCalls.set(e.message.id, e.message)
  const useBlocks = events.flatMap(e =>
    e.type === 'assistant' ? (e.message?.content ?? []).filter(b => b.type === 'tool_use') : [],
  )
  const uses = useBlocks.map(b => b.name)
  const toolOf = new Map(useBlocks.map(b => [b.id, b.name]))
  const results = events
    .flatMap(e => (e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : []))
    .filter(b => b.type === 'tool_result')
  const toolResultChars = results.reduce(
    (n, b) => n + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).length,
    0,
  )
  const usage = result.usage ?? {}
  const answer = String(result.result ?? '')
  const perCall = [...apiCalls.values()].map(m => ({
    input: sumUsage(m.usage),
    cacheRead: m.usage?.cache_read_input_tokens ?? 0,
    cacheCreation: m.usage?.cache_creation_input_tokens ?? 0,
  }))
  return {
    task: task.id,
    arm,
    rep,
    correct: result.is_error !== true && task.check(answer, calls),
    error: result.is_error === true ? String(result.subtype ?? 'error') : result.type ? '' : 'no result event',
    costUsd: result.total_cost_usd ?? 0,
    inputTokens: sumUsage(usage),
    freshInputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    firstCallInputTokens: perCall[0]?.input ?? 0,
    // The context every API call re-reads (system prompt, tool list, prompt), against what the turns added.
    fixedInputTokens: (perCall[0]?.input ?? 0) * perCall.length,
    thinkingTokens: Object.values(result.modelUsage ?? {}).reduce((n, m) => n + (m.thinkingTokens ?? 0), 0),
    apiCalls: apiCalls.size,
    perCall,
    turns: result.num_turns ?? 0,
    seconds: ms / 1000,
    mcpCalls: calls.length,
    runCode: uses.filter(n => n === 'mcp__toolscript__run_code').length,
    failedRunCode: results.filter(b => b.is_error === true && toolOf.get(b.tool_use_id) === 'mcp__toolscript__run_code')
      .length,
    searchTools: uses.filter(n => n === 'mcp__toolscript__search_tools').length,
    directBench: uses.filter(n => n.startsWith('mcp__bench__')).length,
    toolSearch: uses.filter(n => n === 'ToolSearch').length,
    otherTools: uses.filter(n => !/^mcp__(bench|toolscript)__/.test(n)),
    permissionDenied: events.filter(e => e.type === 'system' && e.subtype === 'permission_denied').length,
    serverChars: calls.reduce((n, c) => n + c.chars, 0),
    toolResultChars,
    hookEvents: events.filter(e => e.type === 'system' && /hook/i.test(String(e.subtype))).length,
    initTools: init.tools ?? [],
    initMcp: (init.mcp_servers ?? []).map(s => `${s.name}:${s.status}`),
    initPlugins: (init.plugins ?? []).map(p => p.name ?? p),
    models: Object.keys(result.modelUsage ?? {}),
    answer: answer.slice(0, 400),
  }
}

const runOne = async ({ task, arm, rep, benchTools }) => {
  const dir = path.join(out, `${task.id}-${arm}-${rep}`)
  const cwd = path.join(dir, 'cwd')
  fs.mkdirSync(cwd, { recursive: true })
  const log = path.join(dir, 'calls.jsonl')
  const mcp = path.join(dir, 'mcp.json')
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: ARMS[arm].servers({ dir, log }) }))
  const argv = [
    '-p',
    task.prompt,
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config',
    mcp,
    '--allowedTools',
    ARMS[arm].allowed(benchTools).join(','),
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--max-budget-usd',
    '0.5',
    ...(model ? ['--model', model] : []),
  ]
  const started = Date.now()
  const stdout = await new Promise(resolve => {
    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', d => (text += d))
    child.stderr.on('data', d => fs.appendFileSync(path.join(dir, 'stderr.txt'), d))
    child.on('close', () => resolve(text))
  })
  const ms = Date.now() - started
  fs.writeFileSync(path.join(dir, 'stream.jsonl'), stdout)
  return { cwd, row: measureDir({ task, arm, rep, dir, ms }) }
}

const measureDir = ({ task, arm, rep, dir, ms }) => {
  const events = fs
    .readFileSync(path.join(dir, 'stream.jsonl'), 'utf8')
    .split('\n')
    .flatMap(line => {
      try {
        return line.trim() ? [JSON.parse(line)] : []
      } catch {
        return []
      }
    })
  return measure({ task, arm, rep, events, calls: readLines(path.join(dir, 'calls.jsonl')), ms })
}

// The rows again from each run's stream and BENCH_LOG, so a metric added later covers old runs.
// Wall time is not in the stream, so it comes from the saved row.
const remeasure = rows =>
  rows.map(r =>
    measureDir({
      task: TASKS.find(t => t.id === r.task),
      arm: r.arm,
      rep: r.rep,
      dir: path.join(out, `${r.task}-${r.arm}-${r.rep}`),
      ms: r.seconds * 1000,
    }),
  )

const METRICS = [
  ['correct', r => (r.correct ? 1 : 0)],
  ['cost USD', r => r.costUsd, 4],
  ['input tokens (all)', r => r.inputTokens, 0],
  ['  fresh input', r => r.freshInputTokens, 0],
  ['  cache read', r => r.cacheReadTokens, 0],
  ['  cache creation', r => r.cacheCreationTokens, 0],
  ['first-call input', r => r.firstCallInputTokens, 0],
  ['fixed input (first call x API calls)', r => r.fixedInputTokens, 0],
  ['added input (all minus fixed)', r => r.inputTokens - r.fixedInputTokens, 0],
  ['output tokens', r => r.outputTokens, 0],
  ['  of which thinking', r => r.thinkingTokens, 0],
  ['turns', r => r.turns],
  ['API calls', r => r.apiCalls],
  ['seconds', r => r.seconds, 1],
  ['MCP calls (BENCH_LOG)', r => r.mcpCalls],
  ['server result chars (BENCH_LOG)', r => r.serverChars, 0],
  ['tool result chars in context', r => r.toolResultChars, 0],
  ['run_code calls', r => r.runCode],
  ['failed run_code calls', r => r.failedRunCode],
  ['search_tools calls', r => r.searchTools],
  ['direct mcp__bench__ calls', r => r.directBench],
  ['ToolSearch calls', r => r.toolSearch],
  ['built-in tool calls (ToolSearch too)', r => r.otherTools.length],
  ['permission denials', r => r.permissionDenied],
]

const sorted = xs => [...xs].sort((a, b) => a - b)
const median = xs => {
  const s = sorted(xs)
  const m = Math.floor(s.length / 2)
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = xs => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length)
const fmt = (v, d = 1) => (Number.isNaN(v) ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(d))

const report = rows => {
  const arms = Object.keys(ARMS).filter(a => rows.some(r => r.arm === a))
  const tasks = [...new Set(rows.map(r => r.task))]
  const of = (arm, task) => rows.filter(r => r.arm === arm && (task === undefined || r.task === task))
  console.log(`runs: ${arms.map(a => `${a} ${of(a).length}`).join(', ')}`)
  console.log(`total spend: $${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(4)}`)
  console.log(`models: ${[...new Set(rows.flatMap(r => r.models))].join(', ')}`)
  for (const arm of arms) {
    const rs = of(arm)
    console.log(`\n### ${arm} (${rs.length} runs, ${rs.filter(r => r.correct).length} correct)\n`)
    console.log('| metric | mean | median | min | max |')
    console.log('|---|---:|---:|---:|---:|')
    for (const [name, f, d] of METRICS.slice(1)) {
      const xs = rs.map(f)
      console.log(
        `| ${name.trim()} | ${fmt(mean(xs), d ?? 1)} | ${fmt(median(xs), d ?? 1)} | ${fmt(Math.min(...xs), d ?? 1)} | ${fmt(Math.max(...xs), d ?? 1)} |`,
      )
    }
  }
  if (arms.length === 2) {
    const [a, b] = arms
    console.log(`\n### per task: median (min to max), ${b} against ${a}\n`)
    console.log(
      `| task | correct ${a} | correct ${b} | cost ${a} | cost ${b} | cost change | input ${a} | input ${b} | output ${a} | output ${b} |`,
    )
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    const cell = (rs, f, d) => {
      const xs = rs.map(f)
      return `${fmt(median(xs), d)} (${fmt(Math.min(...xs), d)} to ${fmt(Math.max(...xs), d)})`
    }
    for (const task of [...tasks, undefined]) {
      const ra = of(a, task)
      const rb = of(b, task)
      const change = median(rb.map(r => r.costUsd)) / median(ra.map(r => r.costUsd)) - 1
      console.log(
        `| ${task ?? 'all'} | ${ra.filter(r => r.correct).length}/${ra.length} | ${rb.filter(r => r.correct).length}/${rb.length} | ${cell(ra, r => r.costUsd, 4)} | ${cell(rb, r => r.costUsd, 4)} | ${(100 * change).toFixed(0)}% | ${cell(ra, r => r.inputTokens, 0)} | ${cell(rb, r => r.inputTokens, 0)} | ${cell(ra, r => r.outputTokens, 0)} | ${cell(rb, r => r.outputTokens, 0)} |`,
      )
    }
    const behavior = [
      ['turns', r => r.turns],
      ['MCP calls', r => r.mcpCalls],
      ['search_tools', r => r.searchTools],
      ['run_code', r => r.runCode],
      ['failed run_code', r => r.failedRunCode],
      ['ToolSearch', r => r.toolSearch],
      ['server chars', r => r.serverChars],
      ['chars in context', r => r.toolResultChars],
    ]
    console.log(`\n### per task: median per run, ${a} / ${b}\n`)
    console.log(`| task | ${behavior.map(([name]) => name).join(' | ')} |`)
    console.log(`|---|${behavior.map(() => '---:').join('|')}|`)
    for (const task of [...tasks, undefined]) {
      const cells = behavior.map(
        ([, f]) => `${fmt(median(of(a, task).map(f)), 0)} / ${fmt(median(of(b, task).map(f)), 0)}`,
      )
      console.log(`| ${task ?? 'all'} | ${cells.join(' | ')} |`)
    }
  }
  const wrong = rows.filter(r => !r.correct)
  if (wrong.length > 0) {
    console.log('\n### wrong answers\n')
    for (const r of wrong)
      console.log(`- ${r.task}-${r.arm}-${r.rep}${r.error ? ` (${r.error})` : ''}: ${r.answer.replace(/\s+/g, ' ')}`)
  }
  const others = {}
  for (const name of rows.flatMap(r => r.otherTools)) others[name] = (others[name] ?? 0) + 1
  const counted = Object.entries(others).map(([n, k]) => `${n} ${k}`)
  console.log(`\nbuilt-in tools called: ${counted.join(', ') || 'none'}`)
  console.log(`plugins: ${[...new Set(rows.flatMap(r => r.initPlugins))].join(', ') || 'none'}`)
  const odd = rows.filter(r => r.hookEvents > 0 || r.initMcp.some(s => !s.endsWith(':connected')))
  for (const r of odd)
    console.log(`CHECK ${r.task}-${r.arm}-${r.rep}: ${r.hookEvents} hook events, MCP servers [${r.initMcp}]`)
  console.log(`\nrows: ${path.join(out, 'results.jsonl')}`)
}

if (reportOnly) {
  report(remeasure(readLines(path.join(out, 'results.jsonl'))))
} else {
  const probeDir = path.join(out, 'probe')
  fs.mkdirSync(probeDir, { recursive: true })
  const defs = {}
  for (const arm of armIds) {
    const servers = ARMS[arm].servers({ dir: probeDir, log: path.join(probeDir, 'calls.jsonl') })
    const listed = await Promise.all(Object.values(servers).map(listServer))
    defs[arm] = {
      tools: listed.flatMap(l => l.tools.map(t => t.name)),
      toolChars: listed.reduce((n, l) => n + JSON.stringify(l.tools).length, 0),
      instructionChars: listed.reduce((n, l) => n + l.instructions.length, 0),
    }
  }
  const benchTools = (await listServer(benchServer(path.join(probeDir, 'calls.jsonl')))).tools.map(t => t.name)
  fs.writeFileSync(path.join(out, 'definitions.json'), `${JSON.stringify(defs, null, 2)}\n`)
  for (const [arm, d] of Object.entries(defs))
    console.log(
      `${arm}: ${d.tools.join(', ')}: ${d.toolChars} chars of tool JSON, ${d.instructionChars} of instructions`,
    )

  // Arms alternate inside each rep, and their order flips every rep, so drift in model load hits both.
  const jobs = []
  for (let rep = 1; rep <= reps; rep++)
    for (const task of TASKS.filter(t => taskIds.includes(t.id)))
      for (const arm of rep % 2 ? armIds : [...armIds].reverse()) jobs.push({ task, arm, rep, benchTools })
  console.log(`${jobs.length} runs, ${parallel} at a time, stop after $${maxSpend}, into ${out}`)
  const rows = []
  let spent = 0
  let next = 0
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < jobs.length && spent < maxSpend) {
        const job = jobs[next++]
        const { cwd, row } = await runOne(job)
        for (const removed of forgetRuns([cwd])) console.log(`removed ${removed}`)
        rows.push(row)
        spent += row.costUsd
        fs.appendFileSync(path.join(out, 'results.jsonl'), `${JSON.stringify(row)}\n`)
        console.log(
          `${String(rows.length).padStart(3)}/${jobs.length} ${row.task}-${row.arm}-${row.rep} ${row.correct ? 'ok   ' : 'WRONG'} calls=${row.mcpCalls} run_code=${row.runCode} direct=${row.directBench} turns=${row.turns} in=${row.inputTokens} $${row.costUsd.toFixed(4)} total $${spent.toFixed(4)}`,
        )
      }
    }),
  )
  if (next < jobs.length) console.log(`stopped after $${spent.toFixed(4)}: ${jobs.length - next} runs not started`)
  report(rows)
}
