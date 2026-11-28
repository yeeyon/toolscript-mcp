// The upgrade test of 1.1.0 (the R1 gate): a built 1.0.5 (--base) and a built head (--head) on one HOME. Plain Node, no SDK:
// every host is the real dist/host/main.js, spoken to with raw JSON-RPC over stdio, and every fake server is node:http or a
// raw stdio file. Not part of npm test: the `baseline` job of stress.yml runs it after the measurements. With no --base it
// prints one line and exits 0, as bridge.e2e.mjs does.
//
//   node tests/upgrade.e2e.mjs --base <built 1.0.5 dir> --head <built dir>
//
// Case 6: an OAuth store both ways. A store as 1.0.5 writes it, with an expired access token, is refreshed by the base host,
//   then by the head host, then by the base host again (and head, base, head), on one HOME. Each refresh sends the refresh
//   token that the build before saved, no build asks for a login, and the store parses and is 0600 after each step.
// Case 7: mixed hosts. One HOME, sharing on, one shared stdio server. A base host and a head host start at once and each
//   makes 3 calls. One broker when the two broker.js files are equal, two when they differ, and nothing left after both close.
// Case 8: the rollback read. The head host leaves its files on a HOME, the base host reads that HOME and config (doctor as
//   on a fresh HOME, tools/list, run_code, search_tools), then the reverse.
//
// Every process has a temp HOME, USERPROFILE and APPDATA, never the real ones. No wait is a fixed sleep: each polls with a
// deadline. Each case ends its processes in a `finally`, also on failure.

import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WIN = process.platform === 'win32'
const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } })
if (values.base === undefined) {
  console.log('skipped: no --base (a built 1.0.5 directory)')
  process.exit(0)
}
const build = (name, dir) => {
  const root = path.resolve(dir)
  const main = path.join(root, 'dist', 'host', 'main.js')
  const broker = path.join(root, 'dist', 'host', 'broker.js')
  for (const file of [main, broker])
    if (!fs.existsSync(file)) throw new Error(`${name}: ${file} is missing: build it first`)
  return { name, root, main, brokerHash: crypto.createHash('sha256').update(fs.readFileSync(broker)).digest('hex') }
}
const BASE = build('base', values.base)
const HEAD = build('head', values.head ?? ROOT)
const other = b => (b === BASE ? HEAD : BASE)
// The fake servers are the files of this checkout, whichever builds run.
const PID_SERVER = path.join(ROOT, 'tests', 'pid-server.mjs')
const DEMO_SERVER = path.join(ROOT, 'demo', 'server.mjs')

// --- processes and folders, all ended in the `finally` of a case ---------------------------------------------------------

const children = new Set()
const pids = new Set()
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
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `toolscript-upgrade-${name}-`)))
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
const STATE = home => path.join(home, '.toolscript-mcp')
const brokerLog = home => {
  try {
    return fs.readFileSync(path.join(STATE(home), 'broker', 'broker.log'), 'utf8')
  } catch {
    return ''
  }
}
/** The pids of every broker that started on this HOME and still runs. */
const brokersAlive = home =>
  [...new Set([...brokerLog(home).matchAll(/start pid (\d+)/g)].map(m => Number(m[1])))].filter(alive)

/** The environment of a process: the real one without the TOOLSCRIPT_ variables, and a temp HOME. */
const envOf = (home, extra = {}) => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('TOOLSCRIPT_')) delete env[name]
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), ...extra }
}

const cleanup = async () => {
  for (const child of children) if (child.pid !== undefined && child.exitCode === null) killPid(child.pid)
  children.clear()
  for (const home of homes) for (const pid of brokersAlive(home)) killPid(pid)
  for (const pid of pids) if (alive(pid)) killPid(pid)
  homes.clear()
  pids.clear()
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

// --- a host of a build, spoken to with raw JSON-RPC ----------------------------------------------------------------------

const startHost = (b, configFile, home, extra = {}) => {
  const label = b.name
  const child = spawn(process.execPath, [b.main, '--config', configFile], {
    env: envOf(home, extra),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-2000)))
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
  const ask = (method, params, ms = 60_000) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      const timer = setTimeout(
        () =>
          reject(
            new Error(`${label}: ${method} timed out${exited ? ' (the host exited)' : ''}. stderr: ${stderr.trim()}`),
          ),
        ms,
      )
      waiting.set(mine, msg => {
        clearTimeout(timer)
        resolve(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n')
    })
  const host = {
    label,
    stderr: () => stderr,
    async open() {
      const init = await ask('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'upgrade', version: '0' },
      })
      assert.ok(!init.error && init.result?.serverInfo, `${label}: initialize: ${JSON.stringify(init)}`)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      return host
    },
    async tool(name, args) {
      const reply = await ask('tools/call', { name, arguments: args })
      assert.ok(!reply.error, `${label}: ${name} returned an RPC error: ${JSON.stringify(reply.error)}`)
      return {
        text: (reply.result.content ?? []).map(b => b.text ?? '').join(''),
        isError: reply.result.isError === true,
      }
    },
    search: async (query = '') => (await host.tool('search_tools', { query })).text,
    run: code => host.tool('run_code', { code }),
    list: async () => {
      const reply = await ask('tools/list', {})
      assert.ok(!reply.error && Array.isArray(reply.result?.tools), `${label}: tools/list: ${JSON.stringify(reply)}`)
      return reply.result.tools.map(t => t.name)
    },
    /** End the host the way a client does (stdin closes), and wait for it. */
    async close() {
      child.stdin.end()
      await until(`${label} host exit`, () => exited, 20_000).catch(() => killPid(child.pid))
      await until(`${label} host exit after a kill`, () => exited, 10_000)
    },
  }
  return host
}

const writeConfig = config => {
  const file = path.join(tempDir('config'), 'config.json')
  fs.writeFileSync(file, JSON.stringify(config))
  return file
}

// --- case 6: the OAuth store both ways ----------------------------------------------------------------------------------

const json = (res, status, value) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
const readBody = async req => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** A raw MCP server over HTTP that needs a bearer token, with OAuth metadata and a token endpoint that rotates the refresh token. */
const startOauthServer = async () => {
  const access = new Set()
  const refresh = new Set()
  const seen = { refreshes: [], authorizations: 0, registrations: 0, lastRefresh: '' }
  let n = 0
  let base = ''
  const issue = () => {
    const tokens = {
      access_token: `fake-access-${++n}`,
      refresh_token: `fake-refresh-${n}`,
      token_type: 'Bearer',
      expires_in: 3600,
    }
    access.add(tokens.access_token)
    refresh.add(tokens.refresh_token)
    seen.lastRefresh = tokens.refresh_token
    return tokens
  }
  const mcp = async (req, res) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const text = req.method === 'POST' ? await readBody(req) : ''
    if (bearer === undefined || !access.has(bearer))
      return void res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    if (req.method !== 'POST') return void res.writeHead(405).end()
    const msg = JSON.parse(text)
    if (msg.id === undefined) return void res.writeHead(202).end()
    const reply = result => json(res, 200, { jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize')
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-oauth', version: '1.0.0' },
      })
    if (msg.method === 'tools/list')
      return reply({ tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }] })
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'pong' }] })
    return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    if (url.pathname === '/register') return (seen.registrations++, void res.writeHead(400).end())
    if (url.pathname === '/authorize') return (seen.authorizations++, void res.writeHead(400).end())
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req))
      const sent = form.get('refresh_token') ?? ''
      if (form.get('grant_type') !== 'refresh_token' || !refresh.has(sent))
        return json(res, 400, { error: 'invalid_grant' })
      seen.refreshes.push(sent)
      refresh.delete(sent)
      return json(res, 200, issue())
    }
    if (url.pathname.startsWith('/mcp')) return mcp(req, res)
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  const first = issue()
  access.clear() // the access token of the store is expired
  return {
    url: `${base}/mcp`,
    base,
    seen,
    firstRefresh: first.refresh_token,
    /** Every access token stops working, as when they expire. */
    expire: () => access.clear(),
    close: () => new Promise(resolve => (server.closeAllConnections(), server.close(resolve))),
  }
}

const storeFile = (home, key, url) =>
  path.join(STATE(home), 'oauth', `${key}-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}.json`)

/** The store as 1.0.5 writes it: a client that login registered and tokens with an expired access token. */
const writeStore = (home, file, fake, issuer) => {
  const redirect = 'http://127.0.0.1:43111/callback'
  const stamp = issuer ? { issuer: fake.base } : {}
  const store = {
    client: {
      info: {
        client_id: 'fake-client-1',
        redirect_uris: [redirect],
        client_name: 'toolscript-mcp',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...stamp,
      },
      redirectUrl: redirect,
    },
    tokens: { access_token: 'expired-access', refresh_token: fake.firstRefresh, token_type: 'Bearer', ...stamp },
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
  void home
}

const oauthCase = (first, issuer) => async () => {
  const fake = await startOauthServer()
  try {
    const home = newHome()
    const file = storeFile(home, 'fake', fake.url)
    writeStore(home, file, fake, issuer)
    const config = writeConfig({ share: false, mcpServers: { fake: { type: 'http', url: fake.url } } })
    const builds = [first, other(first), first]
    let expected = fake.firstRefresh
    for (const [step, b] of builds.entries()) {
      const where = `step ${step + 1} (${b.name})`
      fake.expire()
      const host = await startHost(b, config, home).open()
      try {
        const text = await host.search()
        assert.ok(/fake: 1 tool: ping/.test(text), `${where}: the tool is not listed: ${text.slice(0, 400)}`)
        assert.ok(!/OAuth login/.test(text), `${where}: asked for a login: ${text.slice(0, 400)}`)
      } finally {
        await host.close()
      }
      assert.equal(
        fake.seen.refreshes.length,
        step + 1,
        `${where}: refreshes at the token endpoint: ${fake.seen.refreshes.length}`,
      )
      assert.equal(
        fake.seen.refreshes[step],
        expected,
        `${where}: sent a refresh token that the build before did not save`,
      )
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(
        stored.tokens?.refresh_token,
        fake.seen.lastRefresh,
        `${where}: the store does not hold the new refresh token`,
      )
      assert.ok(stored.client?.info?.client_id, `${where}: the store lost its client`)
      if (!WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${where}: the store is not 0600`)
      expected = fake.seen.lastRefresh
    }
    assert.equal(fake.seen.authorizations + fake.seen.registrations, 0, 'a build started a login')
  } finally {
    await fake.close()
  }
}

// --- case 7: mixed hosts on one broker or two ---------------------------------------------------------------------------

const mixedCase = async () => {
  const home = newHome()
  const config = writeConfig({
    sandbox: { timeoutSeconds: 30, callTimeoutSeconds: 20 },
    policy: [{ match: 'mcp__pid__pid', action: 'allow' }],
    mcpServers: { pid: { command: process.execPath, args: [PID_SERVER], share: true } },
  })
  const extra = { TOOLSCRIPT_SHARE: '1', TOOLSCRIPT_BROKER_IDLE_MS: '1000' }
  const program = 'return "PID=" + String(await call("mcp__pid__pid", {}))'
  const answers = []
  const hosts = await Promise.all([BASE, HEAD].map(b => startHost(b, config, home, extra).open()))
  try {
    await Promise.all(
      hosts.map(async host => {
        for (let i = 0; i < 3; i++) {
          const r = await host.run(program)
          const pid = Number(/PID=(\d+)/.exec(r.text)?.[1])
          assert.ok(!r.isError && pid > 0, `${host.label}: call ${i + 1} gave no pid: ${r.text.slice(0, 300)}`)
          answers.push(pid)
          pids.add(pid)
        }
      }),
    )
    assert.equal(answers.length, 6, 'all 6 answers')
    const equal = BASE.brokerHash === HEAD.brokerHash
    const running = brokersAlive(home)
    assert.equal(
      running.length,
      equal ? 1 : 2,
      `${running.length} brokers run, and the broker.js files ${equal ? 'are' : 'are not'} equal`,
    )
  } finally {
    await Promise.all(hosts.map(h => h.close().catch(() => {})))
  }
  await until(
    'no broker and no shared server left after both hosts closed',
    () => brokersAlive(home).length === 0 && ![...pids].some(alive),
  )
}

// --- case 8: the rollback read --------------------------------------------------------------------------------------------

/** The exit code of `doctor` and its problem lines (warn and fail), with the HOME written as <home>. */
const doctor = (b, configFile, home) => {
  const r = spawnSync(process.execPath, [b.main, 'doctor', '--config', configFile], {
    env: envOf(home),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  })
  assert.ok(r.status !== null, `${b.name}: doctor did not end: ${r.error?.message ?? ''}`)
  const clean = text => text.split(home).join('<home>').split(home.replaceAll('\\', '/')).join('<home>')
  // doctor prints its lines on stderr: stdout carries only JSON-RPC.
  const out = r.stderr + r.stdout
  const problems = out
    .split(/\r?\n/)
    .filter(l => /^(warn|fail)\s/.test(l))
    .map(clean)
  assert.ok(/^ok\s+config\s/m.test(out), `${b.name}: doctor does not read the config: ${out.slice(0, 500)}`)
  assert.ok(/^ok\s+servers\s/m.test(out), `${b.name}: doctor does not connect the servers: ${out.slice(0, 800)}`)
  return { code: r.status, problems }
}

const rollbackCase = (writer, reader) => async () => {
  const config = writeConfig({
    sandbox: { timeoutSeconds: 30, callTimeoutSeconds: 20 },
    policy: [
      { match: 'mcp__demo__*', action: 'allow' },
      { match: 'mcp__pid__pid', action: 'allow' },
    ],
    mcpServers: {
      demo: { command: process.execPath, args: [DEMO_SERVER], lazy: true, share: false },
      pid: { command: process.execPath, args: [PID_SERVER], share: true },
    },
  })
  const wrote = {
    TOOLSCRIPT_PROTOCOL: 'auto',
    TOOLSCRIPT_SHARE: '1',
    TOOLSCRIPT_BROKER_IDLE_MS: '1000',
    TOOLSCRIPT_LAZY_IDLE_MS: '1000',
  }
  const home = newHome()
  const first = 'return await call("mcp__demo__list_pull_requests", { state: "open", per_page: 2 })'
  const withHost = async (b, extra, use) => {
    const host = await startHost(b, config, home, extra).open()
    try {
      return await use(host)
    } finally {
      await host.close()
    }
  }
  // The writer leaves its run log, learned files, tool cache and broker key.
  const ref = await withHost(writer, wrote, async host => {
    const found = await host.search()
    assert.ok(/demo: 2 tools/.test(found), `${writer.name}: search_tools: ${found.slice(0, 500)}`)
    const r = await host.run(first)
    assert.ok(!r.isError && r.text.includes('pull_requests'), `${writer.name}: run_code: ${r.text.slice(0, 300)}`)
    const shared = await host.run('return "PID=" + String(await call("mcp__pid__pid", {}))')
    pids.add(Number(/PID=(\d+)/.exec(shared.text)?.[1]))
    // A number to recall: a large result is cut, and its text names the recall.
    const big = await host.run('return await call("mcp__demo__list_pull_requests", { state: "all", per_page: 100 })')
    const n = /recall\((\d+)\)/.exec(big.text)?.[1] ?? /recall\((\d+)\)/.exec(r.text)?.[1]
    assert.ok(n !== undefined, `${writer.name}: no result to recall: ${big.text.slice(-300)}`)
    const again = await host.run(`const r = await recall(${n})\nreturn JSON.stringify(r).length > 0`)
    assert.ok(!again.isError && again.text.includes('true'), `${writer.name}: recall: ${again.text.slice(0, 300)}`)
    return n
  })
  void ref
  await until('the broker of the writer to end', () => brokersAlive(home).length === 0)
  for (const file of [
    'runs.jsonl',
    path.join('learned', 'shapes.json'),
    path.join('learned', 'tools.json'),
    path.join('broker', 'key'),
  ])
    assert.ok(fs.existsSync(path.join(STATE(home), file)), `${writer.name} left no ${file}`)
  const keyBefore = fs.readFileSync(path.join(STATE(home), 'broker', 'key'))
  // The reader on that HOME and config: doctor as on a fresh HOME, then three answers.
  const fresh = doctor(reader, config, newHome())
  const used = doctor(reader, config, home)
  assert.deepEqual(
    used,
    fresh,
    `${reader.name}: doctor on the HOME of ${writer.name} differs from doctor on a fresh HOME`,
  )
  await withHost(
    reader,
    { TOOLSCRIPT_SHARE: '1', TOOLSCRIPT_BROKER_IDLE_MS: '1000', TOOLSCRIPT_LAZY_IDLE_MS: '1000' },
    async host => {
      const names = await host.list()
      assert.deepEqual([...names].sort(), ['run_code', 'search_tools'], `${reader.name}: tools/list: ${names}`)
      const r = await host.run(first)
      assert.ok(!r.isError && r.text.includes('pull_requests'), `${reader.name}: run_code: ${r.text.slice(0, 300)}`)
      const found = await host.search()
      assert.ok(/demo: 2 tools/.test(found), `${reader.name}: search_tools: ${found.slice(0, 500)}`)
    },
  )
  await until('the broker of the reader to end', () => brokersAlive(home).length === 0)
  assert.ok(
    fs.readFileSync(path.join(STATE(home), 'broker', 'key')).equals(keyBefore),
    `${reader.name} changed the broker key of ${writer.name}`,
  )
}

// --- the run -------------------------------------------------------------------------------------------------------------

const cases = [
  ['6a OAuth store, base first, no issuer stamp', oauthCase(BASE, false)],
  ['6b OAuth store, base first, issuer stamp', oauthCase(BASE, true)],
  ['6c OAuth store, head first, no issuer stamp', oauthCase(HEAD, false)],
  ['6d OAuth store, head first, issuer stamp', oauthCase(HEAD, true)],
  ['7 mixed hosts on one HOME', mixedCase],
  ['8a rollback: head writes, base reads', rollbackCase(HEAD, BASE)],
  ['8b upgrade: base writes, head reads', rollbackCase(BASE, HEAD)],
]
let failed = 0
const began = Date.now()
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
console.log(
  `${cases.length - failed} of ${cases.length} cases passed in ${((Date.now() - began) / 1000).toFixed(0)} s (base ${BASE.root}, head ${HEAD.root})`,
)
process.exit(failed === 0 ? 0 : 1)
