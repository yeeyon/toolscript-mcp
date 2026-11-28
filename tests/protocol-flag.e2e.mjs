// The protocol switch of #154, PR 9, on the built host (dist/host/main.js), with raw JSON-RPC and no SDK. Run `npm run build` first.
//
//   node tests/protocol-flag.e2e.mjs
//
// Case 1: `TOOLSCRIPT_PROTOCOL` unset, `legacy` and `auto` (also with a server in `TOOLSCRIPT_LEGACY_SERVERS`) give the same bytes:
//   one direct, one lazy, one shared and one HTTP link get the same first message, and `initialize` (version masked),
//   `tools/list`, the instructions and the empty `search_tools` result have the same SHA-256.
// Case 2: what a downstream server may not ask (#93). During a call, a direct and a shared stdio server send `roots/list`,
//   `elicitation/create` and `sampling/createMessage`. Each gets an error, and the program sees the result of the server.
// Case 3: a legacy link and an auto link of one command never share a child, also across hosts of one HOME. Two links of one
//   value share one, and a server in `TOOLSCRIPT_LEGACY_SERVERS` shares with `legacy`.
// Every process has a temp HOME, USERPROFILE and APPDATA. Each wait polls with a deadline, and each case ends its processes.

import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const FIRST = path.join(ROOT, 'tests', 'first-message-server.mjs')
const PID = path.join(ROOT, 'tests', 'pid-server.mjs')
const WIN = process.platform === 'win32'

const children = new Set()
const folders = []
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
const killPid = pid => {
  if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
}
const until = async (what, check, ms = 15_000) => {
  const end = Date.now() + ms
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s: ${what}`)
    await new Promise(r => setTimeout(r, 40))
  }
}
const tempDir = name => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `toolscript-protocol-${name}-`)))
  folders.push(dir)
  return dir
}
const newHome = () => {
  const home = path.join(tempDir('home'), 'home')
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  homes.add(home)
  return home
}
const homes = new Set()
const brokersAlive = home => {
  let log = ''
  try {
    log = fs.readFileSync(path.join(home, '.toolscript-mcp', 'broker', 'broker.log'), 'utf8')
  } catch {}
  return [...new Set([...log.matchAll(/start pid (\d+)/g)].map(m => Number(m[1])))].filter(alive)
}
const envOf = (home, extra) => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('TOOLSCRIPT_')) delete env[name]
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TOOLSCRIPT_SHARE: '1',
    TOOLSCRIPT_BROKER_IDLE_MS: '1000',
    TOOLSCRIPT_LAZY_IDLE_MS: '1000',
    ...extra,
  }
}
const cleanup = async () => {
  for (const child of children) if (child.pid !== undefined && child.exitCode === null) killPid(child.pid)
  children.clear()
  for (const home of homes) for (const pid of brokersAlive(home)) killPid(pid)
  homes.clear()
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

/** A host over stdio, spoken to with raw JSON-RPC. */
const startHost = (configFile, home, extra = {}) => {
  const child = spawn(process.execPath, [MAIN, '--config', configFile], {
    env: envOf(home, extra),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-4000)))
  let buffer = ''
  const waiting = new Map()
  child.stdout.on('data', d => {
    buffer += d
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      try {
        const msg = JSON.parse(line)
        waiting.get(msg.id)?.(msg)
      } catch {}
    }
  })
  let exited = false
  child.on('exit', () => (exited = true))
  let id = 0
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${stderr.trim()}`)), 60_000)
      waiting.set(mine, msg => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n')
    })
  const host = {
    stderr: () => stderr,
    async open() {
      const init = await ask('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'protocol-flag', version: '0' },
      })
      assert.ok(!init.error && init.result?.serverInfo, `initialize: ${JSON.stringify(init)}`)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      host.init = init
      return host
    },
    ask,
    async tool(name, args) {
      const reply = await ask('tools/call', { name, arguments: args })
      assert.ok(!reply.error, `${name}: ${JSON.stringify(reply.error)}`)
      return {
        reply,
        text: reply.result.content.map(b => b.text ?? '').join(''),
        isError: reply.result.isError === true,
      }
    },
    run: code => host.tool('run_code', { code }),
    async close() {
      child.stdin.end()
      await until('host exit', () => exited, 20_000).catch(() => killPid(child.pid))
      await until('host exit after a kill', () => exited, 10_000)
    },
  }
  return host
}

const writeConfig = config => {
  const file = path.join(tempDir('config'), 'config.json')
  fs.writeFileSync(file, JSON.stringify(config))
  return file
}
const sha = text => crypto.createHash('sha256').update(text).digest('hex')

/** A raw HTTP MCP server (no session, no auth). It keeps its first request. */
const startHttp = async () => {
  const seen = { first: undefined }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    if (seen.first === undefined)
      seen.first = JSON.stringify({
        method: req.method,
        url: req.url,
        accept: req.headers.accept,
        type: req.headers['content-type'],
        version: req.headers['mcp-protocol-version'],
        body,
      })
    if (req.method !== 'POST') return void res.writeHead(405).end()
    const msg = JSON.parse(body)
    if (msg.id === undefined) return void res.writeHead(202).end()
    const result =
      msg.method === 'initialize'
        ? {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'http-fake', version: '1' },
          }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'pong' }] }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () => new Promise(resolve => (server.closeAllConnections(), server.close(resolve))),
  }
}

// --- case 1 and 2: the same bytes in every mode, and what a downstream server may not ask ----------------------------------

/** The version of toolscript-mcp in the clientInfo of a first message, which a release changes. */
const maskVersion = text => text.replace(/(toolscript-mcp\\?",\\?"version\\?":\\?")[^"\\]*/, '$1<version>')
const PINNED_STDIO =
  '{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"toolscript-mcp","version":"<version>"}},"jsonrpc":"2.0","id":0}'
// A shared child gets the initialize of the broker, not the one of the host.
const PINNED_SHARED =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"toolscript-mcp-broker","version":"1"}}}'
const PINNED_FIRSTS = {
  direct: PINNED_STDIO,
  lazy: PINNED_STDIO,
  shared: PINNED_SHARED,
  web: '{"method":"POST","url":"/mcp","accept":"application/json, text/event-stream","type":"application/json","body":"{\\"method\\":\\"initialize\\",\\"params\\":{\\"protocolVersion\\":\\"2025-11-25\\",\\"capabilities\\":{},\\"clientInfo\\":{\\"name\\":\\"toolscript-mcp\\",\\"version\\":\\"<version>\\"}},\\"jsonrpc\\":\\"2.0\\",\\"id\\":0}"}',
}

const MODES = [
  ['unset', {}],
  ['legacy', { TOOLSCRIPT_PROTOCOL: 'legacy' }],
  ['auto', { TOOLSCRIPT_PROTOCOL: 'auto' }],
  ['auto, shared and lazy in the list', { TOOLSCRIPT_PROTOCOL: 'auto', TOOLSCRIPT_LEGACY_SERVERS: 'shared,lazy' }],
  ['auto, http in the list', { TOOLSCRIPT_PROTOCOL: 'auto', TOOLSCRIPT_LEGACY_SERVERS: 'web' }],
]
const ASK = 'return await call("mcp__KEY__ask", {})'

const bytesCase = async () => {
  const web = await startHttp()
  try {
    const out = []
    for (const [mode, extra] of MODES) {
      web.seen.first = undefined
      const dir = tempDir('logs')
      const log = name => path.join(dir, name + '.log')
      const home = newHome()
      const config = writeConfig({
        sandbox: { timeoutSeconds: 30, callTimeoutSeconds: 20 },
        policy: [{ match: 'mcp__*', action: 'allow' }],
        mcpServers: {
          direct: { command: process.execPath, args: [FIRST, `--log=${log('direct')}`], share: false },
          lazy: { command: process.execPath, args: [FIRST, `--log=${log('lazy')}`], share: false, lazy: true },
          shared: { command: process.execPath, args: [FIRST, `--log=${log('shared')}`], share: true },
          web: { type: 'http', url: web.url },
        },
      })
      const host = await startHost(config, home, extra).open()
      try {
        const answers = {}
        for (const key of ['direct', 'lazy', 'shared']) {
          const r = await host.run(ASK.replace('KEY', key))
          assert.ok(!r.isError, `${mode}: ${key}: ${r.text.slice(0, 400)}`)
          answers[key] = r.text
        }
        const ping = await host.run('return await call("mcp__web__ping", {})')
        assert.ok(!ping.isError && ping.text.includes('pong'), `${mode}: web: ${ping.text.slice(0, 300)}`)
        const list = await host.ask('tools/list', {})
        const search = await host.tool('search_tools', { query: '' })
        const init = JSON.parse(JSON.stringify(host.init.result))
        init.serverInfo.version = '<version>'
        const firsts = {}
        for (const key of ['direct', 'lazy', 'shared'])
          firsts[key] = await until(`${mode}: the first message of ${key}`, () => {
            try {
              // A lazy server that woke again logs one first line for each start: the first start is the one compared.
              return fs.readFileSync(log(key), 'utf8').split('\n')[0] || undefined
            } catch {
              return undefined
            }
          })
        firsts.web = web.seen.first
        out.push({
          mode,
          firsts,
          answers,
          hashes: [
            sha(JSON.stringify(init)),
            sha(JSON.stringify(list.result)),
            sha(host.init.result.instructions),
            sha(JSON.stringify(search.reply.result)),
          ],
        })
      } finally {
        await host.close()
      }
      await until('the broker to end', () => brokersAlive(home).length === 0)
    }
    const [base, ...rest] = out
    // The unset row is pinned to what 1.0.5 sends (the text below is the output of the v1.0.5 build, recorded once with
    // TOOLSCRIPT_E2E_MAIN set to its dist/host/main.js). Only the version of toolscript-mcp is masked.
    for (const [key, text] of Object.entries(base.firsts))
      assert.equal(maskVersion(text), PINNED_FIRSTS[key], `the unset row's first message of ${key} differs from 1.0.5`)
    for (const row of rest) {
      assert.deepEqual(
        row.hashes,
        base.hashes,
        `${row.mode}: initialize, tools/list, instructions or search_tools differ from unset`,
      )
      for (const key of Object.keys(base.firsts))
        assert.equal(row.firsts[key], base.firsts[key], `${row.mode}: the first message of ${key} differs from unset`)
    }
    // Case 2 (#93): the three requests of a downstream server get an error, and the program sees the server's own result.
    for (const row of out)
      for (const key of ['direct', 'shared']) {
        const text = row.answers[key]
        const parsed = JSON.parse(text.slice(0, text.indexOf('\n\n---') === -1 ? undefined : text.indexOf('\n\n---')))
        const result = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
        assert.deepEqual(
          result.map(a => a.method),
          ['roots/list', 'elicitation/create', 'sampling/createMessage'],
          `${row.mode}: ${key}`,
        )
        for (const a of result) {
          assert.equal(a.result, undefined, `${row.mode}: ${key}: ${a.method} got a result`)
          assert.equal(a.error?.code, -32601, `${row.mode}: ${key}: ${a.method}: ${JSON.stringify(a.error)}`)
        }
      }
  } finally {
    await web.close()
  }
}

// --- case 3: one child or two ---------------------------------------------------------------------------------------------

const childrenCase = async () => {
  const home = newHome()
  const config = writeConfig({
    sandbox: { timeoutSeconds: 30, callTimeoutSeconds: 20 },
    policy: [{ match: 'mcp__pid__pid', action: 'allow' }],
    mcpServers: { pid: { command: process.execPath, args: [PID], share: true } },
  })
  const hosts = []
  const pidOf = async extra => {
    const host = await startHost(config, home, extra).open()
    hosts.push(host)
    const r = await host.run('return "PID=" + String(await call("mcp__pid__pid", {}))')
    const pid = Number(/PID=(\d+)/.exec(r.text)?.[1])
    assert.ok(pid > 0, `no pid: ${r.text.slice(0, 300)}`)
    return pid
  }
  const pids = []
  try {
    const rows = {
      legacy1: {},
      legacy2: { TOOLSCRIPT_PROTOCOL: 'legacy' },
      auto1: { TOOLSCRIPT_PROTOCOL: 'auto' },
      auto2: { TOOLSCRIPT_PROTOCOL: 'auto' },
      listed: { TOOLSCRIPT_PROTOCOL: 'auto', TOOLSCRIPT_LEGACY_SERVERS: 'pid' },
    }
    const got = {}
    for (const [name, extra] of Object.entries(rows)) {
      got[name] = await pidOf(extra)
      pids.push(got[name])
    }
    assert.equal(got.legacy1, got.legacy2, 'unset and legacy share one child')
    assert.equal(got.auto1, got.auto2, 'two auto links share one child')
    assert.notEqual(got.legacy1, got.auto1, 'a legacy link and an auto link never share a child')
    assert.equal(got.listed, got.legacy1, 'a server in TOOLSCRIPT_LEGACY_SERVERS shares with legacy')
    assert.equal(brokersAlive(home).length, 1, 'one broker holds both children')
  } finally {
    await Promise.all(hosts.map(h => h.close().catch(() => {})))
  }
  await until('no broker and no child left', () => brokersAlive(home).length === 0 && !pids.some(alive))
}

const cases = [
  ['1 and 2: the same bytes in every mode, and what a downstream server may not ask', bytesCase],
  ['3: a legacy link and an auto link never share a child', childrenCase],
]
let failed = 0
for (const [name, run] of cases) {
  const t = Date.now()
  try {
    await run()
    console.log(`pass  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  } catch (err) {
    failed++
    console.log(
      `FAIL  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s): ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    await cleanup()
  }
}
process.exit(failed === 0 ? 0 : 1)
