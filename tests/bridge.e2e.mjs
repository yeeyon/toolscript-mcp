// One program through the real Claude Code bridge (issue #94): the built server, with
// "claude mcp serve" as its only downstream server, over stdio. It is not part of npm test: it
// needs the claude binary on PATH, and it prints one line and exits 0 when there is none.
// Run npm run build first.
//
//   node tests/bridge.e2e.mjs
//
// Case 1: one run_code program finds a function with Grep, reads it with Read, changes it with Edit
// and runs node --test through the shell tool of the bridge. The temp config has allow rules that
// start with mcp__claude-code__ for those four tools only, and nothing broader.
// Case 2: the command of the bridge does not exist. The server must start, search_tools must
// answer, and a call of a bridge tool must fail with a reason that names the key.
// Every config, HOME and project is a new folder under the temp folder. Nothing reads the real
// home of the person who runs it. The binary is found by a PATH search for claude.exe (Windows) or
// claude, never the claude.ps1 shim.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const KEY = 'claude-code'
const WIN = process.platform === 'win32'

const findClaude = () => {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(d, WIN ? 'claude.exe' : 'claude')
    if (d && fs.existsSync(file)) return file
  }
  return undefined
}
const claude = findClaude()
if (!claude) {
  console.log('skipped: no claude binary on PATH')
  process.exit(0)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-bridge-'))
const HOME = path.join(dir, 'home')
const PROJECT = path.join(dir, 'project')
fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true })
fs.mkdirSync(HOME)
const SOURCE = path.join(PROJECT, 'src', 'calc.mjs')
const BROKEN = 'export function add(a, b) {\n  return a - b\n}\n'
fs.writeFileSync(SOURCE, BROKEN)
fs.writeFileSync(
  path.join(PROJECT, 'src', 'calc.test.mjs'),
  "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add } from './calc.mjs'\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5)\n})\n",
)
const SHELL = WIN ? 'PowerShell' : 'Bash'
const TOOLS = ['Grep', 'Read', 'Edit', SHELL]
const forward = p => p.replaceAll('\\', '/')

const start = async (name, entry, policy) => {
  const config = path.join(dir, name + '.json')
  fs.writeFileSync(config, JSON.stringify({ share: false, mcpServers: { [KEY]: entry }, policy }))
  const home = path.join(dir, name + '-home')
  fs.mkdirSync(home, { recursive: true })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, '--config', config],
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'bridge-e2e', version: '1' }, { capabilities: {} })
  await client.connect(transport)
  return { client, home, close: () => client.close() }
}
const textOf = r => r.content.map(b => b.text ?? '').join('')
const runLines = home =>
  fs
    .readFileSync(path.join(home, '.toolscript-mcp', 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))

try {
  // Case 1: the real bridge.
  const real = await start(
    'real',
    {
      command: claude,
      args: ['mcp', 'serve'],
      cwd: PROJECT,
      env: { HOME: path.join(dir, 'claude-home'), USERPROFILE: path.join(dir, 'claude-home') },
    },
    TOOLS.map(t => ({ match: 'mcp__' + KEY + '__' + t, action: 'allow' })),
  )
  try {
    const listed = await real.client.callTool({ name: 'search_tools', arguments: { query: '', limit: 100 } })
    const names = [...textOf(listed).matchAll(/^### (mcp__claude-code__\S+)$/gm)].map(m => m[1])
    console.log('claude mcp serve lists ' + names.length + ' tools: ' + names.join(', '))
    assert.ok(names.includes('mcp__' + KEY + '__' + SHELL), 'the bridge lists ' + SHELL)
    const q = JSON.stringify
    const program = [
      'const g = await call("mcp__claude-code__Grep", { pattern: "function add", path: ' +
        q(forward(PROJECT)) +
        ', output_mode: "files_with_matches" })',
      'const r = await call("mcp__claude-code__Read", { file_path: ' + q(forward(SOURCE)) + ' })',
      'const e = await call("mcp__claude-code__Edit", { file_path: ' +
        q(forward(SOURCE)) +
        ', old_string: "return a - b", new_string: "return a + b" })',
      'const t = await call("mcp__claude-code__' + SHELL + '", { command: "node --test" })',
      'const out = JSON.stringify(t)',
      'if (!/pass 1/.test(out) || !/fail 0/.test(out)) throw new Error("the test did not pass: " + out.slice(0, 800))',
      'return { grep: JSON.stringify(g).includes("calc.mjs"), pass: /pass 1/.test(out), fail0: /fail 0/.test(out) }',
    ].join('\n')
    const result = await real.client.callTool({ name: 'run_code', arguments: { code: program } })
    const text = textOf(result)
    console.log('run_code result:\n' + text.split('\n\n---')[0])
    assert.notEqual(result.isError, true, text)
    assert.match(text, /"grep": ?true/)
    assert.match(text, /"pass": ?true/)
    assert.match(text, /"fail0": ?true/)
    assert.equal(
      fs.readFileSync(SOURCE, 'utf8'),
      BROKEN.replace('a - b', 'a + b'),
      'the file on disk holds the new text',
    )
    const last = runLines(real.home).at(-1)
    assert.deepEqual(
      last.calls.map(c => c.tool),
      TOOLS.map(t => 'mcp__' + KEY + '__' + t),
      'the run log lists the four tools in order',
    )
    assert.ok(
      last.calls.every(c => c.ok === true),
      JSON.stringify(last.calls),
    )
    console.log(
      'case 1 passed: run log tools ' +
        last.calls.map(c => c.tool.replace('mcp__claude-code__', '') + ':' + c.ok).join(', '),
    )
  } finally {
    await real.close()
  }

  // Case 2: the command does not exist.
  const missing = await start('missing', { command: 'claude-does-not-exist-' + process.pid, args: ['mcp', 'serve'] }, [
    { match: 'mcp__' + KEY + '__Read', action: 'allow' },
  ])
  try {
    const found = await missing.client.callTool({ name: 'search_tools', arguments: { query: 'Read file' } })
    assert.notEqual(found.isError, true, textOf(found))
    console.log('missing binary, search_tools: ' + textOf(found))
    const result = await missing.client.callTool({
      name: 'run_code',
      arguments: {
        code: 'try { return await call("mcp__claude-code__Read", { file_path: "x" }) } catch (e) { return "THROWN: " + e.message }',
      },
    })
    const text = textOf(result)
    console.log('missing binary, call: ' + text.split('\n\n---')[0])
    assert.match(text, /the MCP server "claude-code" is not connected/, 'the reason names the server key')
    console.log('case 2 passed')
  } finally {
    await missing.close()
  }
  console.log('ok')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
