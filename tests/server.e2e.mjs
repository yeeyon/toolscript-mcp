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
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const BENCH_TOOLS = ['create_ticket', 'get_deploys', 'list_issues', 'query_logs', 'search_messages']
const MARKER = `fake-${randomUUID()}`
const BAD_URL = `http://[fake-${randomUUID()}]/mcp`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-e2e-'))
const PROBE = path.join(ROOT, 'tests', 'probe-server.mjs')
const probeFile = path.join(dir, 'probe.json')
const passedFile = path.join(dir, 'passed.json')
const crashFile = path.join(dir, 'crash.json')
const flakyFile = path.join(dir, 'flaky.json')
const slowFile = path.join(dir, 'slow.json')
const hangFile = path.join(dir, 'hang.pid')
const writerFile = path.join(dir, 'writer.json')
const consentFile = path.join(dir, 'consent.json')
const bridgeFile = path.join(dir, 'bridge.json')
const picFile = path.join(dir, 'pic.json')
const waryFile = path.join(dir, 'wary.json')
// The image that a probe in --image mode answers: a PNG of 1 by 1 pixel.
const PIC_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
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
  TOOLSCRIPT_E2E_BAD_URL: BAD_URL,
  TMPDIR: TMP,
  TEMP: TMP,
  TMP,
  HOME,
  USERPROFILE: HOME,
}
const locked = http.createServer((req, res) => void res.writeHead(req.url?.startsWith('/mcp') ? 401 : 404).end())
await new Promise(resolve => locked.listen(0, '127.0.0.1', resolve))
const LOCKED_URL = `http://127.0.0.1:${locked.address().port}`
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
      { match: 'mcp__x__probe', action: 'allow' },
      { match: 'mcp__consent__probe', action: 'allow' },
      { match: 'mcp__pic__probe', action: 'allow' },
      { match: 'mcp__wary__probe', action: 'allow' },
      // It matches the tools of the bridge claude-code, but does not name that server, so it does not allow them.
      { match: 'mcp__claude-code*', action: 'allow' },
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
      // Its allowed tool writes a file, such as the config. It also answers a tool name that it does not list.
      x: { command: process.execPath, args: [PROBE, writerFile, '--write-on-call'] },
      // Its tool requires a person on every call, and the policy allows it.
      consent: { command: process.execPath, args: [PROBE, consentFile, '--requires-person'] },
      // Its tool answers a text block and an image block.
      pic: { command: process.execPath, args: [PROBE, picFile, '--image'] },
      // Its tool answers JSON in an untrusted wrapper.
      wary: { command: process.execPath, args: [PROBE, waryFile, '--untrusted'] },
      // A variable that is not set: this entry fails alone, and the server still starts.
      broken: { command: process.execPath, env: { TOKEN: '${TOOLSCRIPT_E2E_UNSET}' } },
      // An HTTP URL that does not parse, as text and from a variable: each entry fails alone.
      badurl: { type: 'http', url: 'http://' },
      badvar: { type: 'http', url: '${TOOLSCRIPT_E2E_BAD_URL}' },
      // Answers 401 to everything, and HOME has no tokens: it needs a login.
      locked: { type: 'http', url: `${LOCKED_URL}/mcp` },
      // The key of the Claude Code bridge: its tools skip the checks of the client.
      'claude-code': { command: process.execPath, args: [PROBE, bridgeFile] },
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
  locked.closeAllConnections()
  locked.close()
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
  // Linux and macOS: spawn ... ENOENT. Windows: cmd.exe says on stderr that the command is not recognized, and
  // search_tools shows no stderr, because it can hold a secret that is not in the config.
  assert.match(text, /## Not connected\n(- .+\n)*- missing: .*(ENOENT|Its stderr is not shown here)/, text)
  assert.doesNotMatch(text, /not recognized/, text)
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

test('(d) a config entry with an error fails alone, and search_tools shows the error', async () => {
  const text = await search('')
  assert.match(
    text,
    /- broken: invalid entry in the toolscript-mcp config: mcpServers\.broken\.env\.TOKEN: the environment variable TOOLSCRIPT_E2E_UNSET is not set/,
    text,
  )
  assert.match(text, /### mcp__bench__/, text)
})

test('(k) an http entry whose URL does not parse fails alone, and the error names the key, not the URL', async () => {
  const text = await search('')
  assert.match(
    text,
    /- badurl: invalid entry in the toolscript-mcp config: mcpServers\.badurl\.url: must be a valid URL/,
    text,
  )
  assert.match(
    text,
    /- badvar: invalid entry in the toolscript-mcp config: mcpServers\.badvar\.url: must be a valid URL/,
    text,
  )
  assert.match(text, /### mcp__bench__/, text)
  assert.ok(!text.includes(BAD_URL) && !transport.stderr.includes(BAD_URL), 'the URL of the variable is not shown')
})

test('(p) an http server that answers 401 without tokens asks for a login, with this config file', async () => {
  const text = await search('')
  // The command from the sources: node with this main.js from a clone, npx from an npm install. Node 22.13 runs
  // TypeScript only with the flag.
  const source = f => JSON.stringify(pathToFileURL(path.join(ROOT, f)).href)
  const expected = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import { loginCommand } from ${source('src/core/config.ts')}
import { detectLaunch } from ${source('src/host/start.ts')}
process.stdout.write(loginCommand(detectLaunch(process.argv[1]), process.platform, 'locked', process.argv[2]))`,
      path.resolve(MAIN),
      path.resolve(configFile),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(expected.status, 0, expected.stderr)
  const command = expected.stdout
  assert.match(command, /^(node|npx) .* login locked --config /)
  assert.ok(text.includes(`- locked: it needs an OAuth login. Ask the person to run \`${command}\``), text)
  const login = spawnSync(process.execPath, [MAIN, 'login', 'bench', '--config', configFile], {
    env: SERVER_ENV,
    encoding: 'utf8',
  })
  assert.equal(login.status, 1, login.stderr)
  assert.match(login.stderr, /bench is a stdio server\. Only an HTTP server logs in with OAuth\./)
  assert.equal(login.stdout, '')
})

test('(p2) --help and -h print the usage to stderr and exit 0, for the server, init, login and doctor', () => {
  for (const args of [
    ['--help'],
    ['-h'],
    ['init', '--help'],
    ['init', '-h'],
    ['login', '--help'],
    ['login', '-h'],
    ['doctor', '--help'],
  ]) {
    const run = spawnSync(process.execPath, [MAIN, ...args], { env: SERVER_ENV, input: '', encoding: 'utf8' })
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`)
    assert.equal(run.stdout, '', `${args.join(' ')} wrote to stdout`)
    assert.match(run.stderr, /usage: toolscript-mcp/, args.join(' '))
    assert.ok(!/Unknown option/.test(run.stderr), run.stderr)
  }
})

test('(e) a nested toolscript-mcp refuses to start', async () => {
  const text = await search('')
  // The refusal goes to the stderr of the nested child, which search_tools does not show.
  assert.match(text, /- nested: .*Its stderr is not shown here/, text)
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

// The calls that reached a consent probe of either server.
const consentCalls = () =>
  (fs.existsSync(`${consentFile}.log`) ? fs.readFileSync(`${consentFile}.log`, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .filter(line => JSON.parse(line).event === 'call').length

test('run (q) an allow rule does not let a tool that requires a person run: a client that cannot ask is refused, and the person is asked', async () => {
  const code = 'return await call("mcp__consent__probe", {})'
  const refused = await run(code)
  assert.equal(refused.isError, true)
  assert.ok(refused.text.includes('this MCP client cannot ask the person'), refused.text)
  assert.ok(refused.text.includes("mcp__consent__probe needs the person's approval at each run"), refused.text)
  assert.equal(consentCalls(), 0)

  const prompts = asking.prompts.length
  asking.answer = 'accept'
  const accepted = await run(code, askingClient)
  assert.equal(accepted.isError, false, accepted.text)
  assert.equal(asking.prompts.length, prompts + 1)
  assert.ok(
    asking.prompts
      .at(-1)
      .includes(
        'Its server requires your approval each time, so a policy rule cannot allow it:\n- mcp__consent__probe\n',
      ),
    asking.prompts.at(-1),
  )
  assert.equal(consentCalls(), 1)
})

test('run (r) a tool that requires a person, with a name built at run time, is refused at call time with no prompt', async () => {
  const prompts = asking.prompts.length
  const calls = consentCalls()
  const r = await run(
    'try {\n  return await call("mcp__consent__" + "probe", {})\n} catch (e) {\n  return "caught: " + e.message\n}',
    askingClient,
  )
  assert.equal(r.isError, false, r.text)
  assert.ok(r.text.startsWith('"caught: not approved: mcp__consent__probe needs the person\'s approval'), r.text)
  assert.equal(asking.prompts.length, prompts, 'a name built at run time is never asked')
  assert.equal(consentCalls(), calls)
})

// The calls that reached the bridge probe of either server.
const bridgeCalls = () =>
  (fs.existsSync(`${bridgeFile}.log`) ? fs.readFileSync(`${bridgeFile}.log`, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .filter(line => JSON.parse(line).event === 'call').length

test('run (s) an allow rule that does not name the bridge asks for its tool, and the instructions keep its tools direct', async () => {
  assert.match(client.getInstructions() ?? '', /the other tools of claude-code, use your own built-in tools directly/)
  assert.ok(transport.stderr.includes('toolscript-mcp: Claude Code bridges: claude-code\n'), transport.stderr)
  const code = 'return await call("mcp__claude-code__probe", {})'
  const refused = await run(code)
  assert.equal(refused.isError, true)
  assert.ok(refused.text.includes('this MCP client cannot ask the person'), refused.text)
  assert.ok(refused.text.includes('{"match": "mcp__claude-code__probe", "action": "allow"}'), refused.text)
  assert.equal(bridgeCalls(), 0)

  const prompts = asking.prompts.length
  asking.answer = 'decline'
  const declined = await run(code, askingClient)
  assert.ok(declined.text.includes('the person did not approve'), declined.text)
  assert.equal(asking.prompts.length, prompts + 1)
  assert.ok(
    asking.prompts
      .at(-1)
      .includes(
        'which no policy rule allows:\n- mcp__claude-code__probe\nAn allow rule for a tool of the Claude Code bridge claude-code must start with mcp__claude-code__.\n',
      ),
    asking.prompts.at(-1),
  )
  const built = await run(
    'try { return await call("mcp__claude-code__" + "probe", {}) } catch (e) { return e.message }',
  )
  assert.ok(
    built.text.includes(
      'not approved: an allow rule for a tool of the Claude Code bridge claude-code must start with mcp__claude-code__, such as',
    ),
    built.text,
  )
  assert.equal(bridgeCalls(), 0)
  asking.answer = 'accept'
})

// With no bridge, an allow lowered to ask applies at once. Here the rule skips the bridge, and as ask it decides it.
test('run (s2) an allow over the bridge lowered to ask waits for a restart, and the note names it by place only', async () => {
  const lowered = JSON.parse(CONFIG_TEXT)
  const index = lowered.policy.findIndex(r => r.match === 'mcp__claude-code*')
  lowered.policy[index].action = 'ask'
  try {
    fs.writeFileSync(configFile, JSON.stringify(lowered))
    const kept = await run('return 1')
    assert.ok(kept.text.includes('## Policy not reloaded'), kept.text)
    assert.ok(kept.text.includes(`added policy[${index}] (ask); removed policy[${index}] (allow).`), kept.text)
    assert.ok(!kept.text.includes('mcp__claude-code*'), kept.text)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
  }
  const restored = await run('return 1')
  assert.ok(!restored.text.includes('## Policy'), restored.text)
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

const TICKET = 'return (await call("mcp__bench__create_ticket", { title: "x" })).created.key'
const DENY_TICKET = '{"match": "mcp__bench__create_ticket", "action": "deny"}'
const ALLOW_TICKET = '{"match": "mcp__bench__create_ticket", "action": "allow"}'
// The config of the scenario: a program writes a policy that allows the denied create_ticket.
const looserConfig = () => {
  const looser = JSON.parse(CONFIG_TEXT)
  looser.policy[0].action = 'allow'
  return JSON.stringify(looser)
}

test('run (m) a looser policy waits for a restart when the client cannot ask, and a tighter one applies at once', async () => {
  try {
    fs.writeFileSync(configFile, looserConfig())
    const kept = await run(TICKET)
    assert.equal(kept.isError, true, kept.text)
    assert.ok(kept.text.includes('is denied by policy[0]'), kept.text)
    const looser =
      'the change can let a tool run with less approval: added policy[0] (allow); removed policy[0] (deny).'
    assert.ok(kept.text.includes(`The toolscript-mcp policy in ${configFile} changed, and ${looser}`), kept.text)
    assert.ok(kept.text.includes('restart toolscript-mcp'), kept.text)
    assert.equal(benchCalls('create_ticket'), 0)
    assert.ok(
      transport.stderr.includes(
        `the policy in ${configFile} was not applied, because it can let a tool run with less approval (added ${ALLOW_TICKET}; removed ${DENY_TICKET}): restart toolscript-mcp to apply it\n`,
      ),
      transport.stderr,
    )
    const again = await run(TICKET)
    assert.ok(again.text.includes(`changed, and ${looser}`), 'a client that cannot ask gets the note at each run')

    fs.writeFileSync(configFile, '{"policy": [')
    const broken = await run(TICKET)
    assert.ok(broken.text.includes('is denied by policy[0]'), broken.text)
    assert.ok(broken.text.includes('## Policy not reloaded'), broken.text)
    assert.ok(broken.text.includes('- the config is not valid JSON'), broken.text)

    const tighter = JSON.parse(CONFIG_TEXT)
    tighter.policy[3].action = 'deny'
    fs.writeFileSync(configFile, JSON.stringify(tighter))
    const deploys = await run('return await call("mcp__bench__get_deploys", { date: "2026-10-09" })')
    assert.equal(deploys.isError, true, deploys.text)
    assert.ok(deploys.text.includes('is denied by policy[3]'), deploys.text)
    assert.ok(
      deploys.text.endsWith('The policy changed: added policy[3] (deny); removed policy[3] (ask).'),
      deploys.text,
    )
    const change =
      'added {"match": "mcp__bench__get_deploys", "action": "deny"}; removed {"match": "mcp__bench__get_deploys", "action": "ask"}'
    assert.ok(transport.stderr.includes(`the policy changed: ${change}\n`), transport.stderr)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
  }
  assert.equal(benchCalls('create_ticket'), 0)
})

test('run (n) a looser policy asks the person: decline keeps the policy in force with no new prompt until the file changes, accept applies it', async () => {
  const prompts = asking.prompts.length
  try {
    fs.writeFileSync(configFile, looserConfig())
    asking.answer = 'decline'
    const declined = await run(TICKET, askingClient)
    assert.equal(declined.isError, true, declined.text)
    assert.ok(declined.text.includes('is denied by policy[0]'), declined.text)
    assert.ok(declined.text.includes('The person did not approve it'), declined.text)
    assert.equal(asking.prompts.length, prompts + 1)
    const asked = asking.prompts.at(-1).split('\n')
    assert.equal(
      asked[0],
      `The toolscript-mcp policy in ${configFile} changed, and the change can let a tool run with less approval: added ${ALLOW_TICKET}; removed ${DENY_TICKET}.`,
    )
    assert.ok(asked.includes(`policy[0] ${ALLOW_TICKET}`), asked.join('\n'))
    assert.equal(asked.filter(l => l.startsWith('policy[')).length, JSON.parse(CONFIG_TEXT).policy.length)
    assert.equal(asked.at(-1), 'Apply the new policy?')
    assert.equal(benchCalls('create_ticket'), 0)

    const silent = await run(TICKET, askingClient)
    assert.ok(silent.text.includes('is denied by policy[0]'), silent.text)
    assert.ok(
      silent.text.endsWith(
        `The person declined the policy in ${configFile}, so this run used the policy in force. Do not change the config yourself.`,
      ),
      silent.text,
    )
    assert.equal(asking.prompts.length, prompts + 1, 'the declined policy is not asked again')

    fs.writeFileSync(configFile, CONFIG_TEXT)
    const same = await run(TICKET, askingClient)
    assert.ok(same.text.includes('is denied by policy[0]') && !same.text.includes('## Policy'), same.text)
    fs.writeFileSync(configFile, looserConfig())
    asking.answer = 'accept'
    const accepted = await run(TICKET, askingClient)
    assert.equal(accepted.isError, false, accepted.text)
    assert.ok(
      accepted.text.endsWith('The policy changed: added policy[0] (allow); removed policy[0] (deny).'),
      accepted.text,
    )
    assert.equal(asking.prompts.length, prompts + 2)
    assert.equal(benchCalls('create_ticket'), 1)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
  }
  const tighter = await run(TICKET, askingClient)
  assert.ok(tighter.text.includes('is denied by policy[0]'), tighter.text)
  assert.ok(
    tighter.text.endsWith('The policy changed: added policy[0] (deny); removed policy[0] (allow).'),
    tighter.text,
  )
  assert.equal(asking.prompts.length, prompts + 2, 'a tighter policy applies with no prompt')
  assert.equal(benchCalls('create_ticket'), 1)
})

test('run (n2) a looser policy whose prompt got no answer is asked again at the next run', async () => {
  const prompts = asking.prompts.length
  const tickets = benchCalls('create_ticket')
  try {
    fs.writeFileSync(configFile, looserConfig())
    asking.answer = 'cancel'
    const dismissed = await run(TICKET, askingClient)
    assert.ok(dismissed.text.includes('is denied by policy[0]'), dismissed.text)
    assert.ok(dismissed.text.includes('The person did not approve it'), dismissed.text)
    assert.equal(asking.prompts.length, prompts + 1)

    asking.answer = 'decline'
    const again = await run(TICKET, askingClient)
    assert.ok(again.text.includes('The person did not approve it'), again.text)
    assert.equal(asking.prompts.length, prompts + 2, 'a prompt with no answer is asked again')
    assert.equal(benchCalls('create_ticket'), tickets)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
  }
})

test('run (o) a program that writes a policy whose new allow is shadowed for every listed tool is asked, and a decline keeps the built name refused', async () => {
  const prompts = asking.prompts.length
  const hiddenCalls = () =>
    (fs.existsSync(`${writerFile}.log`) ? fs.readFileSync(`${writerFile}.log`, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(e => e.event === 'call' && e.name === 'hidden').length
  const shadow = JSON.parse(CONFIG_TEXT)
  shadow.policy.unshift({ match: 'mcp__x__', action: 'ask' }, { match: 'mcp__x__*', action: 'allow' })
  const write = `await call("mcp__x__probe", { path: ${JSON.stringify(configFile)}, text: ${JSON.stringify(JSON.stringify(shadow))} })\nreturn "written"`
  const hidden =
    'const name = "mcp__x__" + "hidden"\ntry {\n  return await call(name, {})\n} catch (err) {\n  return err.message\n}'
  try {
    asking.answer = 'decline'
    const wrote = await run(write, askingClient)
    assert.equal(wrote.isError, false, wrote.text)
    assert.equal(fs.readFileSync(configFile, 'utf8'), JSON.stringify(shadow))

    const refused = await run(hidden, askingClient)
    assert.ok(refused.text.includes('no tool \\"mcp__x__hidden\\" on the connected server'), refused.text)
    assert.ok(refused.text.includes('The person did not approve it'), refused.text)
    assert.equal(hiddenCalls(), 0, 'the hidden tool never ran')
    assert.equal(asking.prompts.length, prompts + 1)
    const asked = asking.prompts.at(-1).split('\n')
    assert.equal(
      asked[0],
      `The toolscript-mcp policy in ${configFile} changed, and the change can let a tool run with less approval: added {"match": "mcp__x__*", "action": "allow"}, {"match": "mcp__x__", "action": "ask"}.`,
    )
    assert.ok(asked.includes('policy[0] {"match": "mcp__x__", "action": "ask"}'), asked.join('\n'))
    assert.ok(asked.includes('policy[1] {"match": "mcp__x__*", "action": "allow"}'), asked.join('\n'))

    const again = await run(hidden, askingClient)
    assert.ok(again.text.includes('no tool \\"mcp__x__hidden\\" on the connected server'), again.text)
    assert.ok(again.text.includes(`The person declined the policy in ${configFile}`), again.text)
    assert.equal(asking.prompts.length, prompts + 1, 'a declined policy is not asked again')
    assert.equal(hiddenCalls(), 0)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
  }
})

test('(j) init imports the servers of a client into a config that the server starts with', async () => {
  const home = path.join(dir, 'init-home')
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
  assert.ok(
    init.stderr.includes('  - bench (cursor)\n    In an editor, remove its entry from "mcpServers" of this file.'),
    init.stderr,
  )
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

test('run (s) an image of a call is a file reference, and a returned reference is an MCP image block', async () => {
  const code = 'return (await call("mcp__pic__probe", {})).attachments[0]'
  const r = await client.callTool({ name: 'run_code', arguments: { code } })
  assert.equal(r.isError, false, r.content[0].text)
  const ref = JSON.parse(r.content[0].text.slice(0, r.content[0].text.indexOf('\n\n---')))
  assert.equal(ref.type, 'image')
  assert.equal(ref.mimeType, 'image/png')
  assert.deepEqual(fs.readFileSync(ref.file), Buffer.from(PIC_BASE64, 'base64'), 'the file holds the decoded bytes')
  assert.equal(path.dirname(path.dirname(ref.file)), path.join(HOME, '.toolscript-mcp', 'files'))
  assert.deepEqual(r.content.slice(1), [{ type: 'image', data: PIC_BASE64, mimeType: 'image/png' }])
  assert.equal(r.content[0].text.includes(PIC_BASE64), false, 'no base64 in the text')
})

test('run (t) the program gets the JSON in an untrusted wrapper, and the model gets it in a wrapper of the server', async () => {
  const r = await client.callTool({
    name: 'run_code',
    arguments: { code: 'return (await call("mcp__wary__probe", {})).pid' },
  })
  const text = r.content[0].text
  assert.equal(r.isError, false, text)
  // The notes of the run come after the value in the wrapper. Only the policy note of an earlier case follows it.
  const mark =
    /^<<([0-9a-f]{32})>> \[UNTRUSTED TOOL CONTENT: [^\]\n]*\] <<\1>>\n(\d+)(\n\n[^]*)?\n<<\/\1>>\n\n--- 1 MCP call/.exec(
      text,
    )
  assert.ok(mark !== null, text)
  const after = text.slice(text.indexOf(`<</${mark[1]}>>`))
  assert.deepEqual(
    after.match(/\n## .*/g) ?? [],
    after.includes('\n## Policy') ? ['\n## Policy not reloaded'] : [],
    text,
  )
  assert.deepEqual(
    probeEvents(waryFile, 'call').map(e => e.pid),
    [Number(mark[2])],
    'the value is the pid of the probe that answered the call',
  )
  assert.equal(text.includes('PROBE CONTENT'), false, 'the wrapper of the tool does not reach the model')
})

test('run (u) a policy that an untrusted run writes into the config reaches the next note with no text of the file', async () => {
  // The program puts the untrusted value in a rule, through a tool that the policy allows.
  const writes = rules =>
    `const w = await call("mcp__wary__probe", {})\nconst config = JSON.parse(${JSON.stringify(CONFIG_TEXT)})\nconfig.policy = ${rules}\nawait call("mcp__x__probe", { path: ${JSON.stringify(configFile)}, text: JSON.stringify(config) })\nreturn "written"`
  const said = /UNTRUSTED_\d+_SAYS/
  try {
    const denied = await run(writes('[{ match: `mcp__UNTRUSTED_${w.pid}_SAYS`, action: "deny" }, ...config.policy]'))
    assert.equal(denied.isError, false, denied.text)
    assert.match(fs.readFileSync(configFile, 'utf8'), said)
    const next = await run('return 2')
    assert.ok(next.text.includes('policy[0] (deny)'), next.text)
    assert.doesNotMatch(next.text, said)

    const broken = await run(
      writes(
        '[{ match: `UNTRUSTED_${w.pid}_SAYS`, action: `UNTRUSTED_${w.pid}_SAYS`, [`UNTRUSTED_${w.pid}_SAYS`]: 1 }]',
      ),
    )
    assert.equal(broken.isError, false, broken.text)
    const stale = await run('return 3')
    assert.ok(stale.text.includes('## Policy not reloaded'), stale.text)
    assert.ok(stale.text.includes('- policy[0].action: must be "allow", "deny" or "ask"'), stale.text)
    assert.ok(stale.text.endsWith('Ask the person to fix the config. Do not change the config yourself.'), stale.text)
    assert.doesNotMatch(stale.text, said)
  } finally {
    fs.writeFileSync(configFile, CONFIG_TEXT)
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
