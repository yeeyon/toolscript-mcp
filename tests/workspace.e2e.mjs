// End-to-end test of the built server (dist/host/main.js) with the built-in Workspace (issue #144), on Linux, macOS and
// Windows. A client starts toolscript-mcp over stdio with a temp config that has one root, no bridge and no other server,
// a fake HOME and a PATH with no Claude. One program searches a disposable project and reads the file that it finds.
// The first describe is the search and read part, then the named tasks, the change tools and, last, the whole chain in
// one program: search, read, diff, edit, run_task. Run `npm run build` first.
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ElicitRequestSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

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

/**
 * A client that can ask the person and says yes. `prompts` keeps each prompt. `answer`: 'decline' says no, and 'none'
 * is a client that cannot ask at all.
 */
const connect = async (config, cwd, answer = 'accept', roots = undefined) => {
  const prompts = []
  const client = new Client(
    { name: 'workspace-e2e', version: '0' },
    { capabilities: { ...(answer !== 'none' && { elicitation: {} }), ...(roots !== undefined && { roots: {} }) } },
  )
  // `roots`: the URIs that the client answers to roots/list. Undefined is a client that declares no roots capability.
  if (roots !== undefined)
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map(uri => ({ uri })) }))
  if (answer !== 'none')
    client.setRequestHandler(ElicitRequestSchema, req => {
      prompts.push(req.params.message)
      return { action: answer }
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

/**
 * The JSON of a run that returned a value: the text before the footer, inside the untrusted wrapper. A run that applied a
 * change lists it after the value, in a section of its own.
 */
const returned = text => {
  const m = /^<<([0-9a-f]{32})>> \[UNTRUSTED TOOL CONTENT: [^\]\n]*\] <<\1>>\n([\s\S]*)\n<<\/\1>>\n\n---/.exec(text)
  assert.ok(m, `the result is in the untrusted wrapper: ${text.slice(0, 200)}`)
  return JSON.parse(m[2].split('\n\n---')[0].split('\n\n## Workspace changes')[0])
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

  test('search with a folder glob beside a sibling folder finds its hits and is not truncated', async () => {
    const r = await session.run(
      'const r = await call("mcp__workspace__search", { query: "ttempts", include: ["src/**/*.ts"] })\nreturn { paths: r.matches.map(m => m.path), truncated: r.truncated, scanned: r.filesScanned }',
    )
    assert.equal(r.isError, false, r.text)
    assert.deepEqual(returned(r.text), { paths: ['src/retry.ts'], truncated: false, scanned: 1 })
  })

  test('search takes query as a text or an array of texts, and refuses a number', async () => {
    const r = await session.run(
      'const s = await call("mcp__workspace__search", { query: "ttempts" })\nconst a = await call("mcp__workspace__search", { query: ["ttempts", "delayMs"], include: ["src/**/*.ts"] })\nlet refused\ntry { await call("mcp__workspace__search", { query: 5 }) } catch (e) { refused = e.message.split(":")[0] }\nreturn { untagged: s.matches.length > 0 && s.matches.every(m => m.query === undefined), tagged: [...new Set(a.matches.map(m => m.query))].sort(), refused }',
    )
    assert.equal(r.isError, false, r.text)
    assert.deepEqual(returned(r.text), { untagged: true, tagged: ['delayMs', 'ttempts'], refused: 'bad-input' })
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

  test('search_tools shows the read tools and diff with their result types and no change tool, and the server lists only its own two tools', async () => {
    const shown = await session.search('workspace')
    for (const name of ['list', 'search', 'read', 'stat', 'diff'])
      assert.match(shown, new RegExp(`### mcp__workspace__${name}\\n`))
    assert.doesNotMatch(shown, /mcp__workspace__(edit|write)/, 'no write grant, so no change tool')
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
      assert.match(shown, /reconnect toolscript-mcp or restart the client/)
      // A failed bind never heals: later searches show the same reason, with no note and no double period.
      let again = shown
      for (let i = 0; i < 4; i++) again = await s.search('workspace')
      assert.doesNotMatch(again, /tries again|\.\./)
      // The model reads it from the instructions at initialize, with no reason and no path.
      const instructions = s.client.getInstructions() ?? ''
      assert.match(
        instructions,
        /The built-in workspace server is not available in this session: search_tools says why\./,
      )
      assert.doesNotMatch(instructions, /MCP servers:[^.]*\bworkspace\b/)
      assert.ok(!instructions.includes(base) && !/workspace\.roots/.test(instructions), instructions)
      const r = await s.run('return 1')
      assert.deepEqual(r.isError, false)
    } finally {
      await s.close()
    }
  })
})

// Pull request C: `run_task` alone. A second project, whose task runs a real `node:test` file that passes only when
// `maxAttempts` is 5 (this test changes the file itself: editing is another pull request). The command `node` is
// found on the PATH of the server, and the server holds a variable that no task may see.
describe('the built server with named tasks', () => {
  const taskProject = path.join(base, 'task-project')
  const retry = path.join(taskProject, 'src', 'retry.ts')
  const FAKE = `FAKE-${randomBytes(8).toString('hex')}`
  const nodeTask = (args, extra = {}) => ({ command: 'node', args, ...extra })
  fs.mkdirSync(path.join(taskProject, 'src'), { recursive: true })
  fs.mkdirSync(path.join(taskProject, 'test'), { recursive: true })
  fs.writeFileSync(retry, 'export const config = { maxAttempts: 3 }\n')
  fs.writeFileSync(path.join(taskProject, '.env'), `TOKEN=${MARKER}\n`)
  fs.writeFileSync(
    path.join(taskProject, 'test', 'retry.test.mjs'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport fs from 'node:fs'\n" +
      "test('five attempts', () => assert.match(fs.readFileSync('src/retry.ts', 'utf8'), /maxAttempts: 5/))\n",
  )
  const taskConfig = configWith('tasks.json', {
    mcpServers: {},
    workspace: {
      roots: [
        {
          path: taskProject,
          tasks: {
            'test-retry': nodeTask(['--test']),
            'env-keys': nodeTask(['-p', 'JSON.stringify(Object.keys(process.env))'], { env: { FROM_TASK: 'yes' } }),
            'argv-echo': nodeTask([
              '-p',
              'JSON.stringify(process.argv.slice(1))',
              'a && echo INJECTED',
              '$(id)',
              '%PATH%',
            ]),
            hang: nodeTask([
              '-e',
              "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)",
            ]),
          },
        },
      ],
    },
  })
  const run = (s, name) =>
    s.run(`const r = await call("mcp__workspace__run_task", { task: ${JSON.stringify(name)} })\nreturn r`)
  const waitFor = async (check, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50)))
      if (check()) return true
    return check()
  }
  let session
  before(async () => {
    process.env.FAKE_TOKEN = FAKE
    env.FAKE_TOKEN = FAKE
    session = await connect(taskConfig, taskProject)
  })
  after(() => {
    delete env.FAKE_TOKEN
    delete process.env.FAKE_TOKEN
  })

  test('the task runs the real test: exit code 1 while the value is 3, and 0 after it is 5', async () => {
    const shown = await session.search('workspace run_task')
    assert.match(shown, /### mcp__workspace__run_task\n/)
    assert.match(shown, /Tasks: test-retry, env-keys, argv-echo, hang\./)
    const first = await run(session, 'test-retry')
    assert.equal(first.isError, false, first.text)
    const before = returned(first.text)
    assert.deepEqual([before.exitCode, before.timedOut, before.signal], [1, false, null], 'the real test failed')
    fs.writeFileSync(retry, 'export const config = { maxAttempts: 5 }\n')
    const second = returned((await run(session, 'test-retry')).text)
    assert.deepEqual([second.exitCode, second.timedOut], [0, false], 'the same task passes after the change')
    assert.match(second.stdout, /five attempts/)
    // One prompt for each run, naming the tool, the task names, the root and what a task is.
    assert.equal(session.prompts.length, 2)
    for (const prompt of session.prompts) {
      assert.match(prompt, /- mcp__workspace__run_task\n/)
      assert.match(prompt, /A task runs project code with your rights\. Nothing contains it\./)
      assert.match(prompt, /Tasks: test-retry, env-keys, argv-echo, hang\./)
      assert.ok(prompt.includes(`Workspace root: ${taskProject}`), prompt)
    }
  })

  test('the child gets the arguments as given, the task env, and no variable of the server', async () => {
    const keys = returned((await run(session, 'env-keys')).text)
    const seen = JSON.parse(keys.stdout)
    assert.ok(seen.includes('FROM_TASK') && seen.includes('PATH'), keys.stdout)
    assert.ok(!seen.includes('FAKE_TOKEN'), 'a variable of the server is in the child')
    assert.ok(!keys.stdout.includes(FAKE))
    const argv = returned((await run(session, 'argv-echo')).text)
    assert.deepEqual(JSON.parse(argv.stdout), ['a && echo INJECTED', '$(id)', '%PATH%'])
  })

  test('the run log has the calls, and the secret of .env is in no result, log, prompt or stderr', async () => {
    const log = fs.readFileSync(path.join(home, '.toolscript-mcp', 'runs.jsonl'), 'utf8')
    // The runs of the first describe share this log: the last four are the four runs of this one.
    const records = log
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .slice(-4)
    assert.equal(records.length, 4)
    for (const record of records)
      assert.deepEqual(
        record.calls.map(c => [c.tool, c.decision, c.ok]),
        [['mcp__workspace__run_task', 'ask-approved', true]],
      )
    assert.ok(!log.includes(FAKE) && !log.includes('INJECTED'), 'no task output in the log')
    for (const [name, text] of [
      ['log', log],
      ['stderr', session.transport.stderr],
      ['prompts', session.prompts.join('\n')],
    ])
      assert.ok(!text.includes(MARKER), `the secret is in the ${name}`)
    assert.match(session.transport.stderr, /Workspace: root .*, tasks: test-retry, env-keys, argv-echo, hang/)
  })

  test('a task that is still running when the server closes is ended with its process', async () => {
    const pidFile = path.join(taskProject, 'pid.txt')
    const pending = session.client
      .callTool({
        name: 'run_code',
        arguments: { code: 'return await call("mcp__workspace__run_task", { task: "hang" })' },
      })
      .catch(() => undefined)
    assert.ok(
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== ''),
      'the task started',
    )
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.equal(alive(pid), true)
    const server = await session.close()
    await pending
    assert.equal(alive(server), false, 'the server is gone')
    assert.ok(await waitFor(() => !alive(pid)), 'the task process is gone')
    for (const line of session.transport.lines) assert.doesNotThrow(() => JSON.parse(line))
  })
})

// Pull request B: preview, edit and diff, on a copy of the project with the write grant.
describe('the built server with the write grant', () => {
  const writable = path.join(base, 'writable')
  fs.cpSync(project, writable, { recursive: true })
  const retryFile = path.join(writable, 'src', 'retry.ts')
  const withWrite = configWith('write.json', {
    mcpServers: {},
    workspace: { roots: [{ path: writable, write: true }] },
  })
  const logFile = path.join(home, '.toolscript-mcp', 'runs.jsonl')
  const locksDir = path.join(home, '.toolscript-mcp', 'locks')
  const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

  const FIND = `
const hits = await call("mcp__workspace__search", { query: "maxAttempts: 3", include: ["src/**/*.ts"] })
if (hits.matches.length !== 1) throw Error("Expected one match")
const path = hits.matches[0].path
const file = await call("mcp__workspace__read", { path })
const edits = [{ old: "maxAttempts: 3", new: "maxAttempts: 5" }]
const preview = await call("mcp__workspace__diff", { path, expectedHash: file.hash, edits })
`
  const DIFF_PROGRAM = `${FIND}return { path, preview: preview.diff, newHash: preview.newHash, applied: preview.applied }`
  const EDIT_PROGRAM = `${FIND}const change = await call("mcp__workspace__edit", { path, expectedHash: file.hash, edits })
return { path, preview: preview.diff, diff: change.diff, applied: change.applied, newHash: change.newHash }`

  test('a program with only search, read and diff changes no byte and no modified time, asks no one and takes no lock', async () => {
    const s = await connect(withWrite, writable)
    try {
      const before = stat(retryFile)
      const r = await s.run(DIFF_PROGRAM)
      assert.equal(r.isError, false, r.text)
      const value = returned(r.text)
      assert.equal(value.applied, false)
      assert.ok(value.preview.includes('-  maxAttempts: 3,\r\n+  maxAttempts: 5,\r\n'), value.preview)
      assert.deepEqual(stat(retryFile), before, 'the bytes and the modified time of the file are as they were')
      assert.deepEqual(s.prompts, [])
      assert.equal(fs.existsSync(locksDir), false, 'diff takes no lock')
      assert.match(await s.search('workspace'), /### mcp__workspace__edit\n/)
    } finally {
      await s.close()
    }
  })

  test('a person who declines, and a client that cannot ask, get no change', async () => {
    for (const answer of ['decline', 'none']) {
      const s = await connect(withWrite, writable, answer)
      try {
        const before = stat(retryFile)
        const r = await s.run(EDIT_PROGRAM)
        assert.equal(r.isError, true, answer)
        assert.match(r.text, answer === 'decline' ? /did not approve/ : /cannot ask the person/)
        assert.deepEqual(stat(retryFile), before, answer)
        assert.equal(s.prompts.length, answer === 'decline' ? 1 : 0)
      } finally {
        await s.close()
      }
    }
  })

  test('an approved edit changes only the replaced bytes, and the result, the log and the prompt hold no secret', async () => {
    const s = await connect(withWrite, writable)
    try {
      const before = stat(retryFile)
      const r = await s.run(EDIT_PROGRAM)
      assert.equal(r.isError, false, r.text)
      const value = returned(r.text)
      const expected = Buffer.from(before.bytes.toString('utf8').replace('maxAttempts: 3', 'maxAttempts: 5'))
      assert.notDeepEqual(expected, before.bytes)
      assert.deepEqual(fs.readFileSync(retryFile), expected, 'the old bytes with the one replacement')
      assert.deepEqual([value.path, value.applied, value.newHash], ['src/retry.ts', true, sha(expected)])
      assert.equal(value.preview, value.diff, 'the preview is the diff of the change')
      const lines = value.diff.split('\n')
      assert.equal(lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length, 1)
      assert.equal(lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length, 1)
      // Exactly one prompt: it names the tool and the root.
      assert.equal(s.prompts.length, 1)
      assert.ok(s.prompts[0].includes('mcp__workspace__edit'), s.prompts[0])
      assert.ok(s.prompts[0].includes(writable), s.prompts[0])
      // The log has the four calls, and the changed path with its counts.
      const log = fs.readFileSync(logFile, 'utf8')
      const record = JSON.parse(log.trim().split('\n').at(-1))
      assert.deepEqual(
        record.calls.map(c => [c.tool, c.decision, c.ok]),
        [
          ['mcp__workspace__search', 'allow', true],
          ['mcp__workspace__read', 'allow', true],
          ['mcp__workspace__diff', 'allow', true],
          ['mcp__workspace__edit', 'ask-approved', true],
        ],
      )
      assert.deepEqual(record.changes, [{ path: 'src/retry.ts', added: 1, removed: 1, created: false }])
      for (const [name, text] of [
        ['result', r.text],
        ['log', log],
        ['stderr', s.transport.stderr],
        ['prompt', s.prompts.join('\n')],
      ]) {
        assert.ok(!text.includes(MARKER), `the secret is in the ${name}`)
        if (name === 'log' || name === 'stderr')
          assert.ok(!text.includes('maxAttempts'), `file content is in the ${name}`)
      }
      assert.deepEqual(fs.existsSync(locksDir) ? fs.readdirSync(locksDir) : [], [], 'no lock file stays')
      // The hash of the first read is old now: a second edit with it fails with stale and changes nothing.
      const stale = await s.run(
        `try { await call("mcp__workspace__edit", { path: "src/retry.ts", expectedHash: ${JSON.stringify(sha(before.bytes))}, edits: [{ old: "maxAttempts: 5", new: "maxAttempts: 7" }] }) } catch (e) { return e.message.split(":")[0] }`,
      )
      assert.equal(returned(stale.text), 'stale')
      assert.deepEqual(fs.readFileSync(retryFile), expected)
      const pid = await s.close()
      assert.equal(alive(pid), false, 'no process of the server is left')
      for (const line of s.transport.lines) assert.doesNotThrow(() => JSON.parse(line))
      assert.match(s.transport.stderr, /Workspace: root .*, read and write, confined by (proc|realpath|nofollow-any)/)
    } finally {
      await s.close()
    }
  })
})

// The whole chain in one program, on a disposable project with the write grant and one task: search, read, diff, edit,
// run_task. The task runs the real test, which passes only when `maxAttempts` is 5.
describe('the built server runs the whole chain in one program', () => {
  const chain = path.join(base, 'chain')
  const retryFile = path.join(chain, 'src', 'retry.ts')
  fs.mkdirSync(path.join(chain, 'src'), { recursive: true })
  fs.mkdirSync(path.join(chain, 'test'), { recursive: true })
  fs.writeFileSync(retryFile, files['src/retry.ts'])
  fs.writeFileSync(path.join(chain, '.env'), `TOKEN=${MARKER}\n`)
  fs.writeFileSync(path.join(chain, 'notes.crlf.txt'), 'one\r\ntwo\r\n')
  fs.writeFileSync(
    path.join(chain, 'test', 'retry.test.mjs'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport fs from 'node:fs'\n" +
      "test('five attempts', () => assert.match(fs.readFileSync('src/retry.ts', 'utf8'), /maxAttempts: 5/))\n",
  )
  const chainConfig = configWith('chain.json', {
    mcpServers: {},
    workspace: {
      roots: [{ path: chain, write: true, tasks: { 'test-retry': { command: 'node', args: ['--test'] } } }],
    },
  })
  const logFile = path.join(home, '.toolscript-mcp', 'runs.jsonl')
  const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const PROGRAM = `
const hits = await call("mcp__workspace__search", { query: "maxAttempts: 3", include: ["src/**/*.ts"] })
if (hits.matches.length !== 1) throw Error("Expected one match")
const path = hits.matches[0].path
const file = await call("mcp__workspace__read", { path })
const edits = [{ old: "maxAttempts: 3", new: "maxAttempts: 5" }]
const preview = await call("mcp__workspace__diff", { path, expectedHash: file.hash, edits })
const change = await call("mcp__workspace__edit", { path, expectedHash: file.hash, edits })
const tests = await call("mcp__workspace__run_task", { task: "test-retry" })
return { path, preview: preview.diff, diff: change.diff, applied: change.applied, newHash: change.newHash, exitCode: tests.exitCode }
`

  test('the same task fails before the edit: it runs the real test', async () => {
    const s = await connect(chainConfig, chain)
    try {
      const r = await s.run('return await call("mcp__workspace__run_task", { task: "test-retry" })')
      assert.equal(r.isError, false, r.text)
      const result = returned(r.text)
      assert.deepEqual([result.exitCode, result.timedOut], [1, false])
    } finally {
      await s.close()
    }
  })

  test('search, read, diff, edit and run_task in one program change one thing, ask once, and leak nothing', async () => {
    const s = await connect(chainConfig, chain)
    try {
      const before = stat(retryFile)
      const r = await s.run(PROGRAM)
      assert.equal(r.isError, false, r.text)
      const value = returned(r.text)
      const expected = Buffer.from(before.bytes.toString('utf8').replace('maxAttempts: 3', 'maxAttempts: 5'))
      assert.notDeepEqual(expected, before.bytes)
      assert.deepEqual(fs.readFileSync(retryFile), expected, 'the old bytes with the one replacement')
      assert.deepEqual(
        [value.path, value.applied, value.newHash, value.exitCode],
        ['src/retry.ts', true, sha(expected), 0],
      )
      assert.equal(value.preview, value.diff, 'the preview is the diff of the change')
      const lines = value.diff.split('\n')
      assert.equal(lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length, 1)
      assert.equal(lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length, 1)
      // Exactly one prompt, for the edit and the task together: it names both tools, the root and the task.
      assert.equal(s.prompts.length, 1)
      for (const part of ['mcp__workspace__edit', 'mcp__workspace__run_task', `Workspace root: ${chain}`, 'test-retry'])
        assert.ok(s.prompts[0].includes(part), `${part} is in the prompt: ${s.prompts[0]}`)
      // The run log has the five calls and the changed path, and the secret is in no result, log, prompt or stderr.
      const log = fs.readFileSync(logFile, 'utf8')
      const record = JSON.parse(log.trim().split('\n').at(-1))
      assert.deepEqual(
        record.calls.map(c => [c.tool, c.decision, c.ok]),
        [
          ['mcp__workspace__search', 'allow', true],
          ['mcp__workspace__read', 'allow', true],
          ['mcp__workspace__diff', 'allow', true],
          ['mcp__workspace__edit', 'ask-approved', true],
          ['mcp__workspace__run_task', 'ask-approved', true],
        ],
      )
      assert.deepEqual(record.changes, [{ path: 'src/retry.ts', added: 1, removed: 1, created: false }])
      for (const [name, text] of [
        ['result', r.text],
        ['log', log],
        ['stderr', s.transport.stderr],
        ['prompt', s.prompts.join('\n')],
      ])
        assert.ok(!text.includes(MARKER), `the secret is in the ${name}`)
      const pid = await s.close()
      assert.equal(alive(pid), false, 'no process of the server is left')
      for (const line of s.transport.lines) assert.doesNotThrow(() => JSON.parse(line))
    } finally {
      await s.close()
    }
  })
})

describe('the client roots and the .gitignore (issue #150)', () => {
  const listProgram = 'return (await call("mcp__workspace__list", { depth: 4 })).entries.map(e => e.path)'

  test('a client that declares roots narrows the root, and one that does not keeps the whole root', async () => {
    const narrowed = await connect(withWorkspace, base, 'accept', [pathToFileURL(path.join(project, 'src')).href])
    const plain = await connect(withWorkspace, base)
    try {
      const a = await narrowed.run(listProgram)
      assert.equal(a.isError, false, a.text)
      assert.deepEqual(returned(a.text), ['retry.ts'])
      const b = await narrowed.run(
        'try { await call("mcp__workspace__read", { path: "src/retry.ts" }) } catch (e) { return e.message.split(":")[0] }',
      )
      assert.equal(returned(b.text), 'not-found')
      assert.match(narrowed.transport.stderr, /Workspace: a client root narrowed the root to /)
      const c = await plain.run(listProgram)
      assert.ok(returned(c.text).includes('src/retry.ts'), c.text)
      assert.doesNotMatch(plain.transport.stderr, /narrowed the root/)
    } finally {
      await narrowed.close()
      await plain.close()
    }
  })

  test('the .gitignore of the root hides names from list and search, and read still works', async () => {
    const ignoring = path.join(base, 'ignoring')
    fs.mkdirSync(path.join(ignoring, 'out'), { recursive: true })
    fs.writeFileSync(path.join(ignoring, '.gitignore'), 'out/\r\n*.log')
    fs.writeFileSync(path.join(ignoring, 'out', 'a.txt'), 'needle')
    fs.writeFileSync(path.join(ignoring, 'x.log'), 'needle')
    fs.writeFileSync(path.join(ignoring, 'b.txt'), 'needle')
    const config = configWith('ignoring.json', { mcpServers: {}, workspace: { roots: [{ path: ignoring }] } })
    const s = await connect(config, ignoring)
    try {
      const listed = await s.run(listProgram)
      assert.deepEqual(returned(listed.text), ['.gitignore', 'b.txt'])
      const found = await s.run(
        'return (await call("mcp__workspace__search", { query: "needle" })).matches.map(m => m.path)',
      )
      assert.deepEqual(returned(found.text), ['b.txt'])
      const read = await s.run('return (await call("mcp__workspace__read", { path: "out/a.txt" })).content')
      assert.equal(returned(read.text), 'needle')
    } finally {
      await s.close()
    }
  })
})
