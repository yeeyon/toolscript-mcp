// End-to-end test of sharing (issue #63): 6 hosts of the built server (dist/host/main.js) start over stdio with one
// config and a temp HOME, and share one child of tests/pid-server.mjs through one broker. Then the same 6 hosts with
// sharing off. Run `npm run build` first.
//
//   node tests/share.e2e.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = path.join(ROOT, 'dist', 'host', 'main.js')
const SERVER = path.join(ROOT, 'tests', 'pid-server.mjs')
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-share-e2e-')))
const HOME = path.join(dir, 'home')
const TMP = path.join(dir, 'tmp')
fs.mkdirSync(HOME)
fs.mkdirSync(TMP)
const BROKER_DIR = path.join(HOME, '.toolscript-mcp', 'broker')
const IDLE_MS = 1500
const SECRET = `secret-${Date.now()}`
const configFile = path.join(dir, 'config.json')
fs.writeFileSync(
  configFile,
  JSON.stringify({
    sandbox: { timeoutSeconds: 20, callTimeoutSeconds: 15 },
    policy: [
      { match: 'mcp__pid__pid', action: 'allow' },
      { match: 'mcp__pid__sleep', action: 'allow' },
      { match: 'mcp__pid__env', action: 'allow' },
      { match: 'mcp__pid__grow', action: 'allow' },
      { match: 'mcp__pid__exit', action: 'allow' },
      // `cwd` matches no rule, so it asks.
    ],
    mcpServers: { pid: { command: process.execPath, args: [SERVER], env: { E2E_SECRET: SECRET }, share: true } },
  }),
)
const envOf = share => ({
  ...process.env,
  TOOLSCRIPT_SHARE: share ? '1' : '0',
  TOOLSCRIPT_BROKER_IDLE_MS: String(IDLE_MS),
  HOME,
  USERPROFILE: HOME,
  TMPDIR: TMP,
  TEMP: TMP,
  TMP,
})

/** One host with a client that can be asked, and a count of what it was asked. */
const startHost = async (share, name) => {
  const asked = []
  const errors = []
  const client = new Client({ name, version: '0' }, { capabilities: { elicitation: {} } })
  client.setRequestHandler(ElicitRequestSchema, req => {
    asked.push(req.params.message)
    return { action: 'accept' }
  })
  client.onerror = err => errors.push(err.message)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, '--config', configFile],
    env: envOf(share),
    stderr: 'ignore',
  })
  await client.connect(transport)
  const run = async (code, options) => {
    const r = await client.callTool({ name: 'run_code', arguments: { code } }, undefined, options)
    return { text: r.content[0].text, isError: r.isError === true }
  }
  const search = async query => (await client.callTool({ name: 'search_tools', arguments: { query } })).content[0].text
  return { client, asked, errors, run, search, name }
}
const startHosts = (share, n = 6) => Promise.all(Array.from({ length: n }, (_, i) => startHost(share, `host-${i}`)))

const hosts = []
const track = async (share, n) => {
  const started = await startHosts(share, n)
  hosts.push(...started)
  return started
}
const closeAll = async list => {
  await Promise.all(list.map(h => h.client.close().catch(() => {})))
  hosts.splice(0, hosts.length, ...hosts.filter(h => !list.includes(h)))
}
after(async () => {
  await closeAll([...hosts])
  const pid = brokerPid()
  if (pid !== undefined && alive(pid)) process.kill(pid)
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
const until = async (what, check, ms = 10_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    assert.ok(Date.now() < end, `timed out: ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}
const brokerLog = () => {
  try {
    return fs.readFileSync(path.join(BROKER_DIR, 'broker.log'), 'utf8')
  } catch {
    return ''
  }
}
const brokerPids = () => [...brokerLog().matchAll(/start pid (\d+)/g)].map(m => Number(m[1]))
const brokerPid = () => brokerPids().at(-1)
const pidOf = async host => {
  const r = await host.run('return "PID=" + String(await call("mcp__pid__pid", {}))')
  return Number(/PID=(\d+)/.exec(r.text)?.[1])
}

describe('sharing on', () => {
  let six
  test('6 hosts start at once: one broker, and one server pid in all 6 results', async () => {
    six = await track(true)
    for (const h of six)
      assert.deepEqual(
        (await h.client.listTools()).tools.map(t => t.name),
        ['run_code', 'search_tools'],
      )
    const pids = await Promise.all(six.map(pidOf))
    assert.equal(new Set(pids).size, 1, `pids: ${pids}`)
    assert.ok(pids[0] > 0)
    assert.equal(brokerPids().length, 1, 'one broker')
    assert.ok(!brokerLog().includes(SECRET))
  })

  test('each result reaches only its caller under parallel calls with the same ids', async () => {
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(
        six.map((h, i) => h.run(`return "SLEPT=" + String(await call("mcp__pid__sleep", { ms: ${50 + i * 20} }))`)),
      )
      results.forEach((r, i) => assert.match(r.text, new RegExp(`SLEPT=slept ${50 + i * 20}\\b`)))
    }
  })

  test('the env of the entry reaches the shared child, and the broker env does not', async () => {
    const r = await six[0].run('return "V=" + String(await call("mcp__pid__env", { name: "E2E_SECRET" }))')
    assert.match(r.text, new RegExp(`V=${SECRET}`))
  })

  test('a recall handle and a saved file of A fail in B', async () => {
    const [a, b] = six
    // A keeps 45 results, more than B has: its last handle means nothing in B.
    const loop = 'let last; for (let i = 0; i < 45; i++) last = await call("mcp__pid__sleep", { ms: 1 }); return last'
    assert.match((await a.run(loop)).text, /slept 1/)
    assert.match((await a.run('return await recall(45)')).text, /slept 1/, 'A recalls its own result')
    const recalled = await b.run('try { return await recall(45) } catch (e) { return "CAUGHT " + e.message }')
    assert.match(recalled.text, /CAUGHT|error|not/i)
    assert.ok(!recalled.text.includes('slept'), `B got a result of A: ${recalled.text}`)
    const saved = await a.run('return "FILE=" + await saveFile("a.txt", "from A")')
    const file = /FILE=(.+)/.exec(saved.text)?.[1]?.trim()
    assert.ok(file, saved.text)
    const read = await b.run(
      `try { return await readFile(${JSON.stringify(file)}) } catch (e) { return "CAUGHT " + e.message }`,
    )
    assert.match(read.text, /CAUGHT|not a file from saveFile/)
    assert.ok(!read.text.includes('from A'))
  })

  test('an ask tool accepted in A still asks in B, and the question reaches the caller only', async () => {
    const [a, b, c] = six
    const code = 'return "CWD=" + String(await call("mcp__pid__cwd", {}))'
    const [before, ...rest] = [a, b, c].map(h => h.asked.length)
    assert.deepEqual([before, ...rest], [0, 0, 0])
    assert.match((await a.run(code)).text, /CWD=/)
    assert.deepEqual(
      [a, b, c].map(h => h.asked.length),
      [1, 0, 0],
    )
    assert.match((await b.run(code)).text, /CWD=/)
    assert.deepEqual(
      [a, b, c].map(h => h.asked.length),
      [1, 1, 0],
    )
  })

  test('tools/list_changed reaches all 6 hosts', async () => {
    const r = await six[0].run('return String(await call("mcp__pid__grow", {}))')
    assert.match(r.text, /grown/)
    for (const h of six)
      await until(`${h.name} sees the new tool`, async () => (await h.search('extra')).includes('mcp__pid__extra'))
  })

  test("A's cancel leaves B's call alone", async () => {
    const [a, b] = six
    const controller = new AbortController()
    const slowA = a
      .run('return await call("mcp__pid__sleep", { ms: 8000 })', { signal: controller.signal })
      .catch(e => e)
    const fastB = b.run('return "SLEPT=" + String(await call("mcp__pid__sleep", { ms: 1500 }))')
    await new Promise(r => setTimeout(r, 400))
    controller.abort()
    assert.ok((await slowA) instanceof Error)
    assert.match((await fastB).text, /SLEPT=slept 1500/)
    assert.match(
      (await a.run('return "SLEPT=" + String(await call("mcp__pid__sleep", { ms: 10 }))')).text,
      /SLEPT=slept 10/,
    )
  })

  test('a broker killed during the call of A: A gets a reason, and the next run works', async () => {
    const [a, b] = six
    const before = await pidOf(b)
    const slow = a.run('return await call("mcp__pid__sleep", { ms: 8000 })')
    await new Promise(r => setTimeout(r, 500))
    process.kill(brokerPid())
    const failed = await slow
    assert.match(failed.text, /connection closed|ended|not connected|broker/i, failed.text)
    // The link connects again on the next use, and a new broker starts.
    let after
    for (let i = 0; i < 20 && after === undefined; i++) {
      const next = await a.run('return "PID=" + String(await call("mcp__pid__pid", {}))')
      after = /PID=(\d+)/.exec(next.text)?.[1]
      if (after === undefined) await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(after, 'the next run works')
    assert.notEqual(Number(after), before)
    assert.equal(brokerPids().length, 2)
  })

  test('stdout held only JSON-RPC, and no exchange dir is left', async () => {
    for (const h of six) assert.deepEqual(h.errors, [], h.name)
    const stale = () => fs.readdirSync(TMP).filter(f => f.startsWith('toolscript-'))
    await until('the exchange dirs are gone', () => stale().length === 0, 5000)
  })

  test('after close and the idle time: no broker, no child, no socket file', async () => {
    const child = await pidOf(six[0])
    const broker = brokerPid()
    // The socket name of endpointOf (src/core/broker.ts), computed here: Node 22.13 runs no .ts import of a .mjs file.
    // It sits in the broker folder or, when that path is too long, in the short folder. Windows uses a named pipe.
    const id = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'dist', 'host', 'broker.js')))
      .digest('hex')
    const mac = crypto
      .createHmac('sha256', fs.readFileSync(path.join(BROKER_DIR, 'key')))
      .update(`toolscript-mcp build ${id}`)
      .digest('hex')
    const sockets =
      process.platform === 'win32'
        ? []
        : [BROKER_DIR, `/tmp/tsm-${process.getuid()}`].map(f => path.join(f, `tsm-${mac.slice(0, 12)}.sock`))
    if (sockets.length > 0)
      assert.ok(
        sockets.some(s => fs.existsSync(s)),
        'the live broker has its socket file',
      )
    await closeAll(six)
    await until('the child ends', () => !alive(child), 10_000)
    await until('the broker ends', () => !alive(broker), 10_000)
    assert.ok(!sockets.some(s => fs.existsSync(s)), 'no socket file')
  })
})

describe('sharing off', () => {
  test('6 hosts have 6 children, and no broker starts', async () => {
    const before = brokerPids().length
    const six = await track(false)
    const pids = await Promise.all(six.map(pidOf))
    assert.equal(new Set(pids).size, 6, `pids: ${pids}`)
    assert.equal(brokerPids().length, before, 'no new broker')
    await closeAll(six)
  })

  test('with sharing off from the start, no broker folder is made', async () => {
    const fresh = fs.mkdtempSync(path.join(dir, 'fresh-'))
    const env = { ...envOf(false), HOME: fresh, USERPROFILE: fresh }
    const client = new Client({ name: 'off', version: '0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, '--config', configFile],
        env,
        stderr: 'ignore',
      }),
    )
    const r = await client.callTool({
      name: 'run_code',
      arguments: { code: 'return String(await call("mcp__pid__pid", {}))' },
    })
    assert.match(r.content[0].text, /\d+/)
    await client.close()
    assert.ok(!fs.existsSync(path.join(fresh, '.toolscript-mcp', 'broker')), 'no broker folder')
  })
})

describe('the stderr of a shared server', () => {
  const MARKER = 'E2E-STDERR-MARKER'
  const markerConfig = path.join(dir, 'marker.json')
  fs.writeFileSync(
    markerConfig,
    JSON.stringify({
      policy: [{ match: 'mcp__pid__pid', action: 'allow' }],
      mcpServers: { pid: { command: process.execPath, args: [SERVER, `--marker=${MARKER}`], share: true } },
    }),
  )
  /** A host with sharing on or off, whose own stderr (the log of the client) is kept. */
  const hostWithLog = async share => {
    const log = []
    const client = new Client({ name: 'log', version: '0' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, '--config', markerConfig],
      env: envOf(share),
      stderr: 'pipe',
    })
    transport.stderr.on('data', d => log.push(String(d)))
    await client.connect(transport)
    const call = async () =>
      (
        await client.callTool({
          name: 'run_code',
          arguments: { code: 'return String(await call("mcp__pid__pid", {}))' },
        })
      ).content[0].text
    return { client, call, log: () => log.join('') }
  }

  test('two hosts with sharing on have the marker of each call in their stderr, and none in a result', async () => {
    const [a, b] = await Promise.all([hostWithLog(true), hostWithLog(true)])
    const results = [await a.call(), await b.call()]
    await until('both logs hold both calls', () =>
      [a, b].every(h => (h.log().match(new RegExp(`${MARKER} call pid`, 'g')) ?? []).length >= 2),
    )
    for (const text of results) assert.ok(!text.includes(MARKER))
    assert.ok(!brokerLog().includes(MARKER), 'the broker log holds none')
    await Promise.all([a.client.close(), b.client.close()])
  })

  test('with sharing off the stderr of the direct child is in the log, as with sharing on', async () => {
    const host = await hostWithLog(false)
    await host.call()
    await until('the marker', () => host.log().includes(`${MARKER} call pid`))
    await host.client.close()
  })
})
