// End-to-end test of the built server (dist/host/main.js), on Linux, macOS and
// Windows. An SDK Client starts toolscript-mcp over stdio with a temp config
// and reads every line of its stdout. Run `npm run build` first.
// TOOLSCRIPT_E2E_MAIN points the test at another main.js, for example the one
// of a package installed from `npm pack` (scripts/pack-check.mjs).
//
//   node tests/server.e2e.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const BENCH_TOOLS = ['create_ticket', 'get_deploys', 'list_issues', 'query_logs', 'search_messages']
const MARKER = `fake-${randomUUID()}`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-e2e-'))
const PROBE = path.join(ROOT, 'tests', 'probe-server.mjs')
const probeFile = path.join(dir, 'probe.json')
const passedFile = path.join(dir, 'passed.json')
const crashFile = path.join(dir, 'crash.json')
const hangFile = path.join(dir, 'hang.pid')
const configFile = path.join(dir, 'config.json')
// Every call that reaches the fake server, one JSON line each.
const BENCH_LOG = path.join(dir, 'bench.jsonl')
// The server's temp dir: each run makes its exchange dir here, and must remove it.
const TMP = path.join(dir, 'tmp')
fs.mkdirSync(TMP)
const SERVER_ENV = { ...process.env, TOOLSCRIPT_E2E_MARKER: MARKER, TMPDIR: TMP, TEMP: TMP, TMP }
fs.writeFileSync(
  configFile,
  JSON.stringify({
    sandbox: { timeoutSeconds: 5 },
    // query_logs matches no rule, so it is ask.
    policy: [
      { match: 'mcp__bench__create_ticket', action: 'deny' },
      { match: 'mcp__bench__search_messages', action: 'allow' },
      { match: 'mcp__bench__list_issues', action: 'allow' },
      { match: 'mcp__bench__get_deploys', action: 'ask' },
    ],
    mcpServers: {
      // `node` from PATH, not process.execPath: the SDK's short environment must still find it.
      bench: { command: 'node', args: [path.join(ROOT, 'bench', 'fake-server.mjs')], env: { BENCH_LOG } },
      missing: { command: 'toolscript-e2e-no-such-command' },
      probe: { command: process.execPath, args: [PROBE, probeFile] },
      passed: {
        command: process.execPath,
        args: [PROBE, passedFile],
        env: { TOOLSCRIPT_E2E_MARKER: '${TOOLSCRIPT_E2E_MARKER}' },
      },
      nested: { command: process.execPath, args: [MAIN, '--config', configFile] },
      crash: { command: process.execPath, args: [PROBE, crashFile, '--exit-after-list'] },
      // Never answers, and ignores the end of its stdin.
      hang: {
        command: process.execPath,
        args: [
          '-e',
          'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)',
          hangFile,
        ],
      },
      // A variable that is not set: this entry fails alone, and the server still starts.
      broken: { command: process.execPath, env: { TOKEN: '${TOOLSCRIPT_E2E_UNSET}' } },
    },
  }),
)
const CONFIG_TEXT = fs.readFileSync(configFile, 'utf8')

// A client transport over the child's stdio that keeps every stdout line, so
// the test sees what is not JSON-RPC too.
class RecordingTransport {
  lines = []
  stderr = ''
  start() {
    this.child = spawn(process.execPath, [MAIN, '--config', configFile], {
      env: SERVER_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // A server that dies fails the pending requests instead of leaving them
    // open. 'close' comes after the last stdout line is read.
    this.exited = new Promise(resolve =>
      this.child.on('close', code => {
        resolve(code)
        this.onclose?.()
      }),
    )
    this.child.stderr.on('data', d => (this.stderr += d))
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      this.lines.push(line)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      this.onmessage?.(msg)
    })
    return Promise.resolve()
  }
  send(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
    return Promise.resolve()
  }
  async close() {
    this.child.stdin.end()
    this.onclose?.()
  }
}

// This client has no elicitation capability, so the server cannot ask it.
const transport = new RecordingTransport()
const client = new Client({ name: 'e2e', version: '0' })
const search = async (query, limit) => {
  const r = await client.callTool({ name: 'search_tools', arguments: limit ? { query, limit } : { query } })
  assert.equal(r.isError, false)
  return r.content[0].text
}

// A second server for a client that can ask the person: it answers each prompt with `answer`.
const asking = { answer: 'accept', prompts: [] }
const askingClient = new Client({ name: 'e2e-ask', version: '0' }, { capabilities: { elicitation: {} } })
askingClient.setRequestHandler(ElicitRequestSchema, req => {
  asking.prompts.push(req.params.message)
  return { action: asking.answer }
})
const askingTransport = new StdioClientTransport({
  command: process.execPath,
  args: [MAIN, '--config', configFile],
  env: SERVER_ENV,
  stderr: 'ignore',
})

const run = async (code, c = client) => {
  const r = await c.callTool({ name: 'run_code', arguments: { code } })
  return { text: r.content[0].text, isError: r.isError }
}
const benchCalls = tool =>
  (fs.existsSync(BENCH_LOG) ? fs.readFileSync(BENCH_LOG, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(c => c.tool === tool).length
const leftDirs = () => fs.readdirSync(TMP).filter(f => f.startsWith('toolscript-'))

before(async () => {
  assert.ok(fs.existsSync(MAIN), 'dist/host/main.js is missing: run npm run build first')
  await client.connect(transport)
  await askingClient.connect(askingTransport)
})

// After a failed test the server can still run: end it, so the run does not hang.
after(async () => {
  await client.close().catch(() => {})
  await askingClient.close().catch(() => {})
  if (transport.child.exitCode === null) transport.child.kill()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const gone = async pid => {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if (err.code === 'ESRCH') return true
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

test('(a) tools/list shows run_code and search_tools, and no downstream tool', async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map(t => t.name),
    ['run_code', 'search_tools'],
  )
  assert.match(client.getInstructions() ?? '', /search_tools.*run_code/)
  assert.match(client.getInstructions() ?? '', /\bbench, missing, probe, passed, nested, crash, hang\b/)
  for (const tool of tools) assert.equal(tool._meta?.['anthropic/alwaysLoad'], true, tool.name)
})

test('(b) an empty query lists the 5 fake tools as mcp__bench__<name>', async () => {
  const text = await search('', 100)
  const names = [...text.matchAll(/^### (mcp__bench__\S+)$/gm)].map(m => m[1]).sort()
  assert.deepEqual(
    names,
    BENCH_TOOLS.map(t => `mcp__bench__${t}`),
    text,
  )
  assert.match(text, /args: \{ project: string \}/, text)
})

test('(c) "issue" ranks list_issues first', async () => {
  const text = await search('issue')
  assert.match(text, /^\d+ of \d+ MCP tools\.\n\n### mcp__bench__list_issues\n/, text)
})

test('(d) a server whose command does not exist shows as failed, and bench still works', async () => {
  const text = await search('deploys')
  assert.match(text, /### mcp__bench__get_deploys/, text)
  // Linux and macOS: spawn ... ENOENT. Windows: cmd.exe says the command is not recognized.
  assert.match(text, /## Not connected\n(- .+\n)*- missing: .*(ENOENT|toolscript-e2e-no-such-command)/, text)
})

test('(d) a server that hangs does not block the search, and one that dies later shows as failed', async () => {
  const text = await search('')
  assert.match(text, /- hang: still connecting\./, text)
  assert.match(text, /- crash: the connection closed/, text)
  assert.doesNotMatch(text, /mcp__crash__/, text)
})

test('(d) a config entry with an error fails alone, and search_tools shows the error', async () => {
  const text = await search('')
  assert.match(
    text,
    /- broken: invalid entry in the toolscript-mcp config: mcpServers\.broken\.env\.TOKEN: the environment variable TOOLSCRIPT_E2E_UNSET is not set/,
    text,
  )
  assert.match(text, /### mcp__bench__/, text)
})

test('(e) a nested toolscript-mcp refuses to start', async () => {
  const text = await search('')
  assert.match(text, /- nested: .*refused to start, because TOOLSCRIPT_MCP_DEPTH is set/, text)
  const direct = spawnSync(process.execPath, [MAIN, '--config', configFile], {
    env: { ...process.env, TOOLSCRIPT_MCP_DEPTH: '1' },
    input: '',
    encoding: 'utf8',
  })
  assert.equal(direct.status, 1)
  assert.equal(direct.stdout, '')
  assert.match(direct.stderr, /refused to start, because TOOLSCRIPT_MCP_DEPTH is set/)
})

test('(g) a stdio child gets a host variable only when the config passes it', () => {
  const probe = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
  const passed = JSON.parse(fs.readFileSync(passedFile, 'utf8'))
  assert.equal(probe.env.TOOLSCRIPT_E2E_MARKER, undefined)
  assert.equal(passed.env.TOOLSCRIPT_E2E_MARKER, MARKER)
  assert.equal(probe.env.TOOLSCRIPT_MCP_DEPTH, '1')
})

test('run (a) a paging program follows next_cursor, and only the count comes back', async () => {
  const before = benchCalls('search_messages')
  const r = await run(
    [
      'let cursor',
      'let count = 0',
      'do {',
      '  const page = await call("mcp__bench__search_messages", { channel: "#release", cursor })',
      '  count += page.messages.length',
      '  cursor = page.response_metadata.next_cursor',
      '} while (cursor)',
      'return count',
    ].join('\n'),
  )
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /^250\n\n--- 3 MCP calls: \d+k characters in, 3 out ---\n/, r.text)
  // The footer shows the shape of each page, never a message.
  assert.doesNotMatch(r.text, /rollback|deploy of|release train|U0001|C0BENCH01/i, r.text)
  assert.equal(benchCalls('search_messages') - before, 3)
  assert.deepEqual(leftDirs(), [], 'the exchange dir is removed')
})

test('run (b) a deny rule on create_ticket refuses the program, and the fake server sees no call', async () => {
  const before = benchCalls('list_issues')
  const r = await run(
    'await call("mcp__bench__list_issues", { project: "OPS" })\nreturn await call("mcp__bench__create_ticket", { title: "x" })',
  )
  assert.equal(r.isError, true)
  assert.ok(r.text.startsWith('Error: the program did not run'), r.text)
  assert.ok(
    r.text.includes(
      '- line 2: mcp__bench__create_ticket is denied by policy[0] {"match": "mcp__bench__create_ticket", "action": "deny"}',
    ),
    r.text,
  )
  assert.equal(benchCalls('create_ticket'), 0)
  assert.equal(benchCalls('list_issues'), before, 'the program did not start')
})

test('run (c) ask with a client that can ask: accept runs the program, decline refuses it', async () => {
  const code = 'return (await call("mcp__bench__get_deploys", { date: "2026-10-09" })).count'
  asking.answer = 'accept'
  const accepted = await run(code, askingClient)
  assert.equal(accepted.isError, false, accepted.text)
  assert.ok(accepted.text.startsWith('400\n'), accepted.text)
  assert.equal(asking.prompts.length, 1)
  assert.ok(asking.prompts[0].includes('- mcp__bench__get_deploys\n'), asking.prompts[0])
  assert.ok(asking.prompts[0].includes(code), 'the prompt shows the program')
  assert.equal(benchCalls('get_deploys'), 1)

  asking.answer = 'decline'
  const declined = await run(code, askingClient)
  assert.equal(declined.isError, true)
  assert.ok(declined.text.includes('the person did not approve'), declined.text)
  assert.ok(declined.text.includes('{"match": "mcp__bench__get_deploys", "action": "allow"}'), declined.text)
  assert.equal(asking.prompts.length, 2)
  assert.equal(benchCalls('get_deploys'), 1, 'no call after a decline')
})

test('run (d) ask with a client that cannot ask is refused with the rule to add', async () => {
  const r = await run('return await call("mcp__bench__get_deploys", { date: "2026-10-09" })')
  assert.equal(r.isError, true)
  assert.ok(r.text.includes('this MCP client cannot ask the person'), r.text)
  assert.ok(
    r.text.includes('ask them to add {"match": "mcp__bench__get_deploys", "action": "allow"} to "policy"'),
    r.text,
  )
  assert.equal(benchCalls('get_deploys'), 1)
})

test('run (e) a tool name built at run time is refused at call time, and the program catches it', async () => {
  const prompts = asking.prompts.length
  const r = await run(
    'const tool = "query" + "_logs"\ntry {\n  await call("mcp__bench__" + tool, { from: "now-24h" })\n  return "called"\n} catch (e) {\n  return "caught: " + e.message\n}',
    askingClient,
  )
  assert.equal(r.isError, false, r.text)
  assert.ok(r.text.startsWith('"caught: not approved: no policy rule allows mcp__bench__query_logs'), r.text)
  assert.ok(r.text.includes('{"match": "mcp__bench__query_logs", "action": "allow"}'), r.text)
  assert.equal(asking.prompts.length, prompts, 'a name built at run time is never asked')
  assert.equal(benchCalls('query_logs'), 0)
})

test('run (f) a busy loop ends at the limit, and the server stays usable', async () => {
  const started = performance.now()
  const r = await run('while (true) {}')
  assert.equal(r.isError, true)
  assert.ok(r.text.startsWith('Error: the program ran past the time limit of 5 s and was stopped'), r.text)
  assert.ok(performance.now() - started < 15_000)
  assert.ok((await run('return 1 + 1')).text.startsWith('2\n'))
  assert.deepEqual(leftDirs(), [])
})

test('run (g) a wrong tool name is caught before the run, with no sandbox start', async () => {
  const before = benchCalls('list_issues')
  const r = await run(
    'await call("mcp__bench__list_issues", { project: "OPS" })\nreturn await call("mcp__bench__lsit_issues", { project: "OPS" })',
  )
  assert.equal(r.isError, true)
  assert.ok(
    r.text.includes(
      '- line 2: no tool "mcp__bench__lsit_issues" on the connected server "bench" (did you mean "mcp__bench__list_issues"?)',
    ),
    r.text,
  )
  assert.equal(benchCalls('list_issues'), before, 'the first call of the program did not run')
})

test('run (h) a program cannot read an environment variable of the host', async () => {
  const r = await run(
    [
      'const found = []',
      'const probes = [',
      '  () => typeof process === "undefined" ? "no process" : JSON.stringify(process.env),',
      '  () => globalThis.constructor.constructor("return process")().env,',
      '  () => call.constructor("return process")().env,',
      '  () => (async () => {}).constructor("return process")().env,',
      ']',
      'for (const probe of probes) {',
      '  try { found.push(JSON.stringify(probe()) ?? "undefined") } catch (e) { found.push("blocked: " + e.message) }',
      '}',
      'return found',
    ].join('\n'),
  )
  assert.ok(r.text.includes('no process'), r.text)
  assert.ok(!r.text.includes(MARKER), r.text)
  assert.ok(!r.text.includes('TOOLSCRIPT_E2E_MARKER'), r.text)
})

test('run (j) a large result is cut, and recall returns it whole with no new call', async () => {
  const before = benchCalls('list_issues')
  const cut = await run('return (await call("mcp__bench__list_issues", { project: "OPS" })).issues')
  const ref = /more characters cut; await recall\((\d+)\) returns the whole result/.exec(cut.text)?.[1]
  assert.ok(ref, cut.text.slice(-600))
  const again = await run(`const issues = await recall(${ref})\nreturn [issues.length, issues[179].key]`)
  assert.ok(again.text.startsWith('[\n  180,\n  "OPS-180"\n]'), again.text)
  assert.ok(again.text.includes(`--- 0 MCP calls, 1 recall: `), again.text)
  assert.equal(benchCalls('list_issues'), before + 1)
})

test('run (k) a policy edit applies at the next run, and a broken config keeps the last good policy', async () => {
  const code = 'return (await call("mcp__bench__create_ticket", { title: "x" })).created.key'
  const edited = JSON.parse(CONFIG_TEXT)
  edited.policy[0].action = 'allow'
  try {
    fs.writeFileSync(configFile, JSON.stringify(edited))
    const allowed = await run(code)
    assert.equal(allowed.isError, false, allowed.text)
    assert.equal(benchCalls('create_ticket'), 1)

    fs.writeFileSync(configFile, '{"policy": [')
    const kept = await run(code)
    assert.equal(kept.isError, false, kept.text)
    assert.ok(kept.text.includes('## Policy not reloaded'), kept.text)
    assert.ok(kept.text.includes('- the config is not valid JSON'), kept.text)
    assert.equal(benchCalls('create_ticket'), 2)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
  }
  const denied = await run(code)
  assert.equal(denied.isError, true)
  assert.ok(denied.text.includes('is denied by policy[0]'), denied.text)
  assert.equal(benchCalls('create_ticket'), 2)
})

test('(i) init imports the servers of a client into a config that the server starts with', async () => {
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  const secret = `fake-secret-${randomUUID()}`
  const cursor = {
    mcpServers: {
      bench: { command: 'node', args: [path.join(ROOT, 'bench', 'fake-server.mjs')], env: { BENCH_LOG, S: secret } },
    },
  }
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(cursor))
  // Every client file and the config are in the temp home: no file of this machine is read.
  const env = { ...SERVER_ENV, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') }
  env.XDG_CONFIG_HOME = path.join(home, '.config')
  for (const name of ['CLAUDE_CONFIG_DIR', 'TOOLSCRIPT_CONFIG']) delete env[name]
  const written =
    process.platform === 'win32'
      ? path.join(env.APPDATA, 'toolscript-mcp', 'config.json')
      : path.join(env.XDG_CONFIG_HOME, 'toolscript-mcp', 'config.json')

  const init = spawnSync(process.execPath, [MAIN, 'init'], { env, input: '', encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  assert.equal(init.stdout, '', 'init writes nothing to stdout')
  assert.ok(!init.stderr.includes(secret), init.stderr)
  assert.ok(init.stderr.includes('Remove from "mcpServers": "bench"'), init.stderr)
  assert.ok(fs.existsSync(written), init.stderr)
  if (process.platform !== 'win32') assert.equal(fs.statSync(written).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), JSON.stringify(cursor))

  const imported = new Client({ name: 'e2e-init', version: '0' })
  await imported.connect(
    new StdioClientTransport({ command: process.execPath, args: [MAIN, '--config', written], env, stderr: 'ignore' }),
  )
  try {
    const r = await imported.callTool({ name: 'search_tools', arguments: { query: 'issue' } })
    assert.match(r.content[0].text, /### mcp__bench__list_issues/, r.content[0].text)
  } finally {
    await imported.close()
  }
})

test('(f) stdout holds only JSON-RPC, and (h) the server and its children end when stdin closes', async () => {
  // A run in flight at shutdown gets its sandbox killed and its exchange dir removed.
  const inFlight = run('while (true) {}').catch(err => err)
  for (let i = 0; i < 50 && leftDirs().length === 0; i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(leftDirs().length, 1, 'the run in flight has its exchange dir')
  await client.close()
  await askingClient.close()
  await inFlight
  const code = await Promise.race([transport.exited, new Promise(r => setTimeout(() => r('timeout'), 15_000).unref())])
  assert.equal(code, 0, transport.stderr)

  assert.ok(transport.lines.length > 0)
  for (const line of transport.lines) {
    let msg
    assert.doesNotThrow(() => (msg = JSON.parse(line)), `not JSON on stdout: ${line}`)
    assert.equal(msg.jsonrpc, '2.0', `not JSON-RPC on stdout: ${line}`)
  }

  const { pid } = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
  assert.ok(await gone(pid), `the probe child ${pid} still runs`)
  const hang = Number(fs.readFileSync(hangFile, 'utf8'))
  assert.ok(await gone(hang), `the hang child ${hang} still runs`)
  assert.deepEqual(leftDirs(), [], 'the exchange dir of the run in flight is removed')
})
