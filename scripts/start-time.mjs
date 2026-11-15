// Measures how long toolscript-mcp takes to start, the way a client starts it:
// the time from the spawn to the reply to initialize, and to the reply to
// tools/list. The config lists the bench fake server --servers times. The
// starts run one after the other. Run `npm run build` first.
//
//   node scripts/start-time.mjs [--runs 10] [--servers 1] [--main <main.js> | --bin <command> | --pack <folder>]
//
// --main runs `node <main.js>` (default dist/host/main.js). --bin runs an
// installed command, through a shell on Windows, as a client does with a .cmd.
// --pack packs the built package in <folder> one time. Each start then
// installs it in a new folder and runs its command for the first time: a
// cold start. It also gives the time of each install.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WIN = process.platform === 'win32'
const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '10' },
    servers: { type: 'string', default: '1' },
    main: { type: 'string' },
    bin: { type: 'string' },
    pack: { type: 'string' },
  },
})
const runs = Number(values.runs)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-start-'))
const config = path.join(dir, 'config.json')
const fake = { command: process.execPath, args: [path.join(ROOT, 'bench', 'fake-server.mjs')] }
const servers = Array.from({ length: Number(values.servers) }, (_, i) => [`bench${i + 1}`, fake])
fs.writeFileSync(config, JSON.stringify({ mcpServers: Object.fromEntries(servers) }))

// npm and the command npm makes are .cmd files on Windows, which Node starts only through a shell.
const quote = a => (WIN && /\s/.test(a) ? `"${a}"` : a)
const npm = (args, cwd) => {
  const r = spawnSync('npm', args.map(quote), { cwd, encoding: 'utf8', shell: WIN })
  assert.equal(r.status, 0, `npm ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout
}
const start = bin =>
  bin === undefined
    ? spawn(process.execPath, [
        path.resolve(values.main ?? path.join(ROOT, 'dist', 'host', 'main.js')),
        '--config',
        config,
      ])
    : spawn(quote(bin), ['--config', quote(config)], { shell: WIN })

const send = (child, msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)

const once = bin =>
  new Promise((resolve, reject) => {
    const t0 = performance.now()
    const child = start(bin)
    const times = {}
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`no tools/list reply in 60 s:\n${stderr}`))
    }, 60_000)
    child.stderr.on('data', d => (stderr += d))
    child.stdout.on('data', d => {
      buffer += d
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const msg = JSON.parse(buffer.slice(0, i))
        buffer = buffer.slice(i + 1)
        if (msg.id === 1) {
          assert.equal(msg.result?.serverInfo?.name, 'toolscript-mcp', JSON.stringify(msg))
          times.initialize = performance.now() - t0
          send(child, { jsonrpc: '2.0', method: 'notifications/initialized' })
          send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 2) {
          times.list = performance.now() - t0
          const names = msg.result?.tools?.map(t => t.name).sort()
          assert.deepEqual(names, ['run_code', 'search_tools'], JSON.stringify(msg))
          clearTimeout(timer)
          child.on('exit', () => resolve(times))
          child.stdin.end()
        }
      }
    })
    child.on('error', reject)
    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'start-time', version: '1' } },
    })
  })

// A new folder with the package installed, and the time of the install.
const install = (tarball, i) => {
  const app = path.join(dir, `app${i}`)
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ private: true }))
  const t0 = performance.now()
  npm(['install', '--no-audit', '--no-fund', tarball], app)
  const bin = path.join(app, 'node_modules', '.bin', WIN ? 'toolscript-mcp.cmd' : 'toolscript-mcp')
  return { bin, install: performance.now() - t0 }
}

const ms = n => `${Math.round(n)} ms`
const summary = list => {
  const sorted = [...list].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return `median ${ms(median)}, range ${ms(sorted[0])} to ${ms(sorted.at(-1))}`
}

try {
  const tarball =
    values.pack &&
    path.join(
      dir,
      JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', dir], values.pack))[0].filename,
    )
  const all = []
  for (let i = 0; i < runs; i++) {
    const installed = tarball ? install(tarball, i) : { bin: values.bin }
    const t = { ...(await once(installed.bin)), install: installed.install }
    all.push(t)
    const extra = tarball ? `, after an install of ${ms(t.install)}` : ''
    console.log(`start ${i + 1}: initialize ${ms(t.initialize)}, tools/list ${ms(t.list)}${extra}`)
  }
  const what = values.pack ? `${values.pack}, packed` : (values.bin ?? values.main ?? 'dist/host/main.js')
  console.log(`${what}: ${runs} ${tarball ? 'cold ' : ''}starts, ${servers.length} downstream servers`)
  console.log(`initialize: ${summary(all.map(t => t.initialize))}`)
  console.log(`tools/list: ${summary(all.map(t => t.list))}`)
  if (tarball) console.log(`install: ${summary(all.map(t => t.install))}`)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
