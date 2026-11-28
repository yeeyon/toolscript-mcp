// Issue #133: starts N brokers at once on a fresh HOME, as N hosts do after ENOENT, for R rounds, and counts the rounds
// where two brokers listened at the same time. Linux and macOS only (a Windows pipe vanishes with its process).
// No Docker and no model: a CI job runs it, or a person with a CPU limit.
//
//   npm run build
//   node bench/broker-race.mjs --contenders 20 --rounds 300
//
// A round passes when exactly one broker is left running and no two `listen` lines of the log overlap: the idle time is
// 10 s, so no broker leaves inside a round. Exit code 1 when a round fails.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : Number(process.argv[at + 1])
}
const contenders = arg('contenders', 6)
const rounds = arg('rounds', 100)
const BROKER = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'host', 'broker.js')
if (process.platform === 'win32') throw new Error('this bench needs sockets: run it on Linux or macOS')
if (!fs.existsSync(BROKER)) throw new Error('run `npm run build` first')
if (!Number.isInteger(contenders) || contenders < 2 || !Number.isInteger(rounds) || rounds < 1)
  throw new Error('usage: node bench/broker-race.mjs --contenders 20 --rounds 300')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-race-'))
// `start pid` and `exit` lines in order: two starts with no exit between them are two brokers at once.
const overlapped = log => {
  let open = 0
  for (const line of log.split('\n')) {
    if (/ start pid \d+$/.test(line) && ++open > 1) return true
    if (/ exit$/.test(line)) open--
  }
  return false
}
const counts = {}
let failed = 0
const began = Date.now()
for (let round = 0; round < rounds; round++) {
  const home = fs.mkdtempSync(path.join(root, 'h-'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, TOOLSCRIPT_BROKER_IDLE_MS: '10000' }
  const procs = Array.from({ length: contenders }, () => spawn(process.execPath, [BROKER], { env, stdio: 'ignore' }))
  const ended = procs.map(p => new Promise(resolve => p.once('exit', resolve)))
  let gone = 0
  procs.forEach(p => p.once('exit', () => gone++))
  const start = Date.now()
  while (gone < contenders - 1 && Date.now() - start < 8000) await new Promise(r => setTimeout(r, 20))
  await new Promise(r => setTimeout(r, 150))
  let log = ''
  try {
    log = fs.readFileSync(path.join(home, '.toolscript-mcp', 'broker', 'broker.log'), 'utf8')
  } catch {}
  const starts = (log.match(/start pid/g) ?? []).length
  const running = procs.filter(p => p.exitCode === null && p.signalCode === null).length
  const key = `starts=${starts} running=${running}${overlapped(log) ? ' OVERLAP' : ''}`
  counts[key] = (counts[key] ?? 0) + 1
  if (overlapped(log) || running !== 1) {
    failed++
    console.log(`round ${round}: ${key}\n${log}`)
  }
  for (const p of procs) p.kill('SIGKILL')
  await Promise.all(ended)
  fs.rmSync(home, { recursive: true, force: true })
}
fs.rmSync(root, { recursive: true, force: true })
console.log(
  `${rounds} rounds of ${contenders} contenders in ${Math.round((Date.now() - began) / 1000)} s: ${failed} rounds with two brokers at once or none left`,
  JSON.stringify(counts),
)
process.exit(failed === 0 ? 0 : 1)
