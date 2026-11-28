// Approval on a 2026-07-28 connection (issue #154, P3-1, gate G5), on the built host (dist/host/main.js), with the raw client of C0 and
// no SDK. Run `npm run build` first.
//
//   node tests/modern-approval.e2e.mjs
//
// An `ask` rule does not refuse on a modern connection that declared elicitation: `run_code` returns `input_required` with the prompt
// of today and a sealed `requestState`, and the client calls again with `inputResponses` and the state. A run starts only after an accept
// that belongs to this program, these tools and this policy, one time. The rows of the bar: accept, decline, cancel, no or bad answer,
// a replay, a state moved to another program or tool, a changed bit in each part of the state, a restart, a policy that changed between
// the rounds, the policy round before the tools round, 5 rounds, the capability of the request, two calls in flight, and the opening of
// Claude Code with the retry shape of probe D. The clock row (601 s) is in tests/modern-approval.test.ts. Every process has a temp HOME,
// USERPROFILE, APPDATA and TMP; the downstream calls are counted at the fake server.

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_CODE_CAPABILITIES, createClient, streamTransport, within } from './modern-client.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MAIN = process.env.TOOLSCRIPT_E2E_MAIN || path.join(ROOT, 'dist', 'host', 'main.js')
const FAKE = path.join(ROOT, 'bench', 'fake-server.mjs')
const WIN = process.platform === 'win32'
const CAPS = 'io.modelcontextprotocol/clientCapabilities'
const ELICIT = { ...CLAUDE_CODE_CAPABILITIES, elicitation: { form: {}, url: {} } }

const children = new Set()
const folders = []
const tempDir = name => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `toolscript-approval-${name}-`)))
  folders.push(dir)
  return dir
}
const killTree = pid => {
  if (WIN) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
}

const ASK = [
  { match: 'mcp__bench__get_deploys', action: 'ask' },
  { match: 'mcp__bench__*', action: 'allow' },
]
const DEPLOYS = 'const r = await call("mcp__bench__get_deploys", { date: "2026-10-09" }); return r.count'
const BOTH =
  'const a = await call("mcp__bench__list_issues", { project: "OPS" }); const b = await call("mcp__bench__get_deploys", { date: "2026-10-09" }); return [a.total, b.count]'

/** A host of the built server (TOOLSCRIPT_PROTOCOL=auto), its config file (rewritten between rounds) and a count of downstream calls. */
const start = (policy, { capabilities = ELICIT, protocol = 'auto', workspace } = {}) => {
  const home = tempDir('home')
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  const dir = tempDir('config')
  const file = path.join(dir, 'config.json')
  const log = path.join(dir, 'calls.jsonl')
  const write = rules =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { bench: { command: process.execPath, args: [FAKE], env: { BENCH_LOG: log } } },
        policy: rules,
        ...(workspace !== undefined && { workspace }),
      }),
    )
  write(policy)
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('TOOLSCRIPT_')) delete env[name]
  const child = spawn(process.execPath, [MAIN, '--config', file], {
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      TMPDIR: dir,
      TEMP: dir,
      TMP: dir,
      TOOLSCRIPT_SHARE: '0',
      TOOLSCRIPT_PROTOCOL: protocol,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-20_000)))
  const transport = streamTransport(child.stdout, child.stdin)
  const client = createClient(transport, { capabilities, timeoutMs: 60_000 })
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  return {
    client,
    file,
    stderr: () => stderr,
    rewrite: write,
    /** The downstream tools/call count: one line of the fake server for each. */
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
    /** `run_code`, with the retry fields when given and the envelope capabilities of this request when given. */
    call: (code, retry = {}, { caps, meta } = {}) =>
      client.request(
        'tools/call',
        { name: 'run_code', arguments: { code }, ...retry },
        { meta: { ...(caps !== undefined && { [CAPS]: caps }), ...(meta ?? {}) } },
      ),
    close: async () => {
      client.close()
      await within(exited, 20_000, 'the host exit').catch(() => killTree(child.pid))
      await exited
    },
  }
}
const textOf = reply => reply.result.content.map(b => b.text ?? '').join('')
const retryOf = (first, action = 'accept') => ({
  inputResponses: { approve: { action, content: {} } },
  requestState: first.result.requestState,
})
const INVALID = { code: -32602, message: 'Invalid or expired requestState', data: { reason: 'invalid_request_state' } }
const asked = reply => {
  assert.equal(reply.result?.resultType, 'input_required', JSON.stringify(reply).slice(0, 400))
  assert.deepEqual(Object.keys(reply.result.inputRequests), ['approve'])
  assert.equal(reply.result.inputRequests.approve.method, 'elicitation/create')
  return reply
}
const refusedWith = (reply, fragment) => {
  assert.equal(reply.result?.isError, true, JSON.stringify(reply).slice(0, 400))
  assert.match(textOf(reply), fragment)
}

/** A legacy connection on the same wiring, whose client declared elicitation and answers each prompt with `answer`. */
const legacyAsk = async (code, answer) => {
  const host = start(ASK, { capabilities: {} })
  const prompts = []
  const inner = host.client.transport.onMessage
  host.client.transport.onMessage = message => {
    if (message.method === 'elicitation/create') {
      prompts.push(message.params.message)
      host.client.transport.send({ jsonrpc: '2.0', id: message.id, ...answer })
    }
    inner(message)
  }
  try {
    const opened = await host.client.legacyRequest('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'raw-client', version: '0.0.1' },
    })
    assert.ok(!opened.error, JSON.stringify(opened))
    host.client.notify('notifications/initialized')
    const reply = await host.client.legacyRequest('tools/call', { name: 'run_code', arguments: { code } })
    return { prompts, text: textOf(reply), calls: host.calls() }
  } finally {
    await host.close()
  }
}

const cases = []
const test = (name, fn) => cases.push([name, fn])

test('an accept runs once, the prompt is the legacy prompt, and the state is small and holds nothing readable', async () => {
  const host = start(ASK)
  const legacy = await legacyAsk(DEPLOYS, { result: { action: 'accept', content: {} } })
  try {
    await host.client.discover()
    const first = asked(await host.call(DEPLOYS))
    assert.equal(host.calls(), 0, 'no nested call came from the first round')
    assert.equal(first.result.inputRequests.approve.params.message, legacy.prompts[0], 'the prompt message of today')
    assert.deepEqual(first.result.inputRequests.approve.params.requestedSchema, { type: 'object', properties: {} })
    const state = first.result.requestState
    assert.ok(state.length <= 512, `the state is ${state.length} characters`)
    // The client can read the payload: it holds no program text, no tool name, no path.
    const body = Buffer.from(state.split('.')[0], 'base64url').toString('utf8')
    assert.match(body, /"k":"approval"/, 'the kind of the state is in its sealed body')
    for (const secret of ['get_deploys', 'mcp__', '2026-10-09', 'deploys', os.homedir()])
      assert.ok(!body.includes(secret) && !state.includes(secret), `the state holds ${secret}`)
    const done = await host.call(DEPLOYS, retryOf(first))
    assert.ok(!done.result.isError, JSON.stringify(done).slice(0, 300))
    assert.match(textOf(done), /^400/)
    assert.equal(host.calls(), 1, 'the tool was called once')
    assert.equal(
      textOf(done),
      legacy.text.replace(/\n\n---.*$/s, '') + textOf(done).slice(legacy.text.replace(/\n\n---.*$/s, '').length),
      'the result of an accept',
    )
  } finally {
    await host.close()
  }
})

test('a decline, a cancel, no answer and a bad answer run nothing and give the text of the same answers on legacy', async () => {
  const declined = await legacyAsk(DEPLOYS, { result: { action: 'decline' } })
  const cancelled = await legacyAsk(DEPLOYS, { result: { action: 'cancel' } })
  const errored = await legacyAsk(DEPLOYS, { error: { code: -32603, message: 'the person left' } })
  for (const [label, retry, want] of [
    ['decline', { inputResponses: { approve: { action: 'decline' } } }, declined.text],
    ['cancel', { inputResponses: { approve: { action: 'cancel' } } }, declined.text],
    ['no approve entry', { inputResponses: {} }, errored.text],
    ['a malformed entry', { inputResponses: { approve: 'yes' } }, errored.text],
    ['another action', { inputResponses: { approve: { action: 'maybe' } } }, errored.text],
    ['no inputResponses', {}, errored.text],
  ]) {
    const host = start(ASK)
    try {
      await host.client.discover()
      const first = asked(await host.call(DEPLOYS))
      const reply = await host.call(DEPLOYS, { requestState: first.result.requestState, ...retry })
      refusedWith(reply, /did not approve/)
      assert.equal(textOf(reply), want, `${label}: the text of today`)
      assert.equal(host.calls(), 0, `${label}: nothing ran`)
    } finally {
      await host.close()
    }
  }
  assert.equal(cancelled.text, declined.text)
})

test('the same retry twice: the second is -32602, and the tool was called once', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    const first = asked(await host.call(DEPLOYS))
    const one = await host.call(DEPLOYS, retryOf(first))
    assert.ok(!one.result.isError)
    const two = await host.call(DEPLOYS, retryOf(first))
    assert.deepEqual(two.error, INVALID)
    assert.equal(host.calls(), 1)
    assert.match(host.stderr(), /an approval state was refused: used/)
  } finally {
    await host.close()
  }
})

test('a state moved to another program, another tool or arguments that differ by one byte is -32602, and nothing runs', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    for (const [label, send] of [
      ['another program', first => host.call(DEPLOYS + ' ', retryOf(first))],
      ['one byte', first => host.call(DEPLOYS.replace('2026-10-09', '2026-10-08'), retryOf(first))],
      [
        'another tool',
        first =>
          host.client.request('tools/call', { name: 'search_tools', arguments: { query: '' }, ...retryOf(first) }),
      ],
    ]) {
      const first = asked(await host.call(DEPLOYS))
      assert.deepEqual((await send(first)).error, INVALID, label)
      assert.equal(host.calls(), 0, `${label}: nothing ran`)
    }
  } finally {
    await host.close()
  }
})

test('one changed character in each of the three parts of the state is -32602, and the state of the call still works after', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    const first = asked(await host.call(DEPLOYS))
    const state = first.result.requestState
    // The state is the sealed body and its MAC: two parts. One changed character in each, and a third part.
    const [body, mac] = state.split('.')
    const flip = text => text.slice(0, 5) + (text[5] === 'A' ? 'B' : 'A') + text.slice(6)
    for (const [label, bad] of [
      ['body', `${flip(body)}.${mac}`],
      ['mac', `${body}.${flip(mac)}`],
      ['a third part', `${body}.${mac}.x`],
    ]) {
      const reply = await host.call(DEPLOYS, { inputResponses: { approve: { action: 'accept' } }, requestState: bad })
      assert.deepEqual(reply.error, INVALID, label)
    }
    assert.equal(host.calls(), 0)
    // A state that fails its seal is not used up: the real one still runs the program, once.
    const done = await host.call(DEPLOYS, retryOf(first))
    assert.ok(!done.result.isError)
    assert.equal(host.calls(), 1)
  } finally {
    await host.close()
  }
})

test('a restart between the rounds ends the state: the next host refuses it, and asks again', async () => {
  const a = start(ASK)
  const b = start(ASK)
  try {
    await Promise.all([a.client.discover(), b.client.discover()])
    const first = asked(await a.call(DEPLOYS))
    assert.deepEqual((await b.call(DEPLOYS, retryOf(first))).error, INVALID)
    assert.equal(b.calls(), 0)
    asked(await b.call(DEPLOYS))
  } finally {
    await Promise.all([a.close(), b.close()])
  }
})

test('between the rounds: an allow turned into deny is refused, an ask added is a new prompt, the old answer runs nothing', async () => {
  const deny = start(ASK)
  const add = start(ASK)
  try {
    await Promise.all([deny.client.discover(), add.client.discover()])
    const first = asked(await deny.call(BOTH))
    // list_issues was allowed: it becomes denied before the retry. The program is refused, and nothing runs.
    deny.rewrite([{ match: 'mcp__bench__list_issues', action: 'deny' }, ...ASK])
    refusedWith(await deny.call(BOTH, retryOf(first)), /list_issues/)
    assert.equal(deny.calls(), 0)

    const second = asked(await add.call(BOTH))
    add.rewrite([
      { match: 'mcp__bench__get_deploys', action: 'ask' },
      { match: 'mcp__bench__*', action: 'ask' },
    ])
    const again = asked(await add.call(BOTH, retryOf(second)))
    assert.equal(add.calls(), 0, 'nothing ran on the old answer')
    assert.match(again.result.inputRequests.approve.params.message, /list_issues/)
    assert.notEqual(again.result.requestState, second.result.requestState)
    const done = await add.call(BOTH, retryOf(again))
    assert.ok(!done.result.isError, JSON.stringify(done).slice(0, 300))
    assert.equal(add.calls(), 2)
  } finally {
    await Promise.all([deny.close(), add.close()])
  }
})

test('the looser policy is a round of its own, before the tools round', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    // The file now allows more than the policy in force (no rule for list_issues means ask): a looser policy needs the person.
    host.rewrite([
      { match: 'mcp__bench__get_deploys', action: 'ask' },
      { match: 'mcp__bench__list_issues', action: 'allow' },
    ])
    const policy = asked(await host.call(BOTH))
    assert.match(policy.result.inputRequests.approve.params.message, /policy/i)
    assert.equal(host.calls(), 0)
    // Its accept applies the policy, and the handler goes on to the tools round.
    const tools = asked(await host.call(BOTH, retryOf(policy)))
    assert.match(tools.result.inputRequests.approve.params.message, /get_deploys/)
    assert.equal(host.calls(), 0)
    // The state of the policy round does not answer the tools round.
    const wrong = await host.call(BOTH, retryOf(policy))
    assert.deepEqual(wrong.error, INVALID, 'a state is used one time')
    const done = await host.call(BOTH, retryOf(tools))
    assert.ok(!done.result.isError, JSON.stringify(done).slice(0, 300))
    assert.equal(host.calls(), 2)
  } finally {
    await host.close()
  }
})

test('a state of the policy round, when no policy is pending, is not an answer to the tools round', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    host.rewrite([
      { match: 'mcp__bench__get_deploys', action: 'ask' },
      { match: 'mcp__bench__list_issues', action: 'allow' },
    ])
    const policy = asked(await host.call(BOTH))
    // The file goes back to the policy in force: no policy is pending, and the state of the policy round is for nothing.
    host.rewrite(ASK)
    const reply = await host.call(BOTH, retryOf(policy))
    assert.deepEqual(reply.error, INVALID)
    assert.equal(host.calls(), 0)
  } finally {
    await host.close()
  }
})

test('at most 4 rounds: the fifth is the refusal of a prompt that was not answered', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    let reply = asked(await host.call(BOTH))
    // Each retry finds another policy (a tightening that applies at once), so the plan is asked again.
    for (let round = 2; round <= 4; round++) {
      host.rewrite([{ match: `mcp__bench__no_such_${round}`, action: 'deny' }, ...ASK])
      reply = asked(await host.call(BOTH, retryOf(reply)))
    }
    host.rewrite([{ match: 'mcp__bench__no_such_5', action: 'deny' }, ...ASK])
    const fifth = await host.call(BOTH, retryOf(reply))
    refusedWith(fifth, /did not approve/)
    assert.equal(host.calls(), 0)
  } finally {
    await host.close()
  }
})

test('the capability is the one of the request: asked with it, "cannot ask" without it, also after a request that had it', async () => {
  const host = start(ASK, { capabilities: ELICIT })
  try {
    await host.client.discover()
    asked(await host.call(DEPLOYS))
    const without = await host.call(DEPLOYS, {}, { caps: CLAUDE_CODE_CAPABILITIES })
    refusedWith(without, /cannot ask the person/)
    assert.equal(host.calls(), 0)
    // An empty elicitation capability is not the form mode: it is not asked either.
    refusedWith(await host.call(DEPLOYS, {}, { caps: { elicitation: {} } }), /cannot ask the person/)
    asked(await host.call(DEPLOYS))
  } finally {
    await host.close()
  }
})

test('two calls in flight each have their own state, and do not mix', async () => {
  const host = start(ASK)
  try {
    await host.client.discover()
    const one = 'const r = await call("mcp__bench__get_deploys", { date: "2026-10-09" }); return "one " + r.count'
    const two = 'const r = await call("mcp__bench__get_deploys", { date: "2026-10-09" }); return "two " + r.count'
    const [a, b] = await Promise.all([host.call(one), host.call(two)])
    asked(a)
    asked(b)
    // The states are swapped: each is refused. Then each runs with its own.
    assert.deepEqual((await host.call(one, retryOf(b))).error, INVALID)
    assert.deepEqual((await host.call(two, retryOf(a))).error, INVALID)
    assert.equal(host.calls(), 0)
  } finally {
    await host.close()
  }
})

test('the opening of Claude Code and the retry shape of probe D runs the program once', async () => {
  const host = start(ASK, { capabilities: ELICIT })
  try {
    await host.client.discover()
    await host.client.listen()
    const meta = { 'claudecode/toolUseId': 'toolu_01TEST' }
    const first = asked(await host.call(DEPLOYS, {}, { meta }))
    const done = await host.call(
      DEPLOYS,
      { inputResponses: { approve: { action: 'accept', content: {} } }, requestState: first.result.requestState },
      { meta },
    )
    assert.ok(!done.result.isError, JSON.stringify(done).slice(0, 300))
    assert.equal(host.calls(), 1)
  } finally {
    await host.close()
  }
})

// --- the fold with the roots round (P3-2): one sealer, one counter ---------------------------------------------------------------

const ROOTS_CAPS = { ...ELICIT, roots: { listChanged: true } }
const rootsUri = dir => new URL(`file:///${dir.replaceAll('\\', '/')}`).href
const rootsRetry = (code, first, project) => ({
  inputResponses: { roots: { roots: [{ uri: rootsUri(project) }] } },
  requestState: first.result.requestState,
  code,
})
const askedRoots = reply => {
  assert.equal(reply.result?.resultType, 'input_required', JSON.stringify(reply).slice(0, 300))
  assert.deepEqual(Object.keys(reply.result.inputRequests), ['roots'])
  return reply
}

test('a call that needs the roots and the approval: roots, then approval, then one run, counted at the fake server', async () => {
  const project = tempDir('project')
  fs.writeFileSync(path.join(project, 'readme.txt'), 'hello')
  const host = start(ASK, { capabilities: ROOTS_CAPS, workspace: { roots: [{ path: project }] } })
  try {
    await host.client.discover()
    const first = askedRoots(await host.call(DEPLOYS))
    assert.equal(host.calls(), 0)
    // The roots answer: the roots round takes its own state, and the same call goes on to the approval round (a new prompt).
    const second = asked(await host.call(DEPLOYS, rootsRetry(DEPLOYS, first, project)))
    assert.equal(host.calls(), 0, 'nothing ran before the approval')
    assert.notEqual(second.result.requestState, first.result.requestState)
    assert.ok(second.result.requestState.length <= 512)
    // The roots state is used up: it cannot settle or approve anything again.
    assert.deepEqual((await host.call(DEPLOYS, retryOf(first))).error, INVALID)
    const done = await host.call(DEPLOYS, retryOf(second))
    assert.ok(!done.result.isError, JSON.stringify(done).slice(0, 300))
    assert.equal(host.calls(), 1, 'one run for the one accept')
    // The approval state does not burn a roots state, and is used one time too.
    assert.deepEqual((await host.call(DEPLOYS, retryOf(second))).error, INVALID)
    assert.equal(host.calls(), 1)
  } finally {
    await host.close()
  }
})

test('one counter across both kinds: the roots round is a round, and the fifth is refused', async () => {
  const project = tempDir('project')
  const host = start(ASK, { capabilities: ROOTS_CAPS, workspace: { roots: [{ path: project }] } })
  try {
    await host.client.discover()
    const roots = askedRoots(await host.call(DEPLOYS))
    // Round 1 was the roots. The approval prompts are rounds 2, 3 and 4; the plan changes between them.
    let reply = asked(await host.call(DEPLOYS, rootsRetry(DEPLOYS, roots, project)))
    for (let round = 3; round <= 4; round++) {
      host.rewrite([{ match: `mcp__bench__no_such_${round}`, action: 'deny' }, ...ASK])
      reply = asked(await host.call(DEPLOYS, retryOf(reply)))
    }
    host.rewrite([{ match: 'mcp__bench__no_such_5', action: 'deny' }, ...ASK])
    refusedWith(await host.call(DEPLOYS, retryOf(reply)), /did not approve/)
    assert.equal(host.calls(), 0)
  } finally {
    await host.close()
  }
})

let failed = 0
for (const [name, fn] of cases) {
  const t = Date.now()
  try {
    await fn()
    console.log(`pass  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  } catch (err) {
    failed++
    console.log(
      `FAIL  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s): ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    for (const child of children) if (child.pid !== undefined && child.exitCode === null) killTree(child.pid)
    children.clear()
    for (const dir of folders.splice(0))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
process.exit(failed === 0 ? 0 : 1)
