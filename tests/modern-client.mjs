// A raw MCP client in plain JSON-RPC (no SDK), for the conformance tests of the 2026-07-28 revision (issue #154, C0).
// It speaks to a stdio peer through a transport: a spawned process (`spawnPeer`) or a stream pair (`streamTransport`).
// Every wait ends at a deadline (a timer that is cleared when the wait ends), never at a fixed sleep.

import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const MODERN = '2026-07-28'
export const LEGACY = '2025-06-18'
const KEY = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
}
export const CLIENT_INFO = { name: 'raw-client', version: '0.0.1' }
/** The client capabilities of the Claude Code openings: the tasks extension only (the id is as the S0 probe note gives it, not checked here). */
export const CLAUDE_CODE_CAPABILITIES = { extensions: { 'io.modelcontextprotocol/tasks': {} } }

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modern-server.mjs')
const DEFAULT_MS = 5000

/** Runs `promise` with a deadline: rejects with `label` when it is not settled in `ms`. The timer is cleared at once. */
export const within = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms)
    promise.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })

// The processes that this file spawned: `killAll` ends them, and the process exit does too.
const children = new Set()
process.on('exit', () => {
  for (const child of children) child.kill()
})

/** Ends every process that `spawnPeer` started, and waits for each to be gone. */
export const killAll = async () => {
  const all = [...children]
  await Promise.all(
    all.map(
      child =>
        new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve()
          child.once('exit', () => resolve())
          child.kill()
        }),
    ),
  )
  children.clear()
}

/** The number of spawned processes that are still alive. */
export const aliveCount = () => [...children].filter(c => c.exitCode === null && c.signalCode === null).length

/** A transport over a readable and a writable stream of JSON lines. */
export const streamTransport = (readable, writable) => {
  const t = { onMessage: () => {}, onClose: () => {}, raw: [] }
  const rl = readline.createInterface({ input: readable })
  rl.on('line', line => {
    t.raw.push(line)
    try {
      t.onMessage(JSON.parse(line))
    } catch {
      // a line that is not JSON stays in `raw`
    }
  })
  rl.on('close', () => t.onClose())
  t.send = message => writable.write(`${JSON.stringify(message)}\n`)
  t.close = () => writable.end()
  return t
}

/** Spawns `tests/modern-server.mjs <kind> [arg]` and gives its transport: `{ child, transport }`. */
export const spawnPeer = (kind, arg) => {
  const child = spawn(process.execPath, [SERVER, kind, ...(arg === undefined ? [] : [String(arg)])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  child.stdin.on('error', () => {})
  child.stderr.resume()
  const transport = streamTransport(child.stdout, child.stdin)
  transport.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, transport }
}

/** A client over a transport. */
export const createClient = (transport, { capabilities = {}, timeoutMs = DEFAULT_MS } = {}) => {
  let nextId = 1
  const pending = new Map()
  const waiters = new Set()
  const messages = []
  let closed = false
  const closedPromise = new Promise(resolve => {
    transport.onClose = () => {
      closed = true
      for (const { reject } of pending.values()) reject(new Error('the connection closed'))
      pending.clear()
      resolve()
      for (const w of [...waiters]) w()
    }
  })
  transport.onMessage = message => {
    messages.push(message)
    if (message.id !== undefined && message.method === undefined && pending.has(message.id)) {
      pending.get(message.id).resolve(message)
      pending.delete(message.id)
    }
    for (const w of [...waiters]) w()
  }

  const envelope = (meta = {}) => ({
    [KEY.version]: MODERN,
    [KEY.clientInfo]: CLIENT_INFO,
    [KEY.capabilities]: capabilities,
    ...meta,
  })

  const client = {
    transport,
    /** Every message that came from the peer, in order. */
    messages,
    closed: closedPromise,
    isClosed: () => closed,
    /** A message without an id (a notification of the peer), for each one that `predicate` accepts. */
    notifications: predicate => messages.filter(m => m.id === undefined && (predicate?.(m) ?? true)),
    /** Waits until `predicate` is true after a message or a close; rejects at the deadline. */
    waitUntil: (predicate, ms = timeoutMs, label = 'condition') =>
      within(
        new Promise(resolve => {
          const check = () => {
            if (!predicate()) return
            waiters.delete(check)
            resolve()
          }
          if (predicate()) return resolve()
          waiters.add(check)
        }),
        ms,
        label,
      ),
    /** A request with the 2026-07-28 envelope in params._meta. `legacy: true` sends the params as given, with no envelope. */
    request: (method, params, opts) => client.start(method, params, opts).answer,
    /** Sends a request and gives `{ id, answer }` at once, so a test can cancel it by its id. */
    start: (method, params = {}, { legacy = false, meta, ms = timeoutMs } = {}) => {
      const id = nextId++
      const body = legacy ? params : { ...params, _meta: envelope({ ...(params._meta ?? {}), ...(meta ?? {}) }) }
      const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      transport.send({ jsonrpc: '2.0', id, method, params: body })
      const answer = within(reply, ms, `the answer to ${method}`).finally(() => pending.delete(id))
      answer.catch(() => {})
      return { id, answer }
    },
    notify: (method, params) => transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
    discover: opts => client.request('server/discover', {}, opts),
    legacyRequest: (method, params = {}, opts) => client.request(method, params, { ...opts, legacy: true }),
    /** A 2025 opening: `initialize`, then `notifications/initialized`. Resolves with the answer of `initialize`. */
    legacyOpen: async (version = LEGACY) => {
      const answer = await client.legacyRequest('initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })
      if (answer.error === undefined) client.notify('notifications/initialized')
      return answer
    },
    /**
     * Opens a stream: `subscriptions/listen` with `filter` (default: the tool list). Resolves when the first message of the
     * stream (the acknowledged notification, or an error) came, with `{ id, ack, error, notifications() }`.
     */
    listen: async (filter = { toolsListChanged: true }, { ms = timeoutMs, meta } = {}) => {
      const id = nextId++
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      answer.catch(() => {})
      transport.send({
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params: { notifications: filter, _meta: envelope(meta) },
      })
      const stamp = m => m.params?._meta?.['io.modelcontextprotocol/subscriptionId']
      const stream = () => messages.filter(m => m.method !== undefined && stamp(m) === id)
      let error
      void answer.then(
        m => {
          error = m.error ?? m.result
        },
        () => {},
      )
      await client.waitUntil(() => stream().length > 0 || error !== undefined, ms, 'the first message of the stream')
      const ack = stream().find(m => m.method === 'notifications/subscriptions/acknowledged')
      return { id, ack, error, notifications: () => stream().filter(m => m !== ack) }
    },
    /** `notifications/cancelled` for the request `id`. */
    cancel: (id, reason = 'test') => client.notify('notifications/cancelled', { requestId: id, reason }),
    close: () => transport.close(),
  }
  return client
}

/** A client over a new peer process. */
export const connectPeer = (kind, arg, options) => {
  const { child, transport } = spawnPeer(kind, arg)
  const client = createClient(transport, options)
  return Object.assign(client, {
    child,
    /** A control line: the tool list changes. */
    control: (control, name) => transport.send({ control, ...(name === undefined ? {} : { name }) }),
    exited: transport.exited,
  })
}

// The openings, as data. A step is { conn, method, notify?, legacy?, open?, close? }: it runs on connection `conn` (a new
// peer process for each number), in order. `legacy` sends the params with no envelope, `open` opens a stream, `close` ends a
// connection (its stdin; the peer ends with it). The params of a step are the ones that a client of that kind sends.
const initialize = { protocolVersion: LEGACY, capabilities: {}, clientInfo: CLIENT_INFO }
export const OPENINGS = {
  legacy: [
    { conn: 0, method: 'initialize', legacy: true, params: initialize },
    { conn: 0, method: 'notifications/initialized', notify: true },
    { conn: 0, method: 'tools/list', legacy: true },
  ],
  modern: [
    { conn: 0, method: 'server/discover' },
    { conn: 0, method: 'tools/list' },
  ],
  // One connection: the probe, then (as a client that fell back) the 2025 opening on the same process.
  'probe-then-initialize': [
    { conn: 0, method: 'server/discover' },
    { conn: 0, method: 'initialize', legacy: true, params: initialize },
    { conn: 0, method: 'notifications/initialized', notify: true },
    { conn: 0, method: 'tools/list', legacy: true },
  ],
  // As client 2.4.0 does for its own stdio transport (public-CvV4ZHkX.mjs:2506 to 2517): the probe runs on a sibling process
  // that is ended, and the session starts on a new one.
  'probe-sibling': [
    { conn: 0, method: 'server/discover' },
    { conn: 0, close: true },
    { conn: 1, method: 'initialize', legacy: true, params: initialize },
    { conn: 1, method: 'notifications/initialized', notify: true },
    { conn: 1, method: 'tools/list', legacy: true },
  ],
  // The order that Claude Code 2.1.332 sent in the S0 probe, with the tasks extension as its only capability.
  'claude-code-auto': [
    { conn: 0, method: 'server/discover', capabilities: CLAUDE_CODE_CAPABILITIES },
    { conn: 0, method: 'subscriptions/listen', open: true, capabilities: CLAUDE_CODE_CAPABILITIES },
    { conn: 0, method: 'server/discover', capabilities: CLAUDE_CODE_CAPABILITIES },
    { conn: 0, method: 'resources/list', capabilities: CLAUDE_CODE_CAPABILITIES },
  ],
  'claude-code-legacy': [
    { conn: 0, method: 'initialize', legacy: true, params: { ...initialize, capabilities: CLAUDE_CODE_CAPABILITIES } },
    { conn: 0, method: 'notifications/initialized', notify: true },
    { conn: 0, method: 'resources/list', legacy: true },
  ],
}

// A step that names client capabilities overrides those of the client for its request.
const capabilityMeta = step => (step.capabilities === undefined ? undefined : { [KEY.capabilities]: step.capabilities })

/**
 * Replays an opening: `connect(n)` gives the client for connection `n` (called once for each n, in order of first use). Resolves
 * with `[{ conn, method, reply }]`: the answer message of a request, the stream (`listen` result) of an `open` step, and
 * undefined for a notification or a close. A request that fails (no answer at the deadline, or the connection closed) gives `reply: { failed: true, error }`.
 */
export const replay = async (opening, connect) => {
  const clients = new Map()
  const clientOf = n => {
    if (!clients.has(n)) clients.set(n, connect(n))
    return clients.get(n)
  }
  const out = []
  for (const step of opening) {
    const client = clientOf(step.conn)
    if (step.close) {
      client.close()
      out.push({ conn: step.conn, method: 'close', reply: undefined })
      continue
    }
    if (step.notify) {
      client.notify(step.method, step.params)
      out.push({ conn: step.conn, method: step.method, reply: undefined })
      continue
    }
    if (step.open) {
      out.push({
        conn: step.conn,
        method: step.method,
        reply: await client.listen(undefined, { meta: capabilityMeta(step) }),
      })
      continue
    }
    const reply = await (
      step.legacy
        ? client.legacyRequest(step.method, step.params ?? {})
        : client.request(step.method, step.params ?? {}, { meta: capabilityMeta(step) })
    ).catch(error => ({ failed: true, error: String(error.message) }))
    out.push({ conn: step.conn, method: step.method, reply })
  }
  return out
}
