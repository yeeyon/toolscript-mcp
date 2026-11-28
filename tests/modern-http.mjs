// A fake MCP server over HTTP in plain JSON-RPC (no SDK), on 127.0.0.1, for the conformance tests (issue #154, C0).
//
//   const server = await startHttp('modern')
//   server.url                 http://127.0.0.1:<port>/mcp
//   server.requests            every request except the control call, in order: { method, path, headers, body, json }
//   await server.waitFor(r => r.json?.method === 'tools/list', 2000)
//   await server.control('add-tool', 'extra')   the tool list changes; an open listen stream is told
//   await server.close()
//
// Kinds:
//   modern        2026-07-28, no session id. Needs mcp-protocol-version, mcp-method and mcp-name (for tools/call) equal to the
//                 body, else HTTP 400 with JSON-RPC error -32020. server/discover, tools/list, tools/call, subscriptions/listen
//                 (an SSE stream: the acknowledged notification, then each list change).
//   legacy        a 2025 stateful session: initialize gives mcp-session-id, every other request needs it (a probe before
//                 initialize gets 400 with a JSON-RPC error -32000, as the SDK server answers).
//   probe-400 | probe-404 | probe-405   the probe (server/discover) gets that plain status, then a legacy session
//   probe-400-rpc the probe gets 400 with a JSON-RPC error body (-32600), then a legacy session
//   probe-401     every request without `authorization: Bearer ...` gets 401 with www-authenticate; with one, a legacy session
//   probe-403 | probe-500 | probe-503   every request gets that status
//   probe-307     every request gets a 307 to another origin (localhost, not 127.0.0.1): a second recording server, `server.other`
//   probe-hang    every request gets 200 headers and a body that never ends
// The record is what the SigV4 and OAuth rows read: the headers of each request are kept as sent, in lower case.

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  changeTools,
  createConn,
  createState,
  fail,
  handleLegacy,
  handleModern,
  HTTP_KINDS,
  KEY,
  MODERN,
  notifyToolsChanged,
  ok,
} from './modern-core.mjs'

const PLAIN = new Map([
  ['probe-400', 400],
  ['probe-404', 404],
  ['probe-405', 405],
])
const ALWAYS = new Map([
  ['probe-403', 403],
  ['probe-500', 500],
  ['probe-503', 503],
])

// The header that mirrors the name of a request in its body (SEP-2243, as the client derives it).
const nameOf = json =>
  json.method === 'tools/call' || json.method === 'prompts/get'
    ? json.params?.name
    : json.method === 'resources/read'
      ? json.params?.uri
      : undefined

/** Starts the server. `kind` is one of the kinds above. */
export const startHttp = async kind => {
  if (!HTTP_KINDS.includes(kind)) throw new Error(`unknown HTTP kind: ${String(kind)}`)
  const state = createState()
  const requests = []
  const sessions = new Map()
  const streams = new Set()
  const sockets = new Set()
  const waiters = new Set()
  const closeWaiters = new Set()

  // The server that a 307 points to (probe-307): another origin that records what reaches it, so a leaked bearer shows.
  const other =
    kind === 'probe-307'
      ? await (async () => {
          const seen = []
          const sockets = new Set()
          const s = http.createServer((req, res) => {
            const chunks = []
            req.on('data', c => chunks.push(c))
            req.on('end', () => {
              seen.push({
                method: req.method,
                path: req.url,
                headers: { ...req.headers },
                body: Buffer.concat(chunks).toString('utf8'),
              })
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end('{}')
            })
          })
          s.on('connection', socket => {
            sockets.add(socket)
            socket.on('close', () => sockets.delete(socket))
          })
          await new Promise(resolve => s.listen(0, '127.0.0.1', resolve))
          return { server: s, sockets, requests: seen, port: s.address().port }
        })()
      : undefined

  const record = (req, body) => {
    let json
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
    const entry = { method: req.method, path: req.url, headers: { ...req.headers }, body, json }
    requests.push(entry)
    for (const w of [...waiters]) w()
    return entry
  }

  const reply = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  // The order of the SDK ladder (client 2.4.0 `dist/src-CeKsbNLO.mjs` 4590 to 4660), for a request: an envelope-less request
  // is -32602 when its protocol-version header names a modern revision (the envelope rung, 4626 to 4632) and -32022 with
  // data.supported otherwise (era classification, 4614 to 4624); a header that disagrees with the envelope, or an mcp-method
  // or mcp-name that disagrees with the body, is -32020 (4650 to 4655); all of them HTTP 400. A notification is exempt from
  // the header rules (the spec defines none for it).
  const modern = (req, res, json) => {
    const header = name => req.headers[name]
    const isRequest = json.id !== undefined
    if (isRequest) {
      const envelope = json.params?._meta?.[KEY.version]
      if (typeof envelope !== 'string') {
        const named = header('mcp-protocol-version')
        return typeof named === 'string' && named >= MODERN
          ? reply(res, 400, fail(json.id, -32602, `Request is missing ${KEY.version} in params._meta`))
          : reply(res, 400, fail(json.id, -32022, 'Unsupported protocol version: no envelope', { supported: [MODERN] }))
      }
      const mismatch =
        header('mcp-protocol-version') !== envelope
          ? 'mcp-protocol-version'
          : header('mcp-method') !== json.method
            ? 'mcp-method'
            : nameOf(json) !== undefined && header('mcp-name') !== nameOf(json)
              ? 'mcp-name'
              : undefined
      if (mismatch !== undefined) {
        return reply(res, 400, fail(json.id, -32020, `Header mismatch: ${mismatch}`))
      }
    }
    if (!isRequest) {
      handleModern(state, createConn(), json, () => {})
      return reply(res, 202, undefined)
    }
    const conn = createConn()
    conn.era = 'modern'
    if (json.method === 'subscriptions/listen') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = message => res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
      const stream = { conn, send }
      streams.add(stream)
      res.on('close', () => streams.delete(stream))
      return handleModern(state, conn, json, send)
    }
    // An answer that comes during the call is sent at once; a slow tool answers later, on the open request.
    let during = true
    let early
    const status = message => (message.error?.code === -32022 ? 400 : 200)
    handleModern(state, conn, json, message => {
      if (during) early = message
      else reply(res, status(message), message)
    })
    during = false
    return early === undefined ? undefined : reply(res, status(early), early)
  }

  const legacy = (req, res, json) => {
    const id = req.headers['mcp-session-id']
    if (json.method === 'initialize') {
      const conn = createConn()
      const sessionId = randomUUID()
      sessions.set(sessionId, conn)
      let answer
      handleLegacy(state, conn, json, m => {
        answer = m
      })
      return reply(res, 200, answer, { 'mcp-session-id': sessionId })
    }
    const conn = typeof id === 'string' ? sessions.get(id) : undefined
    if (conn === undefined) {
      return reply(
        res,
        id === undefined ? 400 : 404,
        fail(null, -32000, id === undefined ? 'Bad Request: Server not initialized' : 'Session not found'),
      )
    }
    if (json.id === undefined) {
      handleLegacy(state, conn, json, () => {})
      return reply(res, 202, undefined)
    }
    handleLegacy(state, conn, json, message => reply(res, 200, message))
    return undefined
  }

  const bearer = req => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ''))

  // A request whose connection closes before its answer is a cancel over HTTP: it is recorded, and its slow timer stops.
  const watchClose = (res, json) => {
    if (json?.id === undefined || json.method === 'subscriptions/listen') return
    res.on('close', () => {
      if (res.writableFinished) return
      state.closedEarly.push({ method: json.method, id: json.id })
      clearTimeout(state.timers.get(json.id))
      state.timers.delete(json.id)
      for (const w of [...closeWaiters]) w()
    })
  }

  const handle = (req, res, body) => {
    const entry = record(req, body)
    const json = entry.json
    watchClose(res, json)
    if (req.method === 'DELETE') {
      sessions.delete(String(req.headers['mcp-session-id']))
      return reply(res, 200, undefined)
    }
    if (req.method !== 'POST' || json === undefined) {
      return reply(res, 405, req.method === 'POST' ? fail(null, -32700, 'Parse error') : undefined, {
        allow: 'POST, DELETE',
      })
    }
    if (kind === 'modern') return modern(req, res, json)
    if (kind === 'legacy') return legacy(req, res, json)
    const status = PLAIN.get(kind)
    if (status !== undefined && json.method === 'server/discover')
      return reply(res, status, 'not a JSON-RPC body', { 'content-type': 'text/plain' })
    if (kind === 'probe-400-rpc' && json.method === 'server/discover')
      return reply(res, 400, fail(json.id ?? null, -32600, 'Invalid request'))
    if (kind === 'probe-401' && !bearer(req)) {
      const url = `http://127.0.0.1:${server.address().port}/.well-known/oauth-protected-resource`
      return reply(res, 401, undefined, { 'www-authenticate': `Bearer resource_metadata="${url}"` })
    }
    const always = ALWAYS.get(kind)
    if (always !== undefined) return reply(res, always, 'not available', { 'content-type': 'text/plain' })
    if (kind === 'probe-307') return reply(res, 307, undefined, { location: `http://localhost:${other.port}/mcp` })
    if (kind === 'probe-hang') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      return undefined
    }
    return legacy(req, res, json)
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/__control') {
        const { control, name } = JSON.parse(body)
        if (changeTools(state, control, name)) {
          notifyToolsChanged([...streams].map(s => s.conn))
        }
        return reply(res, 200, { ok: true })
      }
      // A request outside /mcp (the well-known documents of an OAuth discovery) is recorded too, then not found.
      if (!req.url?.startsWith('/mcp')) {
        record(req, body)
        return reply(res, 404, 'not found', { 'content-type': 'text/plain' })
      }
      handle(req, res, body)
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/mcp`

  return {
    kind,
    port,
    url,
    requests,
    state,
    /** The server that a probe-307 points to, with its own record. */
    other: other === undefined ? undefined : { port: other.port, requests: other.requests },
    /** Resolves with the first recorded request that `predicate` accepts, or rejects at the deadline. */
    waitFor: (predicate, ms = 5000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = requests.find(predicate)
          if (found === undefined) return false
          clearTimeout(timer)
          waiters.delete(check)
          resolve(found)
          return true
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`no request matched within ${ms} ms`))
        }, ms)
        if (!check()) waiters.add(check)
      }),
    /** Resolves with the first request recorded in `state.closedEarly` that `predicate` accepts, or rejects at the deadline. */
    waitClosedEarly: (predicate = () => true, ms = 5000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = state.closedEarly.find(predicate)
          if (found === undefined) return false
          clearTimeout(timer)
          closeWaiters.delete(check)
          resolve(found)
          return true
        }
        const timer = setTimeout(() => {
          closeWaiters.delete(check)
          reject(new Error(`no request closed early within ${ms} ms`))
        }, ms)
        if (!check()) closeWaiters.add(check)
      }),
    control: (control, name) =>
      fetch(`http://127.0.0.1:${port}/__control`, { method: 'POST', body: JSON.stringify({ control, name }) }).then(r =>
        r.text(),
      ),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      for (const socket of other?.sockets ?? []) socket.destroy()
      await Promise.all([
        new Promise(resolve => server.close(resolve)),
        other === undefined ? undefined : new Promise(resolve => other.server.close(resolve)),
      ])
    },
  }
}
