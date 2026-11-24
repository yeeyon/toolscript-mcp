// End-to-end test of the built server (dist/host/main.js) with the built-in Workspace (issue #144), on Linux, macOS and
// Windows. A client starts toolscript-mcp over stdio with a temp config that has one root, no bridge and no other server,
// a fake HOME and a PATH with no Claude. One program searches a disposable project and reads the file that it finds.
// Pull request A: the search and read part. Run `npm run build` first.
//
//   node tests/workspace.e2e.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const win = process.platform === 'win32'

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-ws-e2e-')))
after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
const MARKER = `SECRET-${randomBytes(8).toString('hex')}`

// The disposable project.
const project = path.join(base, 'project')
const files = {
  'src/retry.ts': 'export const config = {\r\n  maxAttempts: 3,\r\n  delayMs: 100,\r\n}\r\n',
  'test/retry.test.mjs': "import { test } from 'node:test'\ntest('five attempts', () => {})\n",
  '.env': `TOKEN=${MARKER}\n`,
  'notes/crlf.txt': 'one\r\ntwo\r\n',
}
for (const [name, text] of Object.entries(files)) {
  const file = path.join(project, ...name.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const home = path.join(base, 'home')
fs.mkdirSync(home)
const tmp = path.join(base, 'tmp')
fs.mkdirSync(tmp)

// A PATH with the folder of this Node and the system folders only, and no file named claude in any of them.
const pathFolders = [
  path.dirname(process.execPath),
  ...(win ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin']),
]
for (const folder of pathFolders)
  for (const name of ['claude', 'claude.exe', 'claude.cmd', 'claude.ps1'])
    assert.ok(!fs.existsSync(path.join(folder, name)), `${name} is in ${folder}: this test runs with no Claude`)
const env = {
  PATH: pathFolders.join(path.delimiter),
  HOME: home,
  USERPROFILE: home,
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
  ...(win && { SystemRoot: process.env.SystemRoot, APPDATA: path.join(home, 'AppData') }),
  TOOLSCRIPT_SHARE: '0',
}

const configWith = (name, json) => {
  const file = path.join(base, name)
  fs.writeFileSync(file, JSON.stringify(json))
  return file
}
const withWorkspace = configWith('workspace.json', { mcpServers: {}, workspace: { roots: [{ path: project }] } })
const withoutWorkspace = configWith('plain.json', { mcpServers: {} })

// A client transport over the child's stdio that keeps every stdout line, so the test sees what is not JSON-RPC too.
class RecordingTransport {
  lines = []
  stderr = ''
  constructor(config, cwd) {
    this.config = config
    this.cwd = cwd
  }
  start() {
    this.child = spawn(process.execPath, [MAIN, '--config', this.config], {
      env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
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

/** A client that can ask the person and says yes. `prompts` keeps each prompt. */
const connect = async (config, cwd) => {
  const prompts = []
  const client = new Client({ name: 'workspace-e2e', version: '0' }, { capabilities: { elicitation: {} } })
  client.setRequestHandler(ElicitRequestSchema, req => {
    prompts.push(req.params.message)
    return { action: 'accept' }
  })
  const transport = new RecordingTransport(config, cwd)
  await client.connect(transport)
  const run = async code => {
    const r = await client.callTool({ name: 'run_code', arguments: { code } })
    return { text: r.content[0].text, isError: r.isError === true }
  }
  const search = async query => (await client.callTool({ name: 'search_tools', arguments: { query } })).content[0].text
  const close = async () => {
    const pid = transport.child.pid
    await client.close()
    await Promise.race([transport.exited, new Promise(resolve => setTimeout(resolve, 5000))])
    return pid
  }
  return { client, transport, prompts, run, search, close }
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stat = file => {
  const s = fs.statSync(file)
  return { bytes: fs.readFileSync(file), mtimeMs: s.mtimeMs, size: s.size }
}

const PROGRAM = `
const hits = await call("mcp__workspace__search", { query: "maxAttempts: 3", include: ["src/**/*.ts"] })
if (hits.matches.length !== 1) throw Error("Expected one match")
const path = hits.matches[0].path
const file = await call("mcp__workspace__read", { path })
return { path, content: file.content, hash: file.hash, line: hits.matches[0].line, column: hits.matches[0].column }
`

/** The JSON of a run that returned a value: the text before the footer, inside the untrusted wrapper. */
const returned = text => {
  const m = /^<<([0-9a-f]{32})>> \[UNTRUSTED TOOL CONTENT: [^\]\n]*\] <<\1>>\n([\s\S]*)\n<<\/\1>>\n\n---/.exec(text)
  assert.ok(m, `the result is in the untrusted wrapper: ${text.slice(0, 200)}`)
  return JSON.parse(m[2].split('\n\n---')[0])
}

describe('the built server with the Workspace', () => {
  let session
  before(async () => {
    session = await connect(withWorkspace, project)
  })

  test('a program searches, then reads the file, with no prompt and no change to the file', async () => {
    const file = path.join(project, 'src', 'retry.ts')
    const before = stat(file)
    const logFile = path.join(home, '.toolscript-mcp', 'runs.jsonl')
    const r = await session.run(PROGRAM)
    assert.equal(r.isError, false, r.text)
    const value = returned(r.text)
    assert.equal(value.path, 'src/retry.ts')
    assert.equal(
      Buffer.from(value.content).toString('hex'),
      before.bytes.toString('hex'),
      'content matches the bytes on disk',
    )
    assert.equal(value.hash, `sha256:${createHash('sha256').update(before.bytes).digest('hex')}`)
    assert.deepEqual([value.line, value.column], [2, 3])
    const after = stat(file)
    assert.deepEqual(after, before, 'the bytes and the modified time of the file are as they were')
    assert.deepEqual(session.prompts, [], 'a read-only program asks no one')
    // The run log has the two calls, and the secret of .env is in no result, log or prompt.
    const log = fs.readFileSync(logFile, 'utf8')
    const record = JSON.parse(log.trim().split('\n').at(-1))
    assert.deepEqual(
      record.calls.map(c => [c.tool, c.decision, c.ok]),
      [
        ['mcp__workspace__search', 'allow', true],
        ['mcp__workspace__read', 'allow', true],
      ],
    )
    for (const [name, text] of [
      ['result', r.text],
      ['log', log],
      ['stderr', session.transport.stderr],
    ])
      assert.ok(!text.includes(MARKER), `the secret is in the ${name}`)
  })

  test('the excluded file and a path that leaves the root are refused, and the refusal holds no secret', async () => {
    const r = await session.run(
      'const out = []\nfor (const path of [".env", "../outside.txt", "src/../.env", "C:/Windows/win.ini"])\n  try { await call("mcp__workspace__read", { path }) } catch (e) { out.push(e.message.split(":")[0]) }\nreturn out',
    )
    assert.equal(r.isError, false, r.text)
    assert.deepEqual(returned(r.text), ['excluded', 'bad-path', 'bad-path', 'bad-path'])
    assert.ok(!r.text.includes(MARKER))
    const found = await session.run('return (await call("mcp__workspace__search", { query: "TOKEN" })).matches.length')
    assert.deepEqual(returned(found.text), 0)
    const listed = await session.run(
      'return (await call("mcp__workspace__list", { depth: 3 })).entries.map(e => e.path)',
    )
    assert.deepEqual(returned(listed.text), [
      'notes',
      'notes/crlf.txt',
      'src',
      'src/retry.ts',
      'test',
      'test/retry.test.mjs',
    ])
  })

  test('search_tools shows the four tools with their result types, and the server lists only its own two tools', async () => {
    const shown = await session.search('workspace')
    for (const name of ['list', 'search', 'read', 'stat'])
      assert.match(shown, new RegExp(`### mcp__workspace__${name}\\n`))
    assert.match(shown, /}\): Promise<\{\n {2}path: string\n {2}content: string\n {2}hash: string/)
    const tools = await session.client.listTools()
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['run_code', 'search_tools'])
  })

  test('the server started in another folder still binds the one root, and writes only JSON-RPC to stdout', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    fs.mkdirSync(elsewhere)
    const other = await connect(withWorkspace, elsewhere)
    const r = await other.run('return (await call("mcp__workspace__read", { path: "notes/crlf.txt" })).content')
    assert.equal(returned(r.text), 'one\r\ntwo\r\n')
    const pid = await other.close()
    for (const line of other.transport.lines)
      assert.doesNotThrow(() => JSON.parse(line), 'a stdout line that is not JSON')
    assert.match(other.transport.stderr, /Workspace: root .*, read-only, confined by (proc|realpath|nofollow-any)/)
    assert.equal(alive(pid), false, 'no process of the server is left')
  })

  test('after the session closes, no process of the server is left', async () => {
    const pid = await session.close()
    assert.equal(alive(pid), false)
    for (const line of session.transport.lines) assert.doesNotThrow(() => JSON.parse(line))
  })
})

describe('the built server with no workspace section', () => {
  test('lists no Workspace tool and refuses a call of one', async () => {
    const s = await connect(withoutWorkspace, project)
    try {
      assert.doesNotMatch(await s.search('workspace read'), /mcp__workspace__/)
      const r = await s.run('return await call("mcp__workspace__read", { path: "src/retry.ts" })')
      assert.equal(r.isError, true)
      assert.ok(!r.text.includes('maxAttempts'), r.text)
    } finally {
      await s.close()
    }
  })

  test('an unavailable root shows its reason in the search, and the other servers work', async () => {
    const second = path.join(base, 'second-root')
    fs.mkdirSync(second, { recursive: true })
    const config = configWith('two-roots.json', {
      mcpServers: {},
      workspace: { roots: [{ path: project }, { path: second }] },
    })
    const s = await connect(config, base)
    try {
      const shown = await s.search('workspace')
      assert.match(shown, /## Not connected\n- workspace: .*Start the client in one of them/)
      const r = await s.run('return 1')
      assert.deepEqual(r.isError, false)
    } finally {
      await s.close()
    }
  })
})
