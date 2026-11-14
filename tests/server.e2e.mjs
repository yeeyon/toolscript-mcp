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
const flakyFile = path.join(dir, 'flaky.json')
const slowFile = path.join(dir, 'slow.json')
const hangFile = path.join(dir, 'hang.pid')
const configFile = path.join(dir, 'config.json')
// Every call that reaches the fake server, one JSON line each.
const BENCH_LOG = path.join(dir, 'bench.jsonl')
// The server's temp dir: each run makes its exchange dir here, and must remove it.
const TMP = path.join(dir, 'tmp')
fs.mkdirSync(TMP)
// The server's HOME: the run log and saveFile never touch the real one.
const HOME = path.join(dir, 'home')
fs.mkdirSync(HOME)
const SERVER_ENV = {
  ...process.env,
  TOOLSCRIPT_E2E_MARKER: MARKER,
  TMPDIR: TMP,
  TEMP: TMP,
  TMP,
  HOME,
  USERPROFILE: HOME,
}
fs.writeFileSync(
  configFile,
  JSON.stringify({
    sandbox: { timeoutSeconds: 5, callTimeoutSeconds: 2 },
    // query_logs matches no rule, so it is ask.
    policy: [
      { match: 'mcp__bench__create_ticket', action: 'deny' },
      { match: 'mcp__bench__search_messages', action: 'allow' },
      { match: 'mcp__bench__list_issues', action: 'allow' },
      { match: 'mcp__bench__get_deploys', action: 'ask' },
      { match: 'mcp__flaky__probe', action: 'allow' },
      { match: 'mcp__slow__probe', action: 'allow' },
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
      flaky: { command: process.execPath, args: [PROBE, flakyFile, '--exit-after-call'] },
      slow: { command: process.execPath, args: [PROBE, slowFile, '--hang-calls'] },
      // Never answers, and ignores the end of its stdin.
      hang: {
        command: process.execPath,
        args: [
          '-e',
          'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)',
          hangFile,
        ],
      },
    },
  }),
)

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
// The starts and cancelled requests that a probe child of `client`'s server
// wrote. The server of askingClient starts its own children.
const probeEvents = (file, event) =>
  (fs.existsSync(`${file}.log`) ? fs.readFileSync(`${file}.log`, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(e => e.event === event && e.ppid === transport.child.pid)

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
  assert.match(client.getInstructions() ?? '', /\bbench, missing, probe, passed, nested, crash, flaky, slow, hang\b/)
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

test('(d) a server that hangs does not block the search', async () => {
  const text = await search('')
  assert.match(text, /- hang: still connecting\./, text)
})

test('(i) a search connects again a server that closed, at most 3 times in 60 s', async () => {
  let text = ''
  for (let i = 0; i < 40 && !/- crash: .*tries again/.test(text); i++) {
    text = await search('')
    await new Promise(r => setTimeout(r, 300))
  }
  assert.match(text, /- crash: the connection closed.*\. toolscript-mcp tries again on next use after \d+ s/, text)
  assert.doesNotMatch(text, /mcp__crash__/, text)
  assert.equal(probeEvents(crashFile, 'start').length, 3, 'the start and 2 reconnects')
  await search('')
  assert.equal(probeEvents(crashFile, 'start').length, 3, 'no attempt over the cap')
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

test('run (k) a server that exited after a call connects again on the next call', async () => {
  const code = 'return await call("mcp__flaky__probe", {})'
  const first = await run(code)
  assert.equal(first.isError, false, first.text)
  const pid = Number(/^"?(\d+)/.exec(first.text)?.[1])
  assert.ok(await gone(pid), `the flaky child ${pid} exited`)
  const second = await run(code)
  assert.equal(second.isError, false, second.text)
  assert.notEqual(Number(/^"?(\d+)/.exec(second.text)?.[1]), pid, 'a new child answered')
  assert.equal(probeEvents(flakyFile, 'start').length, 2)
})

test('run (l) a call with no answer in callTimeoutSeconds throws, the program goes on, and the server gets a cancel', async () => {
  const r = await run(
    'const t = Date.now()\ntry { await call("mcp__slow__probe", {}) } catch (e) { return [e.message, Date.now() - t] }',
  )
  assert.equal(r.isError, false, r.text)
  assert.ok(r.text.includes('"mcp__slow__probe did not answer within the call limit of 2 s and was cancelled"'), r.text)
  const ms = Number(/,\s*(\d+)\s*\]/.exec(r.text)?.[1])
  assert.ok(ms >= 1900 && ms < 4500, `the call waited ${ms} ms`)
  for (let i = 0; i < 20 && probeEvents(slowFile, 'cancelled').length === 0; i++)
    await new Promise(res => setTimeout(res, 100))
  assert.equal(probeEvents(slowFile, 'cancelled').length, 1, 'the server got notifications/cancelled')
  const logged = fs
    .readFileSync(path.join(HOME, '.toolscript-mcp', 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
  const last = JSON.parse(logged.at(-1))
  assert.deepEqual(
    last.calls.map(({ tool, ok, error }) => ({ tool, ok, error })),
    [{ tool: 'mcp__slow__probe', ok: false, error: 'timeout' }],
    'the run log records the call as a timeout',
  )
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
