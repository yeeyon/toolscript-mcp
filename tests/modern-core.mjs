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

/** The kinds of `tests/modern-server.mjs`, as the matrix names them (a name with a dash is a kind with an argument). */
export const STDIO_KINDS = [
  'modern',
  'dual',
  'e32601',
  'eother-32600',
  'eother-32602',
  'eother-32000',
  'exits',
  'closes',
  'silent',
  'garbage',
  'e32022-legacy',
  'e32022-modern',
  'slow',
]
/** The kinds of `tests/modern-http.mjs`. */
export const HTTP_KINDS = [
  'modern',
  'legacy',
  'probe-400',
  'probe-404',
  'probe-405',
  'probe-400-rpc',
  'probe-401',
  'probe-403',
  'probe-500',
  'probe-503',
  'probe-307',
  'probe-hang',
]
/** The command-line arguments (kind, then its argument) of a stdio kind as the matrix names it. */
export const stdioArgs = name => {
  const [kind, arg] = name.split('-')
  return kind === 'e32022'
    ? arg === 'modern'
      ? [kind, 'modern']
      : [kind]
    : arg === '32600'
      ? [kind]
      : arg === undefined
        ? [kind]
        : [kind, arg]
}
/** The kinds that the server file takes on its command line. */
export const STDIO_BASE_KINDS = [...new Set(STDIO_KINDS.map(name => name.split('-')[0]))]

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
// `cancelled`: the ids of the notifications/cancelled that came (stdio; `echo` reports them). `closedEarly`: the requests whose
// HTTP connection closed before the answer, as { method, id } (HTTP: a cancel is the close of the request).
export const createState = () => ({ tools: baseTools(), cancelled: [], closedEarly: [], timers: new Map() })

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
  return send(
    ok(
      msg.id,
      text({
        args: args ?? {},
        pid: process.pid,
        clientCapabilities: capabilities ?? null,
        cancelled: [...state.cancelled],
      }),
    ),
  )
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
 * A message on a connection of the 2026-07-28 era, as a modern-only endpoint of the real SDK answers it (client 2.4.0
 * `dist/src-CeKsbNLO.mjs` 4614 to 4632): a request with no version in its envelope, `initialize` included, gets -32022 with
 * data.supported (era classification); an unknown version gets -32022 too; an unknown method -32601. (-32602 for a missing
 * envelope is only for an HTTP request whose header names a modern revision: modern-http.mjs.) `send` gets each message.
 */
export const handleModern = (state, conn, msg, rawSend) => {
  // Every result of this revision carries `resultType: "complete"`: the real client refuses a result without it (found by the
  // fidelity run against client 2.4.0: it refuses the result, `dist/src-CeKsbNLO.mjs` 3956 to 3961, and the server stamps it, 3645).
  const send = message =>
    rawSend(
      message.result === undefined ? message : { ...message, result: { resultType: 'complete', ...message.result } },
    )
  if (msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') cancel(state, conn, msg)
    return
  }
  const meta = envelopeOf(msg)
  if (typeof meta[KEY.version] !== 'string') {
    return send(
      fail(msg.id, -32022, `Unsupported protocol version: no ${KEY.version} in params._meta`, { supported: [MODERN] }),
    )
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
          // ttlMs and cacheScope are required on a discover result (spec /schema#discoverresult; SDK 3371 to 3378, 3657 to 3671).
          ttlMs: 1000,
          cacheScope: 'private',
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
