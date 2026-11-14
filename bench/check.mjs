// Judges one answer of a bench task with the same check as bench/run.mjs, for
// a run made by another agent (Codex, Cursor, a person) on any machine. It
// reads the answer text and the BENCH_LOG that bench/fake-server.mjs wrote for
// that run, and prints one JSON line. Exit 0 when correct, 1 when wrong, 2 on
// bad input.
//
//   node bench/check.mjs --task logs --answer answer.txt --log calls.jsonl
//   node bench/check.mjs --list      the task ids and prompts, as JSON lines

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { TASKS } from './data.mjs'

const USAGE = 'usage: node bench/check.mjs --task <id> --answer <file> --log <BENCH_LOG file> | --list'

let opts
try {
  opts = parseArgs({
    strict: true,
    options: {
      task: { type: 'string' },
      answer: { type: 'string' },
      log: { type: 'string' },
      list: { type: 'boolean' },
    },
  }).values
} catch (err) {
  console.error(`${err.message}\n${USAGE}`)
  process.exit(2)
}

if (opts.list) {
  for (const t of TASKS) console.log(JSON.stringify({ task: t.id, prompt: t.prompt, expected: t.expected }))
  process.exit(0)
}

const task = TASKS.find(t => t.id === opts.task)
if (task === undefined || opts.answer === undefined) {
  console.error(`${task === undefined ? `unknown task "${opts.task}"` : 'no --answer'}\n${USAGE}`)
  process.exit(2)
}

const answer = fs.readFileSync(opts.answer, 'utf8')
// A run with no call has no log file: the fake server writes on the first call.
const calls =
  opts.log !== undefined && fs.existsSync(opts.log)
    ? fs
        .readFileSync(opts.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []
const correct = task.check(answer, calls)
console.log(
  JSON.stringify({
    task: task.id,
    correct,
    expected: task.expected,
    mcpCalls: calls.length,
    serverChars: calls.reduce((n, c) => n + (c.chars ?? 0), 0),
    tools: calls.map(c => c.tool),
  }),
)
process.exit(correct ? 0 : 1)
