// End-to-end test of lazy start (issue #63, slice 5, decision 028): the built server (dist/host/main.js) with a bridge
// `claude-code` (tests/pid-server.mjs, which ignores EOF) and a temp HOME. The first session has no cache: it connects,
// writes the cache and stops the child after the idle time. The next session starts with no child, lists the same tools
// in a search, starts the child for a call, and after the idle time the child is gone. A call after that works.
// With TOOLSCRIPT_LAZY=0 the child starts at once. Run `npm run build` first.
//
//   node tests/lazy.e2e.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = path.join(ROOT, 'dist', 'host', 'main.js')
const SERVER = path.join(ROOT, 'tests', 'pid-server.mjs')
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-lazy-e2e-')))
const HOME = path.join(dir, 'home')
const TMP = path.join(dir, 'tmp')
fs.mkdirSync(HOME)
fs.mkdirSync(TMP)
const CACHE = path.join(HOME, '.toolscript-mcp', 'learned', 'tools.json')
const IDLE_MS = 1500
const configFile = path.join(dir, 'config.json')
fs.writeFileSync(
  configFile,
  JSON.stringify({
    sandbox: { timeoutSeconds: 20, callTimeoutSeconds: 15 },
    policy: [{ match: 'mcp__claude-code__pid', action: 'allow' }],
    // A wrapper launch that stays the parent of a server that ignores EOF, so the tree must be ended.
    mcpServers: {
      'claude-code':
        process.platform === 'win32'
          ? { command: 'cmd', args: ['/c', 'node', SERVER, '--ignore-eof'] }
          : { command: 'sh', args: ['-c', 'node "$0" --ignore-eof; true', SERVER] },
    },
  }),
)
const envOf = lazy => ({
  ...process.env,
  TOOLSCRIPT_SHARE: '0',
  TOOLSCRIPT_LAZY: lazy ? '1' : '0',
  TOOLSCRIPT_LAZY_IDLE_MS: String(IDLE_MS),
  HOME,
  USERPROFILE: HOME,
  TMPDIR: TMP,
  TEMP: TMP,
  TMP,
})

const hosts = []
const startHost = async lazy => {
  const log = []
  const client = new Client({ name: 'lazy-e2e', version: '0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, '--config', configFile],
    env: envOf(lazy),
    stderr: 'pipe',
  })
  transport.stderr.on('data', chunk => log.push(chunk.toString('utf8')))
  await client.connect(transport)
  const host = {
    client,
    log: () => log.join(''),
    run: async code => {
      const r = await client.callTool({ name: 'run_code', arguments: { code } })
      return { text: r.content[0].text, isError: r.isError === true }
    },
    search: async query => (await client.callTool({ name: 'search_tools', arguments: { query } })).content[0].text,
  }
  hosts.push(host)
  return host
}
after(async () => {
  await Promise.all(hosts.map(h => h.client.close().catch(() => {})))
  await new Promise(r => setTimeout(r, 300))
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (what, check, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    assert.ok(Date.now() < end, `timed out: ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}
const pidOf = async host => {
  const r = await host.run('return "PID=" + String(await call("mcp__claude-code__pid", {}))')
  return Number(/PID=(\d+)/.exec(r.text)?.[1])
}

describe('lazy start', () => {
  let tools

  test('the first session has no cache: it connects, writes the cache, and the child stops after the idle time', async () => {
    const host = await startHost(true)
    tools = await host.search('')
    assert.match(tools, /mcp__claude-code__pid/)
    await until('the cache file', () => fs.existsSync(CACHE))
    await until('the idle stop', () => /claude-code: stopped after \d+ s idle/.test(host.log()))
    assert.match(host.log(), /claude-code: connected, \d+ tools/)
    // The file holds a hash of the launch and the tools, and no argument, path or env text.
    const text = fs.readFileSync(CACHE, 'utf8')
    assert.ok(
      !text.includes(SERVER) && !text.includes('--ignore-eof') && !text.includes(HOME),
      'no launch text on disk',
    )
    await host.client.close()
  })

  test('the next session has no child at the start, lists the same tools, starts one for a call, and it is gone after the idle time', async () => {
    const host = await startHost(true)
    assert.equal(await host.search(''), tools, 'the search lists the same tools as the connected one')
    await new Promise(r => setTimeout(r, 500))
    assert.doesNotMatch(host.log(), /claude-code: (connected|started on first use)/, 'no child before a call')
    const first = await pidOf(host)
    assert.ok(alive(first))
    assert.match(host.log(), /claude-code: started on first use, \d+ ms, \d+ tools/)
    await until('the idle stop', () => /claude-code: stopped after \d+ s idle/.test(host.log()))
    await until('the end of the tree', () => !alive(first))
    const second = await pidOf(host)
    assert.notEqual(second, first)
    assert.ok(alive(second))
    await host.client.close()
    await until('the end of the child at close', () => !alive(second))
  })

  test('with TOOLSCRIPT_LAZY=0 the child starts with the session, as before', async () => {
    const host = await startHost(false)
    await host.search('')
    assert.match(host.log(), /claude-code: connected, \d+ tools/)
    assert.doesNotMatch(host.log(), /started on first use/)
    const pid = await pidOf(host)
    assert.ok(alive(pid))
    await host.client.close()
    // A server that is not lazy also ends with its wrapper's whole tree: the SDK transport would end only the wrapper.
    await until('the end of the server at close', () => !alive(pid))
  })
})
