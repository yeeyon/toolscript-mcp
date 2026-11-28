// The 2026-07-28 protocol upstream (issue #154, PR 13), on the built host (dist/host/main.js), with the raw client of C0 and no
// SDK. Run `npm run build` first.
//
//   node tests/modern-upstream.e2e.mjs
//
// Rules 5 to 9 of the bar, with `TOOLSCRIPT_PROTOCOL=auto`: a modern opening (`server/discover`) gets a 2026-07-28 session with
// the same two tools, instructions and results as a legacy one; an `ask` never allows; a modern connection has no Workspace; the
// stream of `subscriptions/listen` is acknowledged; a cancel ends a run; a close leaves no sandbox and no exchange folder.
// And with the variable unset or `legacy`, `server/discover` gets the error of 1.0.5. Every process has a temp HOME, USERPROFILE,
// APPDATA and TMP. Every wait ends at a deadline.

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_CODE_CAPABILITIES, createClient, streamTransport, within } from './modern-client.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const FAKE = path.join(ROOT, 'bench', 'fake-server.mjs')
const WIN = process.platform === 'win32'

const children = new Set()
const folders = []
const tempDir = name => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `toolscript-modern-${name}-`)))
  folders.push(dir)
  return dir
}
const killTree = pid => {
  if (WIN) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
}
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const until = async (what, check, ms = 15_000) => {
  const end = Date.now() + ms
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s: ${what}`)
    await new Promise(r => setTimeout(r, 40))
  }
}

const BENCH = { command: process.execPath, args: [FAKE] }
/** The config shapes of the cases. A `claude-code` key is a bridge, by the key. */
const CONFIGS = {
  empty: { mcpServers: {} },
  bench: { mcpServers: { bench: BENCH }, policy: [{ match: 'mcp__bench__*', action: 'allow' }] },
  asking: {
    mcpServers: { bench: BENCH, 'claude-code': BENCH },
    policy: [
      { match: 'mcp__bench__get_deploys', action: 'ask' },
      { match: 'mcp__claude-code__get_deploys', action: 'ask' },
      { match: 'mcp__bench__*', action: 'allow' },
    ],
  },
  denying: {
    mcpServers: { bench: BENCH },
    policy: [
      { match: 'mcp__bench__get_deploys', action: 'deny' },
      { match: 'mcp__bench__*', action: 'allow' },
    ],
  },
}

/** A host of the built server with a raw client. `protocol`: the value of TOOLSCRIPT_PROTOCOL, or undefined for none. */
const start = (config, { protocol, capabilities = CLAUDE_CODE_CAPABILITIES, workspace } = {}) => {
  const home = tempDir('home')
  const tmp = tempDir('tmp')
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  const file = path.join(tempDir('config'), 'config.json')
  const full = workspace === undefined ? config : { ...config, workspace }
  fs.writeFileSync(file, JSON.stringify(full))
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('TOOLSCRIPT_')) delete env[name]
  const child = spawn(process.execPath, [MAIN, '--config', file], {
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      TOOLSCRIPT_SHARE: '0',
      ...(protocol !== undefined && { TOOLSCRIPT_PROTOCOL: protocol }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-20_000)))
  const transport = streamTransport(child.stdout, child.stdin)
  const client = createClient(transport, { capabilities, timeoutMs: 60_000 })
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  const host = {
    client,
    child,
    tmp,
    home,
    exited,
    stderr: () => stderr,
    stdoutLines: () => transport.raw,
    /** The text of a tool call as a modern client sends it. */
    modernCall: async (name, args) => {
      const reply = await client.request('tools/call', { name, arguments: args })
      assert.ok(!reply.error, `${name}: ${JSON.stringify(reply.error)}`)
      return reply.result
    },
    /** The text of a tool call as a legacy client sends it, after `initialize`. */
    legacyCall: async (name, args) => {
      const reply = await client.legacyRequest('tools/call', { name, arguments: args })
      assert.ok(!reply.error, `${name}: ${JSON.stringify(reply.error)}`)
      return reply.result
    },
    close: async () => {
      client.close()
      await within(exited, 20_000, 'the host exit').catch(() => killTree(child.pid))
      await exited
    },
  }
  return host
}
const textOf = result => result.content.map(b => b.text ?? '').join('')
const RUN = code => ({ name: 'run_code', arguments: { code } })
const SEARCH = query => ({ name: 'search_tools', arguments: { query } })

/** Every stdout line is a JSON-RPC message. */
const onlyJsonRpc = host => {
  for (const line of host.stdoutLines())
    assert.equal(JSON.parse(line).jsonrpc, '2.0', `not JSON-RPC: ${line.slice(0, 80)}`)
}

const cases = []
const test = (name, fn) => cases.push([name, fn])

// --- rule 5: a modern session has the surface of a legacy one -----------------------------------------------------------------

const PROGRAMS = [
  ['a value', 'return 6 * 7'],
  ['a nested call', 'const r = await call("mcp__bench__get_deploys", { date: "2026-10-09" }); return r.count'],
  ['an error', 'throw new Error("boom")'],
  ['a refused call', 'return await call("mcp__bench__get_deploys", { date: "2026-10-09" })', 'denying'],
  ['saveFile', 'await saveFile("a.txt", "hello"); return await readFile("a.txt")'],
  [
    'recall',
    'return await recall(1)',
    'bench',
    'const r = await call("mcp__bench__list_issues", { project: "A" }); return r.length',
  ],
]

test('rule 5: discover, tools/list and a table of programs equal the legacy ones', async () => {
  const modern = start(CONFIGS.bench, { protocol: 'auto' })
  const legacy = start(CONFIGS.bench, { protocol: 'auto' })
  try {
    const found = await modern.client.discover()
    assert.ok(!found.error, JSON.stringify(found))
    assert.deepEqual(found.result.supportedVersions, ['2026-07-28'])
    assert.deepEqual(Object.keys(found.result.capabilities), ['tools'], 'no resources and no extensions')
    const init = await legacy.client.legacyOpen()
    assert.ok(!init.error, JSON.stringify(init))
    assert.equal(found.result.instructions, init.result.instructions, 'the same instructions')
    const [mList, lList] = [
      await modern.client.request('tools/list', {}),
      await legacy.client.legacyRequest('tools/list'),
    ]
    assert.equal(
      sha(JSON.stringify(mList.result.tools)),
      sha(JSON.stringify(lList.result.tools)),
      'the same tools array',
    )
    assert.deepEqual(
      mList.result.tools.map(t => t.name),
      ['run_code', 'search_tools'],
    )
    for (const query of ['', 'deploys']) {
      const [m, l] = [
        await modern.modernCall(...Object.values(SEARCH(query))),
        await legacy.legacyCall(...Object.values(SEARCH(query))),
      ]
      assert.equal(textOf(m), textOf(l), `search_tools ${JSON.stringify(query)}`)
    }
    for (const [label, code, config, before] of PROGRAMS) {
      void config
      if (before !== undefined) {
        // `recall`: a first run keeps a result, a second recalls it, through the same connection.
        await modern.modernCall(...Object.values(RUN(before)))
        await legacy.legacyCall(...Object.values(RUN(before)))
      }
      const [m, l] = [
        await modern.modernCall(...Object.values(RUN(code))),
        await legacy.legacyCall(...Object.values(RUN(code))),
      ]
      assert.equal(
        textOf(m).replace(/\d+\.\d+ s/g, '<s>'),
        textOf(l).replace(/\d+\.\d+ s/g, '<s>'),
        `run_code: ${label}`,
      )
      assert.equal(m.isError, l.isError, `run_code isError: ${label}`)
    }
    onlyJsonRpc(modern)
    onlyJsonRpc(legacy)
  } finally {
    await Promise.all([modern.close(), legacy.close()])
  }
})

test('rule 5: a refused call gives the same text on a modern and a legacy connection', async () => {
  const modern = start(CONFIGS.denying, { protocol: 'auto' })
  const legacy = start(CONFIGS.denying, { protocol: 'auto' })
  try {
    await modern.client.discover()
    await legacy.client.legacyOpen()
    const code = 'return await call("mcp__bench__get_deploys", { date: "2026-10-09" })'
    const [m, l] = [await modern.modernCall('run_code', { code }), await legacy.legacyCall('run_code', { code })]
    assert.equal(m.isError, true)
    assert.equal(textOf(m), textOf(l))
    assert.match(textOf(m), /denied|deny/i)
  } finally {
    await Promise.all([modern.close(), legacy.close()])
  }
})

// --- rule 6: approval until the next change --------------------------------------------------------------------------------

test('rule 6: an ask never allows on a modern connection, for a server tool and for a bridge tool', async () => {
  const modern = start(CONFIGS.asking, {
    protocol: 'auto',
    capabilities: { ...CLAUDE_CODE_CAPABILITIES, elicitation: { form: {} } },
  })
  const legacy = start(CONFIGS.asking, { protocol: 'auto', capabilities: {} })
  try {
    await modern.client.discover()
    await legacy.client.legacyOpen()
    for (const key of ['bench', 'claude-code']) {
      const code = `return await call("mcp__${key}__get_deploys", { date: "2026-10-09" })`
      const [m, l] = [await modern.modernCall('run_code', { code }), await legacy.legacyCall('run_code', { code })]
      assert.equal(m.isError, true, `${key}: refused`)
      assert.ok(!/"count"/.test(textOf(m)), `${key}: the call did not run`)
      // The legacy client has no elicitation capability, so it gets the refusal for a client that cannot ask.
      assert.equal(textOf(m), textOf(l), `${key}: the text of a client that cannot ask`)
      assert.match(textOf(m), /cannot ask/)
    }
    assert.ok(!/approval prompt failed/.test(modern.stderr()), 'no prompt failure is logged')
    assert.ok(!modern.client.messages.some(m => m.method === 'elicitation/create'), 'no elicitation request is sent')
  } finally {
    await Promise.all([modern.close(), legacy.close()])
  }
})

// --- rule 7: roots until the next change -----------------------------------------------------------------------------------

const WORKSPACE = project => ({ roots: [{ path: project }] })

test('rule 7: a modern connection has no Workspace, and a legacy opening on auto still asks the roots', async () => {
  const project = tempDir('project')
  fs.writeFileSync(path.join(project, 'readme.txt'), 'hello')
  const modern = start(CONFIGS.bench, { protocol: 'auto', workspace: WORKSPACE(project) })
  const legacy = start(CONFIGS.bench, { protocol: 'auto', workspace: WORKSPACE(project), capabilities: { roots: {} } })
  try {
    const found = await modern.client.discover()
    const search = await modern.modernCall('search_tools', { query: '' })
    assert.ok(
      !/workspace/i.test(textOf(search).replace(/Workspace is not available[^\n]*/g, '')),
      `no Workspace in search_tools: ${textOf(search)}`,
    )
    assert.match(
      found.result.instructions,
      /built-in workspace server is not available/,
      'the existing sentence for a Workspace that is not available',
    )
    const refused = await modern.modernCall('run_code', { code: 'return await call("mcp__workspace__list", {})' })
    const unknown = await modern.modernCall('run_code', { code: 'return await call("mcp__nosuch__list", {})' })
    assert.equal(refused.isError, true)
    assert.equal(textOf(refused).replace(/workspace/g, 'nosuch'), textOf(unknown), 'refused as an unknown server is')
    assert.ok(!textOf(refused).includes(project) && !textOf(refused).includes('readme.txt'), 'never the bound root')
    // A legacy opening under the same wiring asks the roots, as before, and has the Workspace.
    const asked = []
    legacy.client.transport.onMessage = (inner => message => {
      if (message.method === 'roots/list') {
        asked.push(message)
        legacy.client.transport.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { roots: [{ uri: new URL(`file:///${project.replaceAll('\\', '/')}`).href }] },
        })
      }
      inner(message)
    })(legacy.client.transport.onMessage)
    const opened = await legacy.client.legacyRequest('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: {} },
      clientInfo: { name: 'raw-client', version: '0.0.1' },
    })
    assert.ok(!opened.error, JSON.stringify(opened))
    legacy.client.notify('notifications/initialized')
    await until('roots/list from the legacy session', () => asked.length > 0)
    assert.equal(asked.length, 1)
    const list = await legacy.legacyCall('run_code', {
      code: 'return await call("mcp__workspace__list", { path: "." })',
    })
    assert.match(textOf(list), /readme\.txt/)
  } finally {
    await Promise.all([modern.close(), legacy.close()])
  }
})

// --- rule 8: the stream, the other methods, cancel and close ------------------------------------------------------------------

test('rule 8: listen is acknowledged and quiet, other methods get the legacy error, a second discover answers as the first', async () => {
  const modern = start(CONFIGS.bench, { protocol: 'auto' })
  const legacy = start(CONFIGS.bench, { protocol: 'auto' })
  try {
    const first = await modern.client.discover()
    const stream = await modern.client.listen()
    assert.ok(stream.ack, 'the stream is acknowledged')
    const second = await modern.client.discover()
    assert.deepEqual(second.result, first.result, 'a second discover answers as the first')
    await modern.modernCall('run_code', { code: 'return 1' })
    assert.equal(stream.notifications().length, 0, 'the tool list never changes, so no notice follows')
    await legacy.client.legacyOpen()
    for (const method of ['resources/list', 'prompts/list', 'no/such-method']) {
      const [m, l] = [await modern.client.request(method, {}), await legacy.client.legacyRequest(method)]
      assert.deepEqual(m.error, l.error, `${method}: the error of the same request on legacy`)
    }
  } finally {
    await Promise.all([modern.close(), legacy.close()])
  }
})

test('rule 8: a cancel ends a running run_code, and a close mid-run leaves no sandbox and no exchange folder', async () => {
  const host = start(CONFIGS.empty, { protocol: 'auto' })
  try {
    await host.client.discover()
    const run = host.client.start('tools/call', {
      name: 'run_code',
      arguments: { code: 'await sleep(30000); return 1' },
    })
    await until('the sandbox of the run', () => fs.readdirSync(host.tmp).length > 0)
    host.client.cancel(run.id)
    const ping = await host.client.request('tools/list', {})
    assert.ok(ping.result, 'the connection works after the cancel')
    await until('the exchange folder of the cancelled run is gone', () => fs.readdirSync(host.tmp).length === 0)
    // A second run, and the client closes in the middle of it.
    host.client.start('tools/call', { name: 'run_code', arguments: { code: 'await sleep(30000); return 1' } })
    await until('the sandbox of the second run', () => fs.readdirSync(host.tmp).length > 0)
    host.client.close()
    assert.equal(await within(host.exited, 20_000, 'the host exit after a close in a run'), 0)
    assert.deepEqual(fs.readdirSync(host.tmp), [], 'no exchange folder is left')
    onlyJsonRpc(host)
  } finally {
    await host.close()
  }
})

test('a second connection is a second process, and both answer', async () => {
  const a = start(CONFIGS.bench, { protocol: 'auto' })
  const b = start(CONFIGS.bench, { protocol: 'auto' })
  try {
    await Promise.all([a.client.discover(), b.client.discover()])
    const [ra, rb] = await Promise.all([
      a.modernCall('run_code', { code: 'return 1' }),
      b.modernCall('run_code', { code: 'return 2' }),
    ])
    assert.match(textOf(ra), /^1/)
    assert.match(textOf(rb), /^2/)
    assert.notEqual(a.child.pid, b.child.pid)
  } finally {
    await Promise.all([a.close(), b.close()])
  }
})

// --- rule 9 and the legacy value --------------------------------------------------------------------------------------------

test('with the variable unset or legacy, server/discover gets the error of 1.0.5', async () => {
  const rows = []
  for (const protocol of [undefined, 'legacy']) {
    const host = start(CONFIGS.bench, { protocol })
    try {
      const probe = await host.client.discover()
      rows.push(probe.error)
      assert.equal(probe.error?.code, -32601, `protocol ${protocol}: ${JSON.stringify(probe)}`)
      const init = await host.client.legacyOpen()
      assert.ok(!init.error, JSON.stringify(init))
      onlyJsonRpc(host)
    } finally {
      await host.close()
    }
  }
  assert.deepEqual(rows[0], rows[1])
})

test('rule 9: the [mcp-sdk] lines of a modern session carry no argument text', async () => {
  const host = start(CONFIGS.bench, { protocol: 'auto' })
  try {
    await host.client.discover()
    await host.client.request('resources/list', {})
    // An opening of the old era on a connection that is already modern is refused.
    const refused = await host.client.legacyRequest('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'SECRET-CLIENT-NAME', version: '0' },
    })
    assert.equal(refused.error?.code, -32022, JSON.stringify(refused))
    await host.modernCall('run_code', { code: 'return "SECRET-PROGRAM-TEXT"' })
    const lines = host
      .stderr()
      .split('\n')
      .filter(l => l.includes('[mcp-sdk]'))
    for (const line of lines) assert.ok(!/SECRET/.test(line), `argument text in a log line: ${line}`)
    assert.ok(
      !/SECRET/.test(
        host
          .stderr()
          .split('\n')
          .filter(l => !/run_code:/.test(l))
          .join('\n'),
      ),
      'no argument text in the log',
    )
    onlyJsonRpc(host)
    console.log('[mcp-sdk] lines of this session:', JSON.stringify(lines))
  } finally {
    await host.close()
  }
})

let failed = 0
for (const [name, fn] of cases) {
  const t = Date.now()
  try {
    await fn()
    console.log(`pass  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  } catch (err) {
    failed++
    console.log(
      `FAIL  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s): ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    for (const child of children) if (child.pid !== undefined && child.exitCode === null) killTree(child.pid)
    children.clear()
    for (const dir of folders.splice(0))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
process.exit(failed === 0 ? 0 : 1)
