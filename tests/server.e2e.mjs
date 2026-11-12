// End-to-end test of the built server (dist/host/main.js), on Linux, macOS and
// Windows. An SDK Client starts toolscript-mcp over stdio with a temp config
// and reads every line of its stdout. Run `npm run build` first.
//
//   node tests/server.e2e.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
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
const MAIN = path.join(ROOT, 'dist', 'host', 'main.js')
const BENCH_TOOLS = ['create_ticket', 'get_deploys', 'list_issues', 'query_logs', 'search_messages']
const MARKER = `fake-${randomUUID()}`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-e2e-'))
const PROBE = path.join(ROOT, 'tests', 'probe-server.mjs')
const probeFile = path.join(dir, 'probe.json')
const passedFile = path.join(dir, 'passed.json')
const crashFile = path.join(dir, 'crash.json')
const hangFile = path.join(dir, 'hang.pid')
const configFile = path.join(dir, 'config.json')
fs.writeFileSync(
  configFile,
  JSON.stringify({
    mcpServers: {
      // `node` from PATH, not process.execPath: the SDK's short environment must still find it.
      bench: { command: 'node', args: [path.join(ROOT, 'bench', 'fake-server.mjs')] },
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
      env: { ...process.env, TOOLSCRIPT_E2E_MARKER: MARKER },
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

const transport = new RecordingTransport()
const client = new Client({ name: 'e2e', version: '0' })
const search = async (query, limit) => {
  const r = await client.callTool({ name: 'search_tools', arguments: limit ? { query, limit } : { query } })
  assert.equal(r.isError, false)
  return r.content[0].text
}

before(async () => {
  assert.ok(fs.existsSync(MAIN), 'dist/host/main.js is missing: run npm run build first')
  await client.connect(transport)
})

// After a failed test the server can still run: end it, so the run does not hang.
after(async () => {
  await client.close().catch(() => {})
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

test('(a) tools/list shows only search_tools', async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map(t => t.name),
    ['search_tools'],
  )
  assert.equal(client.getInstructions()?.includes('search_tools'), true)
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

test('(f) stdout holds only JSON-RPC, and (h) the server and its children end when stdin closes', async () => {
  await client.close()
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
})
