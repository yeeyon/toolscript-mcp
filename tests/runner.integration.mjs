// Integration test for the real sandbox, under Node, on Linux, macOS and
// Windows. Starts runtime/runner.mjs with the host launcher (src/host/launch.ts)
// and answers its calls by writing reply files.
//
//   node tests/runner.integration.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WINDOWS = process.platform === 'win32'

// MARK is a copy of the one in the runner and src/core/protocol.ts. The first case fails when a copy differs.
const MARK = '\u0001cm '

// The host gets this variable, and the sandbox process must not see it.
const SECRET = `fake-${randomUUID()}`
process.env.TOOLSCRIPT_TEST_SECRET = SECRET

// The host reads stdout with takeMessages and starts the runner with launch.
// Node 22.13 runs this file with no type stripping, so ask for it once and
// load the real modules.
let takeMessages, launch, makeExchangeDir, removeExchangeDir, LAYERS, KILL_GRACE_MS, RUNNER
try {
  ;({ takeMessages } = await import('../src/core/protocol.ts'))
  ;({ launch, makeExchangeDir, removeExchangeDir, LAYERS, KILL_GRACE_MS, RUNNER } = await import(
    '../src/host/launch.ts'
  ))
} catch (err) {
  if (process.env.TOOLSCRIPT_STRIP === '1' || err?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err
  const again = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, TOOLSCRIPT_STRIP: '1' },
  })
  process.exit(again.status ?? 1)
}

const echo = m =>
  m.t === 'resources'
    ? { ok: true, value: [{ uri: 'file:///a.md', server: m.server ?? 'any' }] }
    : m.t === 'resource'
      ? { ok: true, value: [{ uri: m.uri, text: `text of ${m.server} ${m.uri}` }] }
      : m.t === 'save'
        ? { ok: true, value: { saved: m.name, data: m.data } }
        : m.t === 'read'
          ? { ok: true, value: `text of ${m.path}` }
          : m.t === 'recall'
            ? m.ref === 4
              ? { ok: true, value: { recalled: m.ref } }
              : { ok: false, error: `no result #${m.ref}` }
            : m.tool.endsWith('fail')
              ? { ok: false, error: 'boom' }
              : { ok: true, value: { tool: m.tool, args: m.args } }

// `runner` replaces the runner, to test what the launch allows the process.
// `node` and `env` are the launch options of the same name.
// An `answer` that returns undefined writes no reply: a call that never finishes.
const run = async (
  code,
  { timeoutMs = 5000, answer = echo, runner = RUNNER, env, node = process.execPath, lib } = {},
) => {
  const xdir = await makeExchangeDir()
  const started = performance.now()
  const { child, ended } = launch({
    node,
    runner,
    xdir,
    timeoutMs,
    input: JSON.stringify({ code, timeoutMs, lib }),
    env,
  })
  let buffer = ''
  let stdout = ''
  let stderr = ''
  let calls = 0
  let outcome
  let closed = false
  child.stderr.on('data', d => (stderr += d))
  child.stdout.on('data', d => {
    stdout += d
    buffer += d
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (!line.startsWith(MARK)) continue
      const m = JSON.parse(line.slice(MARK.length))
      if (m.t === 'done' || m.t === 'error') outcome = m
      else {
        calls++
        const reply = answer(m)
        if (reply !== undefined)
          setTimeout(() => closed || fs.writeFileSync(path.join(xdir, `r${m.id}.json`), JSON.stringify(reply)), 10)
      }
    }
  })
  const ending = await ended
  closed = true
  const ms = performance.now() - started
  await removeExchangeDir(xdir)
  return { ending, ms, calls, outcome, stderr, stdout }
}

// Writes a script that replaces the runner to a temp dir, and gives f its path.
const withScript = async (source, f) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-script-'))
  try {
    fs.writeFileSync(path.join(dir, 'script.mjs'), source)
    return await f(path.join(dir, 'script.mjs'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Runs in place of the runner, with the same launch: it tries what a program
// that got out of the vm context could do, and returns each error code.
const PROBE = String.raw`
import fs from 'node:fs'
import net from 'node:net'
import cp from 'node:child_process'
import { Worker } from 'node:worker_threads'
const xdir = process.argv[2]
const { port, other } = JSON.parse(JSON.parse(fs.readFileSync(0, 'utf8')).code)
const attempt = async f => { try { await f(); return 'allowed' } catch (e) { return e.code ?? e.message } }
const result = {
  write: await attempt(() => fs.writeFileSync(xdir + '/probe.txt', 'x')),
  read: await attempt(() => fs.readFileSync(other)),
  spawn: await attempt(() => cp.execFileSync(process.execPath, ['-e', '1'])),
  worker: await attempt(() => new Worker('1', { eval: true }).terminate()),
  connect: await attempt(() => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve() })
    socket.on('error', reject)
  })),
  env: { ...process.env },
}
process.stdout.write('\u0001cm ' + JSON.stringify({ t: 'done', value: JSON.stringify(result), logs: [] }) + '\n')
`

const runProbe = async () => {
  const server = net.createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const input = JSON.stringify({ port: server.address().port, other: path.join(ROOT, 'package.json') })
    const r = await withScript(PROBE, runner => run(input, { runner }))
    assert.equal(r.outcome?.t, 'done', `the probe did not finish: ${JSON.stringify(r.ending)} ${r.stderr}`)
    return JSON.parse(r.outcome.value)
  } finally {
    server.close()
  }
}

// One launch answers every probe case.
let probed
const probe = () => (probed ??= runProbe())

// One busy loop answers the cases about how it ends.
let spun
const busyLoop = () => (spun ??= run('while (true) {}', { timeoutMs: 1000 }))

// LAYERS (src/host/launch.ts) says which network block this OS has. On Linux
// it needs a kernel that lets unshare make a user and network namespace. CI
// sets EXPECT_NETWORK_BLOCK, so a runner without the block fails.
const HAS_UNSHARE = (() => {
  try {
    execFileSync('unshare', ['-rn', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const NETWORK_BLOCK =
  LAYERS.network === 'sandbox-exec'
    ? { name: 'sandbox-exec', code: 'EPERM' }
    : LAYERS.network !== 'none' && HAS_UNSHARE
      ? { name: 'unshare -rn', code: 'ENETUNREACH' }
      : undefined
const NO_BLOCK_REASON =
  LAYERS.network === 'none' ? 'Windows has no network block' : 'unshare -rn does not work on this kernel'

/** A file of the repo, as text. */
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')
const value = r => (r.outcome?.t === 'done' ? JSON.parse(r.outcome.value) : undefined)
const failure = r => (r.outcome?.t === 'error' ? r.outcome.message : undefined)

// A return of n characters must come back as one whole done line. takeMessages
// keeps a line only when it ends in a newline, the same rule as the host.
const wholeThroughPipe = async n => {
  const r = await run(`return ${JSON.stringify('x'.repeat(n))}`, { timeoutMs: 15_000 })
  const { messages, rest } = takeMessages(r.stdout)
  const done = messages.filter(m => m.t === 'done')
  assert.equal(
    done.length,
    1,
    `${JSON.stringify(r.ending)} stdout ${r.stdout.length} rest ${rest.length} newline ${r.stdout.endsWith('\n')}`,
  )
  assert.equal(JSON.parse(done[0].value).length, n)
}

// Cases that test the Linux and macOS launch script. Windows starts Node with no script.
const skipped = []
const posixOnly = (name, fn) => {
  if (!WINDOWS) return { [name]: fn }
  skipped.push(`${name}: Windows starts Node with no launch script`)
  return {}
}

const cases = {
  'the copies of MARK match': () => {
    assert.equal(MARK, '\u0001cm ')
    for (const file of ['runtime/runner.mjs', 'src/core/protocol.ts'])
      assert.match(read(file), /const MARK = '\\u0001cm '/, `MARK differs in ${file}`)
  },

  // The host reads only the kinds in RUNNER_FIELDS (src/core/protocol.ts) and drops any other.
  'the runner sends the kinds the host reads': () => {
    const table = read('src/core/protocol.ts').match(/const RUNNER_FIELDS = \{\n([\s\S]*?)\n\}/)
    assert.ok(table, 'RUNNER_FIELDS not found in src/core/protocol.ts')
    const known = table[1].split('\n').map(l => l.match(/^\s+(\w+):/)?.[1])
    const sent = [...read('runtime/runner.mjs').matchAll(/\bt: '(\w+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(sent)].sort(), [...known].sort())
  },

  'returns a value': async () => assert.equal(value(await run('return 1 + 1')), 2),

  'make it fail: a 200000-char return arrives whole through a pipe': async () => wholeThroughPipe(200_000),

  'make it fail: a 1000000-char return arrives whole through a pipe': async () => wholeThroughPipe(1_000_000),

  'parallel calls and console': async () => {
    const r = await run(`
      const [a, b] = await Promise.all([call("mcp__s__t", { n: 1 }), tools["a-b"].c({ n: 2 })])
      console.log("got", a.args.n + b.args.n)
      return [a.tool, b.tool]`)
    assert.deepEqual(value(r), ['mcp__s__t', 'mcp__a-b__c'])
    assert.deepEqual(r.outcome.logs, ['got 3'])
    assert.equal(r.calls, 2)
  },

  'recall reads a kept result through the same bridge': async () => {
    const r = await run(`
      const kept = await recall(4)
      const gone = await recall(5).catch(e => e.message)
      const bad = await Promise.resolve().then(() => recall("4")).catch(e => e.name)
      return [kept, gone, bad]`)
    assert.deepEqual(value(r), [{ recalled: 4 }, 'no result #5', 'TypeError'])
  },

  'sleep waits, so a program can poll': async () => {
    const r = await run(`
      const t = Date.now()
      let polls = 0
      while ((await call("mcp__s__t", { n: polls })).args.n < 2) { polls++; await sleep(100) }
      return [polls, Date.now() - t >= 200]`)
    assert.deepEqual(value(r), [2, true])
    assert.equal(r.calls, 3)
  },

  'sleep refuses a wrong argument': async () => {
    const r = await run(`
      const bad = []
      for (const ms of ["100", -1, NaN, undefined]) bad.push(await Promise.resolve().then(() => sleep(ms)).catch(e => e.name))
      return bad`)
    assert.deepEqual(value(r), Array(4).fill('TypeError'))
  },

  'sleep cannot outlast the wall-clock limit': async () =>
    assert.match(failure(await run('await sleep(Infinity)', { timeoutMs: 500 })), /timeout/),

  'saveFile and readFile go through the host': async () => {
    const r = await run(`
      const saved = await saveFile("rows.csv", [{ a: 1 }])
      const text = await readFile("ids.txt")
      const bad = []
      for (const f of [() => saveFile(1, "x"), () => saveFile("a.json", undefined), () => readFile({})]) bad.push(await Promise.resolve().then(f).catch(e => e.name))
      return [saved, text, bad]`)
    assert.deepEqual(value(r), [
      { saved: 'rows.csv', data: [{ a: 1 }] },
      'text of ids.txt',
      ['TypeError', 'TypeError', 'TypeError'],
    ])
  },

  'resources and readResource go through the host': async () => {
    const r = await run(`
      const [list, all, contents] = await Promise.all([resources("docs"), resources(), readResource("docs", "file:///a.md")])
      const bad = []
      for (const f of [() => resources(1), () => readResource("docs")]) bad.push(await Promise.resolve().then(f).catch(e => e.name))
      return [list[0].server, all[0].server, contents[0].text, bad]`)
    assert.deepEqual(value(r), ['docs', 'any', 'text of docs file:///a.md', ['TypeError', 'TypeError']])
  },

  'lib runs the saved functions it gets, and nothing else': async () => {
    const lib = {
      twice: 'async ({ n }) => { const r = await call("mcp__s__t", { n }); return r.args.n * 2 }',
      viaOther: 'async ({ n }) => (await lib.twice({ n })) + 1',
      broken: 'async () => {',
      'bad name': 'async () => 1',
    }
    const r = await run(
      `
      const missing = await Promise.resolve().then(() => lib.nope()).catch(e => e.message)
      const broken = await lib.broken().catch(e => e.name + ": " + e.message)
      try { lib.twice = 1 } catch {}
      const written = typeof lib.twice === "function" ? "refused" : "written"
      const escape = await Promise.resolve().then(() => lib.twice.constructor("return process")()).catch(e => e.name)
      return [await lib.twice({ n: 2 }), await lib.viaOther({ n: 3 }), missing, broken.startsWith("SyntaxError: lib.broken does not compile"), lib.broken.toString(), lib.twice.toString() === ${JSON.stringify(lib.twice)}, written, escape, typeof globalThis.__lib, Object.keys(lib)]`,
      { lib },
    )
    assert.deepEqual(value(r), [
      4,
      7,
      'lib.nope is not a saved function: search_tools lists them',
      true,
      'async () => {',
      true,
      'refused',
      'EvalError',
      'undefined',
      ['twice', 'viaOther', 'broken'],
    ])
  },

  'an error in a saved function shows its frame': async () => {
    const r = await run('return await lib.boom()', { lib: { boom: 'async () => {\n  null.x\n}' } })
    assert.match(failure(r), /TypeError[\s\S]*lib\/boom\.js:2/)
  },

  'failed call throws': async () =>
    assert.equal(value(await run('try { await call("mcp__s__fail") } catch (e) { return e.message }')), 'boom'),

  'no host globals': async () =>
    assert.deepEqual(
      value(await run('return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof __deliver]')),
      Array(5).fill('undefined'),
    ),

  'no escape through constructors': async () => {
    for (const code of [
      'return globalThis.constructor.constructor("return process")().pid',
      'return this.constructor.constructor("return process")().pid',
      'return call.constructor("return 1")()',
      'return recall.constructor("return 1")()',
      'return sleep.constructor("return 1")()',
      'return saveFile.constructor("return 1")()',
      'return readFile.constructor("return 1")()',
      'return resources.constructor("return 1")()',
      'try { await call("mcp__s__fail") } catch (e) { return e.constructor.constructor("return process")().pid }',
      'return (await call("mcp__s__t")).constructor.constructor("return process")().pid',
    ])
      assert.match(failure(await run(code)) ?? 'escaped', /EvalError/, code)
  },

  'wall-clock timeout': async () =>
    assert.match(failure(await run('await new Promise(() => {})', { timeoutMs: 500 })), /timeout/),

  'a call with no reply ends at the time limit, and try/catch does not hide it': async () => {
    const answer = m => (m.tool === 'mcp__s__hang' ? undefined : echo(m))
    const code = 'await call("mcp__s__a"); try { await call("mcp__s__hang") } catch { return "caught" }'
    const r = await run(code, { timeoutMs: 500, answer })
    assert.equal(failure(r), 'timeout after 500 ms')
    assert.equal(r.calls, 2)
  },

  // A busy loop blocks the runner's own timer, so only a layer outside the process stops it.
  'a busy loop ends within the time limit': async () => {
    const r = await busyLoop()
    assert.equal(r.outcome, undefined, 'the busy loop sent a result')
    assert.notEqual(r.ending.kind, 'failed')
    assert.ok(r.ms < 1000 + KILL_GRACE_MS + 2000, `the busy loop ran ${Math.round(r.ms)} ms`)
  },

  ...(LAYERS.cpuLimit
    ? {
        'the CPU limit stops a busy loop (ulimit -t)': async () => {
          const { ending } = await busyLoop()
          assert.ok(ending.kind === 'exit' && ['SIGXCPU', 'SIGKILL'].includes(ending.signal), JSON.stringify(ending))
        },
      }
    : {
        'absent: no CPU limit here, so the host kill timer stops a busy loop': async () =>
          assert.deepEqual((await busyLoop()).ending, { kind: 'timeout', limitMs: 1000 }),
      }),

  'the host kill timer stops a process that ignores its own timer': async () => {
    const r = await withScript('setInterval(() => {}, 1000)', runner => run('', { runner, timeoutMs: 500 }))
    assert.deepEqual(r.ending, { kind: 'timeout', limitMs: 500 })
    assert.ok(
      r.ms >= 500 + KILL_GRACE_MS - 50 && r.ms < 500 + KILL_GRACE_MS + 2000,
      `ended after ${Math.round(r.ms)} ms`,
    )
  },

  'syntax error': async () => assert.match(failure(await run('return )(')), /SyntaxError/),

  'the process cannot write, read other files, or start processes': async () => {
    const r = await probe()
    assert.deepEqual(
      { write: r.write, read: r.read, spawn: r.spawn, worker: r.worker },
      {
        write: 'ERR_ACCESS_DENIED',
        read: 'ERR_ACCESS_DENIED',
        spawn: 'ERR_ACCESS_DENIED',
        worker: 'ERR_ACCESS_DENIED',
      },
    )
  },

  'the process cannot see the secrets of the host environment': async () => {
    const { env } = await probe()
    assert.ok(!JSON.stringify(env).includes(SECRET), 'the secret of the host reached the process')
    // macOS adds __CF_USER_TEXT_ENCODING (the uid and a text encoding) to each process at start.
    if (LAYERS.env === 'none')
      assert.deepEqual(
        Object.keys(env).filter(name => name !== '__CF_USER_TEXT_ENCODING'),
        [],
      )
    // Windows: the variables that libuv adds are there, with no value.
    else
      assert.deepEqual(
        Object.entries(env).filter(([, text]) => text !== ''),
        [['SYSTEMROOT', process.env.SYSTEMROOT]],
      )
  },

  ...(NETWORK_BLOCK
    ? {
        [`the process has no network (${NETWORK_BLOCK.name})`]: async () =>
          assert.equal((await probe()).connect, NETWORK_BLOCK.code),
      }
    : {
        [`absent: ${NO_BLOCK_REASON}, so the process can connect`]: async () => {
          assert.ok(!process.env.EXPECT_NETWORK_BLOCK, `EXPECT_NETWORK_BLOCK is set, but ${NO_BLOCK_REASON}`)
          const { connect } = await probe()
          assert.equal(connect, 'allowed', 'a network block works here: update LAYERS, README.md and SECURITY.md')
        },
      }),

  // Where unshare cannot make the namespaces (Ubuntu 24.04 by default), the
  // launch goes on without the network block.
  ...posixOnly('a failing unshare does not stop the program', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-path-'))
    try {
      fs.writeFileSync(path.join(dir, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const r = await run('return 1 + 1', { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
      assert.equal(value(r), 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }),

  ...posixOnly('the launch finds node on PATH, also behind a version-manager shim', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-shim-'))
    try {
      // Like an asdf shim: it finds the real node only through the environment.
      fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nexec "$REAL_NODE" "$@"\n', { mode: 0o755 })
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, REAL_NODE: process.execPath }
      assert.equal(value(await run('return 1 + 1', { node: 'node', env })), 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }),

  'the launch says when it cannot find node': async () => {
    const r = await run('return 1', { node: path.join(os.tmpdir(), 'toolscript-no-such-node') })
    if (WINDOWS) assert.equal(r.ending.kind === 'failed' && r.ending.error.code, 'ENOENT', JSON.stringify(r.ending))
    else {
      assert.deepEqual(r.ending, { kind: 'exit', code: 127, signal: null })
      assert.match(r.stderr, /toolscript-no-such-node: not found/)
    }
  },
}

for (const line of skipped) console.log(`skip  ${line}`)

let failed = 0
for (const [name, fn] of Object.entries(cases)) {
  try {
    await fn()
    console.log(`pass  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`)
  }
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
