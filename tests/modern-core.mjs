// The protocol engine that the raw modern peers share (issue #154, C0): plain JSON-RPC, no SDK, no import from src/.
// It holds what a server of the 2026-07-28 revision does, and what a 2025 server does after `initialize`. The stdio peer
// (modern-server.mjs) and the HTTP peer (modern-http.mjs) feed it one message at a time and give it a `send`.
// Sources for the wire shapes: client 2.4.0 `dist/public-CvV4ZHkX.mjs` (the probe: buildProbeRequest 2369, classifyResult
// 2060, classifyRpcError 2086), core 2.4.0 `dist/schemas-DBHuY3cl.d.mts` (DiscoverResultSchema 931, the listen request 1540,
// the acknowledged notification 1590), core `dist/schemas-DscsoNZN.mjs` (the _meta keys).

export const MODERN = '2026-07-28'
export const LEGACY = '2025-06-18'
export const KEY = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
}
export const SERVER_INFO = { name: 'modern-fake', version: '0.0.1' }

export const baseTools = () => [
  {
    name: 'echo',
    description: 'Gives back its arguments, the pid of the server and the client capabilities that it was told.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'slow',
    description: 'Answers after ms milliseconds (default 30000). A cancel ends it with no answer.',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
]

/** The state of one server process (or one HTTP server): its tool list, the ids it saw cancelled, its timers. */
export const createState = () => ({ tools: baseTools(), cancelled: [], timers: new Map() })

/** One connection: its era (undefined until it is pinned), its open listen streams, what a 2025 client told it. */
export const createConn = () => ({
  era: undefined,
  listens: new Map(),
  legacyInit: false,
  legacyCapabilities: undefined,
})

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
})
export { ok, fail }

const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

// A request carries its envelope in params._meta; the server keeps no state between requests.
const envelopeOf = msg => msg.params?._meta ?? {}

const callTool = (state, conn, msg, send, capabilities) => {
  const { name, arguments: args } = msg.params ?? {}
  if (!state.tools.some(t => t.name === name)) return send(fail(msg.id, -32602, `Unknown tool: ${String(name)}`))
  if (name === 'slow') {
    const ms = typeof args?.ms === 'number' ? args.ms : 30_000
    const timer = setTimeout(() => {
      state.timers.delete(msg.id)
      send(ok(msg.id, text({ done: true })))
    }, ms)
    state.timers.set(msg.id, timer)
    return undefined
  }
  return send(ok(msg.id, text({ args: args ?? {}, pid: process.pid, clientCapabilities: capabilities ?? null })))
}

// A cancel of a request: its timer, or its listen stream, ends with no answer. The ids that were cancelled stay in the state.
const cancel = (state, conn, msg) => {
  const id = msg.params?.requestId
  state.cancelled.push(id)
  clearTimeout(state.timers.get(id))
  state.timers.delete(id)
  conn.listens.delete(id)
}

/**
 * A message on a connection of the 2026-07-28 era. `initialize` is refused with -32601, a request with no version in its
 * envelope with -32602, an unknown version with -32022 (data.supported). `send` gets each message for the connection.
 */
export const handleModern = (state, conn, msg, rawSend) => {
  // Every result of this revision carries `resultType: "complete"`: the real client refuses a result without it (found by the
  // fidelity run against client 2.4.0, `dist/src-CeKsbNLO.mjs` stampResultType 3645).
  const send = message =>
    rawSend(
      message.result === undefined ? message : { ...message, result: { resultType: 'complete', ...message.result } },
    )
  if (msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') cancel(state, conn, msg)
    return
  }
  if (msg.method === 'initialize') return send(fail(msg.id, -32601, 'Method not found: initialize'))
  const meta = envelopeOf(msg)
  if (typeof meta[KEY.version] !== 'string') {
    return send(fail(msg.id, -32602, `Request is missing ${KEY.version} in params._meta`))
  }
  if (meta[KEY.version] !== MODERN) {
    return send(
      fail(msg.id, -32022, 'Unsupported protocol version', { supported: [MODERN], requested: meta[KEY.version] }),
    )
  }
  const capabilities = meta[KEY.capabilities]
  switch (msg.method) {
    case 'server/discover':
      return send(
        ok(msg.id, {
          supportedVersions: [MODERN],
          capabilities: { tools: { listChanged: true } },
          instructions: 'A fake server of the 2026-07-28 revision, for tests.',
          _meta: { [KEY.serverInfo]: SERVER_INFO },
        }),
      )
    case 'tools/list':
      return send(ok(msg.id, { tools: state.tools, ttlMs: 1000, cacheScope: 'private' }))
    case 'tools/call':
      return callTool(state, conn, msg, send, capabilities)
    case 'subscriptions/listen': {
      const filter = msg.params?.notifications
      if (typeof filter !== 'object' || filter === null) return send(fail(msg.id, -32602, 'notifications is required'))
      conn.listens.set(msg.id, { filter, send })
      return send({
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { _meta: { [KEY.subscriptionId]: msg.id }, notifications: filter },
      })
    }
    default:
      return send(fail(msg.id, -32601, `Method not found: ${msg.method}`))
  }
}

/** A message on a 2025 connection, after `initialize` (the caller decides what a request before it gets). */
export const handleLegacy = (state, conn, msg, send) => {
  if (msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') cancel(state, conn, msg)
    return
  }
  switch (msg.method) {
    case 'initialize':
      conn.legacyInit = true
      conn.era = 'legacy'
      conn.legacyCapabilities = msg.params?.capabilities
      return send(
        ok(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? LEGACY,
          capabilities: { tools: { listChanged: true } },
          serverInfo: SERVER_INFO,
        }),
      )
    case 'ping':
      return send(ok(msg.id, {}))
    case 'tools/list':
      return send(ok(msg.id, { tools: state.tools }))
    case 'tools/call':
      return callTool(state, conn, msg, send, conn.legacyCapabilities)
    default:
      return send(fail(msg.id, -32601, `Method not found: ${msg.method}`))
  }
}

/** The tool list changes: add a tool (default name `extra`) or remove one. Returns false when nothing changed. */
export const changeTools = (state, action, name = 'extra') => {
  if (action === 'add-tool') {
    if (state.tools.some(t => t.name === name)) return false
    state.tools = [
      ...state.tools,
      { name, description: `Added tool ${name}.`, inputSchema: { type: 'object', properties: {} } },
    ]
    return true
  }
  if (action === 'remove-tool') {
    const before = state.tools.length
    state.tools = state.tools.filter(t => t.name !== name)
    return state.tools.length !== before
  }
  return false
}

/**
 * Tell the connections of a change of the tool list: a modern one only on the streams that asked for it (stamped with the id
 * of their listen request), a 2025 one with a plain notification once it initialized.
 */
export const notifyToolsChanged = (conns, sendLegacy) => {
  for (const conn of conns) {
    for (const [id, { filter, send }] of conn.listens) {
      if (filter.toolsListChanged === true) {
        send({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
          params: { _meta: { [KEY.subscriptionId]: id } },
        })
      }
    }
    if (conn.era === 'legacy' && conn.legacyInit) {
      sendLegacy?.(conn, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
  }
}
