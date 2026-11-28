// Runs the shared bench fixture through one Codex CLI session at a time.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import crossSpawn from 'cross-spawn'
import { TASKS } from './data.mjs'
import { scrubHome } from './scrub.mjs'

const bench = import.meta.dirname
const host = path.join(bench, '..', 'dist', 'host', 'main.js')
const arms = ['codex-direct', 'codex-codemode', 'codex-toolscript']
const usage = `usage: node bench/codex.mjs --model <slug> --reps <1..3> [--tasks <ids>] [--arms <ids>] [--out <new folder>]
       node bench/codex.mjs --dry-run [--reps <1..3>] [--tasks <ids>] [--arms <ids>]`

const jsonLines = text =>
  text
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
const select = (value, valid) => {
  if (value === undefined) return valid
  const items = value.split(',')
  if (new Set(items).size !== items.length || items.some(item => !valid.includes(item))) {
    throw new Error(`choose distinct values from ${valid.join(', ')}`)
  }
  return items
}

const capture = (command, args, accepted = [0]) => {
  const result = crossSpawn.sync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!accepted.includes(result.status)) {
    throw new Error(`${command}: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return result.stdout
}

const serverArgs = (arm, folder) => {
  const log = path.join(folder, 'calls.jsonl')
  const fixture = {
    command: process.execPath,
    args: [path.join(bench, 'fake-server.mjs')],
    env: { BENCH_LOG: log },
  }
  const config = path.join(folder, 'toolscript.json')
  const viaToolscript = arm === 'codex-toolscript'
  if (viaToolscript) {
    fs.writeFileSync(
      config,
      JSON.stringify({ mcpServers: { bench: fixture }, policy: [{ match: 'mcp__bench__*', action: 'allow' }] }),
    )
  }
  const server = viaToolscript ? 'toolscript' : 'bench'
  const entry = viaToolscript ? { command: process.execPath, args: [host, '--config', config] } : fixture
  const prefix = `mcp_servers.${server}`
  const omit = arm === 'codex-codemode' ? ['direct', 'deferred'] : ['code_mode']
  return [
    '-c',
    `${prefix}.command=${JSON.stringify(entry.command)}`,
    '-c',
    `${prefix}.args=${JSON.stringify(entry.args)}`,
    '-c',
    `${prefix}.required=true`,
    '-c',
    `${prefix}.default_tools_approval_mode="approve"`,
    '-c',
    `${prefix}.omit_tools_from=${JSON.stringify(omit)}`,
    ...(!viaToolscript ? ['-c', `${prefix}.env.BENCH_LOG=${JSON.stringify(log)}`] : []),
  ]
}

const run = ({ task, arm, rep }, out, model, codexVersion) => {
  const folder = path.join(out, `rep-${rep}-${task.id}-${arm}`)
  const cwd = path.join(folder, 'work')
  fs.mkdirSync(folder)
  fs.mkdirSync(cwd)
  const answer = path.join(folder, 'answer.txt')
  const eventsPath = path.join(folder, 'events.jsonl')
  const args = [
    'exec',
    '--ignore-user-config',
    '--strict-config',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--cd',
    cwd,
    '--model',
    model,
    '--output-last-message',
    answer,
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'hooks',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--disable',
    'code_mode_only',
    arm === 'codex-codemode' ? '--enable' : '--disable',
    'code_mode',
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    ...serverArgs(arm, folder),
    task.prompt,
  ]
  const started = performance.now()
  const eventsFile = fs.openSync(eventsPath, 'wx')
  const stderrFile = fs.openSync(path.join(folder, 'stderr.txt'), 'wx')
  let result
  try {
    result = crossSpawn.sync('codex', args, { cwd, timeout: 180_000, stdio: ['ignore', eventsFile, stderrFile] })
  } finally {
    fs.closeSync(eventsFile)
    fs.closeSync(stderrFile)
  }
  const seconds = (performance.now() - started) / 1000
  if (result.status !== 0)
    throw new Error(`${arm}/${task.id}: ${result.error?.code ?? `exit ${result.status}`}. See ${folder}`)
  const events = jsonLines(fs.readFileSync(eventsPath, 'utf8'))
  const usage = events.findLast(event => event.type === 'turn.completed')?.usage
  if (!usage || !fs.existsSync(answer))
    throw new Error(`${arm}/${task.id}: missing completed turn or answer. See ${folder}`)
  const checked = JSON.parse(
    capture(
      process.execPath,
      [path.join(bench, 'check.mjs'), '--task', task.id, '--answer', answer, '--log', path.join(folder, 'calls.jsonl')],
      [0, 1],
    ),
  )
  const items = events.filter(event => event.type === 'item.completed').map(event => event.item)
  const calls = items.filter(item => item.type === 'mcp_tool_call')
  const toolCalls = calls.map(call => `${call.server}/${call.tool}`)
  const server = arm === 'codex-toolscript' ? 'toolscript' : 'bench'
  if (
    calls.some(call => call.server !== server) ||
    items.some(item => ['command_execution', 'file_change', 'web_search'].includes(item.type))
  ) {
    throw new Error(`${arm}/${task.id}: a tool outside the bench was used. See ${folder}`)
  }
  return {
    ...checked,
    correct: checked.correct && checked.mcpCalls > 0,
    arm,
    rep,
    model,
    codexVersion,
    seconds,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    toolCalls,
    toolResultChars:
      arm !== 'codex-codemode' && calls.length
        ? calls.reduce((total, call) => {
            const text = call.result?.content
              ?.filter(block => block.type === 'text')
              .map(block => block.text)
              .join('')
            return total + (text?.length ?? 0)
          }, 0)
        : null,
  }
}

const main = () => {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      reps: { type: 'string' },
      tasks: { type: 'string' },
      arms: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) return console.log(usage)
  const dry = values['dry-run']
  const reps = values.reps ?? (dry ? '3' : '')
  if (!/^[1-3]$/.test(reps) || (!dry && !values.model)) throw new Error(usage)
  const tasks = select(
    values.tasks,
    TASKS.map(task => task.id),
  ).map(id => TASKS.find(task => task.id === id))
  const selected = select(values.arms, arms)
  const schedule = []
  for (let rep = 1; rep <= Number(reps); rep++) {
    const offset = (rep - 1) % selected.length
    const order = [...selected.slice(offset), ...selected.slice(0, offset)]
    for (const task of tasks) for (const arm of order) schedule.push({ task, arm, rep })
  }
  if (dry) {
    for (const row of schedule) console.log(JSON.stringify({ ...row, task: row.task.id }))
    return
  }

  const model = values.model
  const codexVersion = capture('codex', ['--version']).trim()
  const catalog = JSON.parse(capture('codex', ['debug', 'models']))
  const entry = catalog.models.find(item => item.slug === model && item.visibility === 'list')
  if (!entry) throw new Error(`${model} is absent from the Codex model picker for this login.`)
  const native = selected.includes('codex-codemode')
  const direct = selected.some(arm => arm !== 'codex-codemode')
  if (
    (direct && ['code_mode', 'code_mode_only'].includes(entry.tool_mode)) ||
    (native && entry.tool_mode === 'direct')
  ) {
    throw new Error(`${model} forces tool mode ${entry.tool_mode}. Select a model that supports the requested arms.`)
  }
  if (selected.includes('codex-toolscript') && !fs.existsSync(host)) throw new Error('Run npm run build first.')
  const out = values.out ? path.resolve(values.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-codex-'))
  if (values.out) fs.mkdirSync(out, { mode: 0o700 })
  console.error(`Results: ${scrubHome(out)}`)
  for (const row of schedule) {
    console.error(`Run ${row.rep}/${reps} ${row.task.id} ${row.arm}`)
    const line = `${JSON.stringify(run(row, out, model, codexVersion))}\n`
    fs.appendFileSync(path.join(out, 'results.jsonl'), line)
    process.stdout.write(line)
  }
}

try {
  main()
} catch (error) {
  console.error(scrubHome(error.message))
  process.exitCode = 1
}
