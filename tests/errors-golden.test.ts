// The golden test of the model-facing error texts and the run-log codes of a nested call (issue #154, PR 5). The
// expected values in tests/fixtures/errors-golden.json were recorded at the base of the SDK move (`GOLDEN_RECORD=1`), and
// every later SDK must give the same bytes. The server is tests/golden-server.mjs, which writes raw JSON-RPC and imports
// no SDK. The same file holds the first messages that the client sends to it: the `initialize` params and the list of
// methods, so a client that probes (`server/discover`) or offers another version or capability shows here.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, type Config, type ServerConfig, type ServerKey } from '../src/core/config.ts'
import { runLogFile } from '../src/core/paths.ts'
import type { Rule } from '../src/core/policy.ts'
import { newKept } from '../src/core/protocol.ts'
import type { RunRecord } from '../src/core/runlog.ts'
import { connectAll, type Downstream } from '../src/host/downstream.ts'
import { runCode, type RunContext } from '../src/host/run.ts'

const SERVER = path.join(import.meta.dirname, 'golden-server.mjs')
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'errors-golden.json')
const RECORD = process.env.GOLDEN_RECORD === '1'
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-golden-'))
const TMP = path.join(ROOT, 'tmp')
fs.mkdirSync(TMP)
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = TMP
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
})

const KEY = 'g' as ServerKey
const GONE = 'gone' as ServerKey
const golden: Record<string, unknown> =
  RECORD || !fs.existsSync(FIXTURE) ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const recorded: Record<string, unknown> = {}

/** Asserts `value` against the fixture, or records it. */
const settle = (name: string, value: unknown): void => {
  recorded[name] = value
  if (!RECORD) assert.deepEqual(value, golden[name], `the golden value of ${name} changed`)
}
after(() => {
  if (RECORD) fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
})

type Rig = {
  run: (code: string) => ReturnType<typeof runCode>
  lines: () => RunRecord[]
  log: string
  downstream: Downstream
}

const rig = (
  options: { callSeconds?: number; signal?: AbortSignal; servers?: Map<ServerKey, ServerConfig> } = {},
): Rig => {
  const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
  const log = path.join(home, 'received.jsonl')
  const servers =
    options.servers ??
    new Map<ServerKey, ServerConfig>([
      [KEY, { kind: 'stdio', command: process.execPath, args: [SERVER, log], env: {} }],
    ])
  const downstream = connectAll(servers, '0', () => {})
  opened.push(downstream)
  const policy: Rule[] = [{ match: 'mcp__*', action: 'allow', index: 0 }]
  const config: Config = {
    servers,
    bridges: new Set(),
    guards: { bridges: new Set(), workspace: false },
    sandbox: { node: process.execPath, timeoutSeconds: 30, callTimeoutSeconds: options.callSeconds ?? 30 },
    policy,
    log: true,
  }
  const ctx: RunContext = {
    downstream,
    config,
    kept: newKept(),
    written: new Map(),
    untrustedFiles: new Set(),
    shapes: new Map(),
    filesDir: path.join(ROOT, 'files', 'session'),
    policyNote: '',
    ask: async () => 'accept',
    canAsk: () => true,
    signal: options.signal ?? new AbortController().signal,
    log: () => {},
    home,
  }
  const lines = (): RunRecord[] => {
    const file = runLogFile(home)
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l) as RunRecord)
      : []
  }
  return { run: code => runCode(ctx, code), lines, log, downstream }
}

/** What the model got for one call, and what the run log says of it, with the times left out. */
const observe = async (r: Rig, tool: string): Promise<unknown> => {
  const program = `try { return "OK:" + JSON.stringify(await call(${JSON.stringify(`mcp__${KEY}__${tool}`)}, {})) } catch (e) { return "ERR:" + e.message }`
  const result = await r.run(program)
  const calls = r.lines().flatMap(l => l.calls.map(({ ms: _ms, ...rest }) => rest))
  return { isError: result.isError, text: result.text.split('\n--- ')[0], calls }
}

describe('the texts of a nested call that fails', () => {
  for (const tool of [
    'ok',
    'invalid_params',
    'no_method',
    'internal',
    'custom',
    'is_error',
    'no_structured',
    'bad_result',
    'bad_output',
    'not_listed',
  ]) {
    test(`a call of ${tool}`, async () => {
      const r = rig()
      await r.downstream.settled
      settle(tool, await observe(r, tool))
    })
  }

  test('a call that stalls ends at the call limit', async () => {
    const r = rig({ callSeconds: 1 })
    await r.downstream.settled
    settle('stall', await observe(r, 'stall'))
  })

  test('a child that exits during the call', async () => {
    const r = rig()
    await r.downstream.settled
    settle('die', await observe(r, 'die'))
  })

  test('a call that the run cancels', async () => {
    const controller = new AbortController()
    const r = rig({ signal: controller.signal })
    await r.downstream.settled
    setTimeout(() => controller.abort(), 400)
    settle('cancelled', await observe(r, 'stall'))
  })

  test('a server with no tools capability that answers tools/list with an error', async () => {
    const args = [SERVER, path.join(ROOT, 'nocaps.jsonl'), 'nocaps']
    const servers = new Map<ServerKey, ServerConfig>([
      [KEY, { kind: 'stdio', command: process.execPath, args, env: {} }],
    ])
    const r = rig({ servers })
    await r.downstream.settled
    const state = r.downstream.states()[0]
    settle('nocaps', state?.status === 'failed' ? state.reason : state?.status)
  })

  test('a server whose tools/list breaks the result schema of the SDK', async () => {
    const args = [SERVER, path.join(ROOT, 'badlist.jsonl'), 'badlist']
    const servers = new Map<ServerKey, ServerConfig>([
      [KEY, { kind: 'stdio', command: process.execPath, args, env: {} }],
    ])
    const r = rig({ servers })
    await r.downstream.settled
    const state = r.downstream.states()[0]
    settle('badlist', state?.status === 'failed' ? state.reason : state?.status)
  })

  test('a missing command: the state, the refusal and the call', async () => {
    const servers = new Map<ServerKey, ServerConfig>([
      [GONE, { kind: 'stdio', command: 'toolscript-golden-no-such-command', args: [], env: {} }],
    ])
    const r = rig({ servers })
    await r.downstream.settled
    const state = r.downstream.states()[0]
    const link = await r.downstream.client(GONE)
    const result = await r.run(
      `try { return await call("mcp__${GONE}__x", {}) } catch (e) { return "ERR:" + e.message }`,
    )
    settle('missing', {
      state: state?.status === 'failed' ? state.reason : state?.status,
      link: link.ok ? 'ok' : link.reason,
      // The wait in the note moves by a second with the clock.
      text: result.text.split('\n--- ')[0]?.replace(/after \d+ s/u, 'after N s'),
    })
  })
})

describe('what the client sends first', () => {
  test('a stdio link opens with initialize, offers its version and capabilities, and never asks server/discover', async () => {
    const r = rig()
    await r.downstream.settled
    await observe(r, 'ok')
    const sent = fs
      .readFileSync(r.log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { method: string; params?: unknown })
    const methods = sent.map(s => s.method)
    assert.equal(methods[0], 'initialize')
    assert.ok(!methods.includes('server/discover'), methods.join(','))
    settle('first', { methods, initialize: sent[0]?.params })
  })
})
