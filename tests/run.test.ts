// run_code in the host with the real sandbox and fake downstream servers: the
// cases of the plugin's run_code, files, check-before-a-run, output projection
// and approval tests that apply to a standalone server. tests/server.e2e.mjs
// runs the same path through the built server over stdio.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerState } from '../src/core/catalog.ts'
import type { Config, ServerKey } from '../src/core/config.ts'
import type { Rule } from '../src/core/policy.ts'
import { newKept, type Kept } from '../src/core/protocol.ts'
import { TOOL } from '../src/core/tools.ts'
import type { Downstream } from '../src/host/downstream.ts'
import { runCode, type Approval, type RunContext } from '../src/host/run.ts'

// The exchange dirs go under this temp dir, so a test sees one that stays.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-run-test-'))
const TMP = path.join(ROOT, 'tmp')
fs.mkdirSync(TMP)
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = TMP
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))
const leftDirs = () => fs.readdirSync(TMP).filter(f => f.startsWith('toolscript-'))

type Result = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown }
type Tool = (args: Record<string, unknown>, signal: AbortSignal) => Result | Promise<Result>

const json = (v: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
const TOOLS: Record<string, Tool> = {
  echo: args => json({ echoed: args }),
  fail: () => ({ content: [{ type: 'text', text: 'server error' }], isError: true }),
  slow: async () => (await new Promise(r => setTimeout(r, 300)), json({ ok: 1 })),
  // Answers only when the run cancels it.
  hang: (_, signal) =>
    new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))),
  big: () => json(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `item ${i}` }))),
}
const SCHEMAS: Record<string, unknown> = {
  echo: { type: 'object', properties: { n: {}, a: {}, b: {}, x: {} } },
  search: { type: 'object', properties: { query: {}, maxResults: {} }, required: ['query'] },
}

/** One fake server `f` with the tools above. `called` lists each call that reached it. */
const fakeDownstream = () => {
  const called: string[] = []
  let inFlight = 0
  let most = 0
  const client = {
    callTool: async (
      { name, arguments: args }: { name: string; arguments: Record<string, unknown> },
      _schema: unknown,
      options: { signal: AbortSignal },
    ) => {
      called.push(name)
      most = Math.max(most, ++inFlight)
      try {
        const tool = TOOLS[name]
        if (tool === undefined) throw new Error(`unknown tool: ${name}`)
        return await tool(args, options.signal)
      } finally {
        inFlight--
      }
    },
  }
  const states: ServerState[] = [
    {
      key: 'f' as ServerKey,
      status: 'connected',
      tools: [...new Set([...Object.keys(TOOLS), ...Object.keys(SCHEMAS)])].map(name => ({
        name,
        inputSchema: SCHEMAS[name] ?? { type: 'object' },
      })),
    },
  ]
  const downstream = {
    settled: Promise.resolve(),
    states: () => states,
    retry: async () => {},
    client: async (key: ServerKey) =>
      key === 'f' ? { ok: true, client } : { ok: false, reason: `no MCP server "${key}" is connected` },
    close: async () => {},
  } as unknown as Downstream
  return { downstream, called, most: () => most }
}

const rules = (...list: [string, Rule['action']][]): Rule[] =>
  list.map(([match, action], index) => ({ match, action, index }))

type Options = {
  policy?: Rule[]
  timeoutSeconds?: number
  answer?: Approval
  canAsk?: boolean
  kept?: Kept
  signal?: AbortSignal
}

const filesDir = path.join(ROOT, 'files', 'session')

const setup = (o: Options = {}) => {
  const fake = fakeDownstream()
  const asked: string[][] = []
  const config: Config = {
    servers: new Map(),
    sandbox: {
      node: process.execPath,
      timeoutSeconds: o.timeoutSeconds ?? 20,
      callTimeoutSeconds: o.timeoutSeconds ?? 20,
    },
    policy: o.policy ?? rules(['mcp__*', 'allow']),
  }
  const ctx: RunContext = {
    downstream: fake.downstream,
    config,
    kept: o.kept ?? newKept(),
    filesDir,
    ask: async tools => (asked.push([...tools]), o.answer ?? 'accept'),
    canAsk: () => o.canAsk ?? true,
    signal: o.signal ?? new AbortController().signal,
    log: () => {},
  }
  const run = async (code: string) => runCode(ctx, code)
  return { ...fake, asked, run, ctx }
}

describe('run_code', () => {
  test('routes sandbox calls to MCP tools and returns the value', async () => {
    const { run, called } = setup()
    const r = await run(
      'console.log("hello")\nconst a = await call("mcp__f__echo", { n: 1 })\nconst b = await call("mcp__f__echo", { n: 2 })\nreturn [a, b]',
    )
    assert.equal(r.isError, false, r.text)
    assert.ok(r.text.includes('"n": 1') && r.text.includes('"n": 2'), r.text)
    assert.ok(r.text.includes('--- console (1 lines) ---\nhello'), r.text)
    assert.ok(r.text.includes('--- 2 MCP calls: '), r.text)
    assert.deepEqual(called, ['echo', 'echo'])
    assert.deepEqual(leftDirs(), [], 'the exchange dir is removed')
  })

  test('only MCP tools can be called, and not run_code itself', async () => {
    const { run, called } = setup()
    const r = await run(
      `const out = []\nfor (const t of ["Bash", ${JSON.stringify(TOOL.run_code)}]) {\n  try { await call(t, {}) } catch (e) { out.push(e.message) }\n}\nreturn out`,
    )
    assert.ok(r.text.includes('can be called, not \\"Bash\\"'), r.text)
    assert.ok(r.text.includes(`can be called, not \\"${TOOL.run_code}\\"`), r.text)
    assert.deepEqual(called, [])
  })

  test('runs at most 8 nested calls at a time', async () => {
    const { run, most } = setup()
    const r = await run('return (await Promise.all(Array.from({ length: 20 }, () => call("mcp__f__slow", {})))).length')
    assert.ok(r.text.startsWith('20'), r.text)
    assert.ok(r.text.includes('--- 20 MCP calls: '), r.text)
    assert.equal(most(), 8)
  })

  test('empty code is refused before any process starts', async () => {
    const r = await setup().run('   ')
    assert.equal(r.text, 'Error: code is empty.')
    assert.equal(r.isError, true)
  })

  test('sleep waits inside the sandbox', async () => {
    const r = await setup().run('const t = Date.now()\nawait sleep(200)\nreturn Date.now() - t >= 150')
    assert.ok(r.text.startsWith('true'), r.text)
  })

  test('a busy loop ends at the time limit, and the next run works', async () => {
    const { run } = setup({ timeoutSeconds: 1 })
    const started = performance.now()
    const r = await run('while (true) {}')
    assert.ok(r.text.startsWith('Error: the program ran past the time limit of 1 s and was stopped'), r.text)
    assert.ok(performance.now() - started < 10_000)
    assert.deepEqual(leftDirs(), [])
    assert.ok((await run('return 2')).text.startsWith('2'))
  })

  test('an abort (shutdown or a cancelled call) kills the sandbox and removes the exchange dir', async () => {
    const stop = new AbortController()
    const { run } = setup({ signal: stop.signal })
    const running = run('while (true) {}')
    await new Promise(r => setTimeout(r, 500))
    assert.equal(leftDirs().length, 1, 'the run has its exchange dir')
    const started = performance.now()
    stop.abort()
    const r = await running
    assert.ok(performance.now() - started < 3000, 'the run ends soon after the abort')
    assert.equal(r.isError, true)
    assert.deepEqual(leftDirs(), [])
  })
})

describe('a reply that cannot be written', () => {
  test('make it fail: the run stops at once, with no unhandled rejection, and the dir is removed', async () => {
    const write = fs.promises.writeFile
    fs.promises.writeFile = (async (file: fs.PathLike, ...rest: unknown[]) => {
      if (/[\\/]r\d+\.json$/.test(String(file))) throw new Error('EPERM: fake write failure')
      return (write as (...a: unknown[]) => Promise<void>)(file, ...rest)
    }) as typeof write
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandled)
    try {
      const started = performance.now()
      const r = await setup({ timeoutSeconds: 20 }).run('return await call("mcp__f__echo", { n: 1 })')
      assert.ok(performance.now() - started < 5000, 'the run does not wait for the time limit')
      assert.equal(r.isError, true)
      assert.ok(r.text.includes('could not answer message 1 of the program: EPERM: fake write failure'), r.text)
      assert.ok(!r.text.includes('time limit'), r.text)
    } finally {
      fs.promises.writeFile = write
      await new Promise(res => setTimeout(res, 50))
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [])
    assert.deepEqual(leftDirs(), [])
  })
})

describe('files', () => {
  test('saveFile writes in the session folder and returns the path', async () => {
    const r = await setup().run(
      'const out = [await saveFile("rows.csv", [{ a: 1 }])]\ntry { await saveFile("../x", "no") } catch (e) { out.push(e.message) }\nreturn out',
    )
    const file = path.join(filesDir, 'rows.csv')
    assert.equal(fs.readFileSync(file, 'utf8'), 'a\n1\n')
    assert.ok(r.text.includes(JSON.stringify(file)), r.text)
    assert.ok(r.text.includes('is not a file name'), r.text)
    assert.equal(fs.existsSync(path.join(filesDir, '..', 'x')), false)
  })

  test('readFile reads files from saveFile, nothing else', async () => {
    const outside = path.join(ROOT, 'secret.txt')
    fs.writeFileSync(outside, 'fake-secret')
    const r = await setup().run(
      [
        'await saveFile("ids.txt", "a\\nb")',
        'const out = [await readFile("ids.txt")]',
        `for (const p of [${JSON.stringify(outside)}, "../../secret.txt", "nope.txt"]) {`,
        '  try { out.push(await readFile(p)) } catch (e) { out.push(e.message) }',
        '}',
        'return out',
      ].join('\n'),
    )
    assert.ok(r.text.includes('"a\\nb"'), r.text)
    assert.ok(!r.text.includes('fake-secret'), r.text)
    assert.equal(r.text.match(/is not a file from saveFile in this session/g)?.length, 3, r.text)
  })

  test('resources are not offered', async () => {
    const r = await setup().run('try { await resources() } catch (e) { return e.message }')
    assert.ok(r.text.includes('resources() and readResource() are not available'), r.text)
  })
})

describe('the check before a run', () => {
  test('a wrong tool name stops the program before it starts', async () => {
    const { run, called } = setup()
    const r = await run('await call("mcp__f__echo", { n: 1 })\nreturn await call("mcp__f__serch", { query: 1 })')
    assert.ok(r.text.startsWith('Error: the program did not run'), r.text)
    assert.ok(
      r.text.includes('- line 2: no tool "mcp__f__serch" on the connected server "f" (did you mean "mcp__f__search"?)'),
      r.text,
    )
    assert.deepEqual(called, [])
  })

  test('an unknown or a missing argument stops the program, from the input schema', async () => {
    const { run, called } = setup()
    const r = await run('return await call("mcp__f__search", { query: "x", maxResult: 5 })')
    assert.ok(r.text.includes('mcp__f__search: unknown argument "maxResult" (did you mean "maxResults"?)'), r.text)
    const missing = await run('return await call("mcp__f__search", { maxResults: 5 })')
    assert.ok(missing.text.includes('mcp__f__search: missing required argument "query"'), missing.text)
    assert.deepEqual(called, [])
  })
})

describe('output projection', () => {
  test('the footer gives each result a number, its size and its shape', async () => {
    const r = await setup().run(
      'await call("mcp__f__echo", { n: 1 })\ntry { await call("mcp__f__fail", {}) } catch {}\nreturn "ok"',
    )
    assert.ok(r.text.includes('--- 2 MCP calls: '), r.text)
    assert.match(r.text, /#1 mcp__f__echo \d+ \{echoed: \{n\}\}/)
    assert.ok(r.text.includes('- mcp__f__fail failed'), r.text)
    assert.ok(r.text.includes('await recall(n) returns result #n again'), r.text)
  })

  test('a call that never answers is in the footer when the run times out', async () => {
    const { run } = setup({ timeoutSeconds: 1 })
    const r = await run('await call("mcp__f__echo", { n: 1 })\nawait call("mcp__f__hang", {})')
    assert.ok(r.text.startsWith('Error: timeout after 1000 ms'), r.text)
    assert.ok(r.text.includes('--- 2 MCP calls: '), r.text)
    assert.match(r.text, /#1 mcp__f__echo \d+/)
    assert.ok(r.text.includes('- mcp__f__hang did not finish'), r.text)
    assert.deepEqual(leftDirs(), [])
  })

  test('a call still in the queue when the sandbox ends does not start', async () => {
    const { run, called } = setup()
    const r = await run(
      'for (let i = 0; i < 8; i++) call("mcp__f__slow", {}).catch(() => {})\ncall("mcp__f__echo", {}).catch(() => {})\nreturn "out"',
    )
    await new Promise(res => setTimeout(res, 500))
    assert.equal(called.filter(t => t === 'echo').length, 0, 'the queued call never reached the server')
    assert.ok(r.text.includes('--- 9 MCP calls: '), r.text)
    assert.ok(r.text.includes('- mcp__f__echo ×1, 1 did not finish'), r.text)
  })

  test('recall(n) in a later run returns the kept result with no new call', async () => {
    const kept = newKept()
    const { run, called } = setup({ kept })
    await run('return await call("mcp__f__echo", { n: 7 })')
    const r = await run('return [await recall(1), await recall(9).catch(e => e.message)]')
    assert.equal(called.length, 1)
    assert.ok(r.text.includes('"n": 7'), r.text)
    assert.ok(r.text.includes('no result #9 in this session'), r.text)
    assert.ok(r.text.includes('--- 0 MCP calls, 2 recalls: '), r.text)
    assert.ok(r.text.includes('recalled: #1 (0 s old)'), r.text)
  })

  test('a call equal to an earlier one names it', async () => {
    const kept = newKept()
    const { run } = setup({ kept })
    await run('return await call("mcp__f__echo", { a: 1, b: 2 })')
    const r = await run('return await call("mcp__f__echo", { b: 2, a: 1 })')
    assert.ok(r.text.includes('#2 mcp__f__echo'), r.text)
    assert.ok(r.text.includes('the same call as #1'), r.text)
  })

  test('an empty result after calls that returned data says so', async () => {
    const r = await setup().run('await call("mcp__f__echo", { n: 1 })\nreturn []')
    assert.ok(r.text.includes('The result is empty, but the calls returned data'), r.text)
  })

  test('a cut result is kept whole and recall gives it back', async () => {
    const kept = newKept()
    const { run, called } = setup({ kept })
    const cut = await run('return await call("mcp__f__big", {})')
    assert.ok(cut.text.includes('more characters cut; await recall(2) returns the whole result'), cut.text)
    const again = await run('const all = await recall(2)\nreturn all.length')
    assert.ok(again.text.startsWith('3000'), again.text)
    assert.equal(called.length, 1)
  })

  test('make it fail: a result cut only after pretty print is kept for recall', async () => {
    const kept = newKept()
    const { run } = setup({ kept })
    const rows = 'Array.from({ length: 800 }, (_, i) => ({ id: i, ok: true }))'
    const cut = await run(`return ${rows}`)
    assert.ok(
      cut.text.endsWith(
        '… [11092 more characters cut; await recall(1) returns the whole result: return a part of it]\n\n--- 0 MCP calls: 0 characters in, 17k out ---',
      ),
      cut.text.slice(-300),
    )
    const back = await run('const r = await recall(1)\nreturn [r.length, r[799]]')
    assert.ok(back.text.startsWith('[\n  800,\n  {\n    "id": 799,\n    "ok": true'), back.text)
  })
})

describe('approval', () => {
  const policy = rules(['mcp__f__fail', 'deny'], ['mcp__f__echo', 'allow'], ['mcp__f__slow', 'ask'])

  test('a deny rule on a literal name refuses the run before anything runs, and names the rule', async () => {
    const { run, called, asked } = setup({ policy })
    const r = await run('await call("mcp__f__echo", { n: 1 })\nawait call("mcp__f__fail", {})')
    assert.ok(r.text.startsWith('Error: the program did not run'), r.text)
    assert.ok(r.text.includes('- line 2: mcp__f__fail is denied by policy[0]'), r.text)
    assert.deepEqual(called, [])
    assert.deepEqual(asked, [])
  })

  test('ask: a client that cannot ask is refused with the rule to add, and no call is made', async () => {
    const { run, called } = setup({ policy, canAsk: false })
    const r = await run('await call("mcp__f__echo", { n: 1 })\nreturn await call("mcp__f__slow", {})')
    assert.ok(r.text.includes('this MCP client cannot ask the person'), r.text)
    assert.ok(r.text.includes('add {"match": "mcp__f__slow", "action": "allow"} to "policy"'), r.text)
    assert.deepEqual(called, [])
  })

  test('ask: accept runs the program once, and decline refuses it', async () => {
    const accepted = setup({ policy, answer: 'accept' })
    const code = 'return await call("mcp__f__slow", {})\n// mcp__f__big is not called'
    const r = await accepted.run(code)
    assert.equal(r.isError, false, r.text)
    assert.deepEqual(accepted.asked, [['mcp__f__slow']])
    assert.deepEqual(accepted.called, ['slow'])
    const declined = setup({ policy, answer: 'decline' })
    const d = await declined.run(code)
    assert.ok(d.text.includes('the person did not approve'), d.text)
    assert.deepEqual(declined.called, [])
  })

  test('a tool name built at run time is refused at call time, and the program can catch it', async () => {
    const { run, called, asked } = setup({ policy })
    const r = await run(
      'const name = "mcp__f__" + ["e", "c", "h", "o"].join("").replace("echo", "big")\ntry { await call(name, {}) } catch (e) { return "caught: " + e.message }',
    )
    assert.deepEqual(asked, [], 'nothing to ask before the run')
    assert.ok(r.text.includes('caught: not approved: no policy rule allows mcp__f__big'), r.text)
    assert.ok(r.text.includes('## No allow rule'), r.text)
    assert.ok(r.text.includes('{"match": "mcp__f__big", "action": "allow"}'), r.text)
    assert.deepEqual(called, [])
  })

  test('a tool name built at run time that a deny rule matches is refused at call time', async () => {
    const { run, called } = setup({ policy })
    const r = await run('try { await call("mcp__f__" + "fail", {}) } catch (e) { return e.message }')
    assert.ok(r.text.includes('denied by policy[0]'), r.text)
    assert.ok(!r.text.includes('## No allow rule'), r.text)
    assert.deepEqual(called, [])
  })

  test('a server error throws in the program and adds no note', async () => {
    const { run } = setup()
    const r = await run('try { await call("mcp__f__fail", {}) } catch (e) { return e.message }')
    assert.ok(r.text.includes('"server error"'), r.text)
    assert.ok(!r.text.includes('## No allow rule'), r.text)
  })
})
