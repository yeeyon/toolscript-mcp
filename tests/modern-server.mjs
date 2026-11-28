// A fake stdio MCP server in plain JSON-RPC (no SDK), for the conformance tests of the 2026-07-28 revision (issue #154, C0).
// The kind is the first argument, the second is the argument of the kind:
//
//   node tests/modern-server.mjs modern             2026-07-28 only: server/discover, tools, subscriptions/listen
//   node tests/modern-server.mjs dual               modern, and a 2025 `initialize` too; the first message pins the era
//   node tests/modern-server.mjs e32601             old server: the probe gets -32601
//   node tests/modern-server.mjs eother [32602]     old server: the probe gets -32600 (or -32602, -32000)
//   node tests/modern-server.mjs exits              old server: exits 1 on any request before initialize
//   node tests/modern-server.mjs closes             old server: ends stdout at the probe and stays alive
//   node tests/modern-server.mjs silent             old server: never answers the probe
//   node tests/modern-server.mjs garbage            old server: answers the probe with a result that is not a discover result
//   node tests/modern-server.mjs e32022 [modern]    old server: the probe gets -32022 with data.supported (legacy-only, or a modern list)
//   node tests/modern-server.mjs slow [ms]          old server: the probe gets -32601 after ms milliseconds (default 1500)
//
// Every kind lists the same 2 tools (echo, slow). A control line on stdin changes the list, and tells the open streams:
//   {"control":"add-tool","name":"extra"}    {"control":"remove-tool","name":"extra"}
// The old kinds serve a normal 2025 session after `initialize`. The process ends when stdin ends.

import fs from 'node:fs'
import readline from 'node:readline'
import {
  changeTools,
  createConn,
  createState,
  fail,
  handleLegacy,
  handleModern,
  KEY,
  notifyToolsChanged,
  ok,
} from './modern-core.mjs'

const [kind = 'modern', arg] = process.argv.slice(2)
const state = createState()
const conn = createConn()

let stdoutClosed = false
process.stdout.on('error', () => {})
const send = message => {
  if (stdoutClosed) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const isModernMessage = msg => msg.method === 'server/discover' || typeof msg.params?._meta?.[KEY.version] === 'string'

// What an old server answers a request before `initialize`: the probe, and anything else a modern client sends first.
const beforeInitialize = msg => {
  switch (kind) {
    case 'e32601':
      return send(fail(msg.id, -32601, `Method not found: ${msg.method}`))
    case 'eother':
      return send(fail(msg.id, arg === undefined ? -32600 : -Math.abs(Number(arg)), 'Invalid request'))
    case 'exits':
      return process.exit(1)
    case 'closes':
      // process.stdout cannot be ended: close the file descriptor, so the client reads the end of the stream.
      stdoutClosed = true
      return fs.closeSync(1)
    case 'silent':
      return undefined
    case 'garbage':
      return send(ok(msg.id, { garbage: true, supportedVersions: 'not a list' }))
    case 'e32022':
      return send(
        fail(msg.id, -32022, 'Unsupported protocol version', {
          supported: arg === 'modern' ? ['2027-01-15'] : ['2025-06-18', '2025-03-26'],
          requested: msg.params?._meta?.[KEY.version],
        }),
      )
    case 'slow':
      return void setTimeout(() => send(fail(msg.id, -32601, `Method not found: ${msg.method}`)), Number(arg ?? 1500))
    default:
      return send(fail(msg.id, -32601, `Method not found: ${msg.method}`))
  }
}

const route = msg => {
  if (kind === 'modern') return handleModern(state, conn, msg, send)
  if (kind === 'dual') {
    // The first message pins the era of the connection: a 2025 `initialize` or a modern request.
    conn.era ??= msg.method === 'initialize' || !isModernMessage(msg) ? 'legacy' : 'modern'
    if (conn.era === 'modern') return handleModern(state, conn, msg, send)
    if (msg.id !== undefined && msg.method === 'server/discover')
      return send(fail(msg.id, -32601, 'Method not found: server/discover'))
    return handleLegacy(state, conn, msg, send)
  }
  // An old kind: requests before `initialize` get the kind's answer, then a normal 2025 session.
  if (!conn.legacyInit && msg.id !== undefined && msg.method !== 'initialize') return beforeInitialize(msg)
  return handleLegacy(state, conn, msg, send)
}

const control = line => {
  if (!changeTools(state, line.control, line.name)) return
  notifyToolsChanged([conn], (_c, notification) => send(notification))
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', raw => {
  if (raw.trim() === '') return
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return send(fail(null, -32700, 'Parse error'))
  }
  if (msg.control !== undefined) return control(msg)
  route(msg)
})
rl.on('close', () => process.exit(0))
