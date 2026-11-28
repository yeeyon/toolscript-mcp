// A raw node:http fake of an HTTP MCP server for the golden tests of the HTTP link (issue #154, PR 6). It imports no SDK, so
// the texts and the headers that it records depend on no SDK version. The path of a request names the case. The tool list
// is one tool `ok`. `seen` holds each request: method, path, the headers and the body.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type Seen = { method: string; path: string; headers: Record<string, string>; body: string }

/** The authorization server of the fake: its token endpoint gives these tokens for any refresh. */
export const NEW_ACCESS = 'golden-access-2'

const TOOL = { name: 'ok', description: 'ok', inputSchema: { type: 'object', properties: {} } }

export const startGoldenHttp = async () => {
  const seen: Seen[] = []
  const sockets = new Set<import('node:net').Socket>()
  let origin = ''
  let port = 0
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://x')
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]))
    seen.push({ method: req.method ?? '', path: url.pathname, headers, body })
    const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
      void res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(value))
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
    if (url.pathname.startsWith('/.well-known/')) return void res.writeHead(404).end()
    if (url.pathname === '/token')
      return json(200, {
        access_token: NEW_ACCESS,
        token_type: 'Bearer',
        refresh_token: 'golden-refresh-2',
        expires_in: 3600,
      })
    const scenario = url.pathname.slice(1)
    if (req.method === 'GET') return void res.writeHead(405).end()
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    const message = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } }
    const method = message.method ?? ''
    const text = (status: number, content: string, type = 'text/plain') =>
      void res.writeHead(status, { 'content-type': type }).end(content)
    if (scenario.startsWith('401')) return text(401, 'unauthorized golden')
    if (scenario === '403') return text(403, 'forbidden golden')
    if (scenario === '404-nosession') return text(404, 'not found golden')
    if (scenario === '500') return text(500, 'boom golden')
    if (scenario === '503') return text(503, 'busy golden')
    if (scenario === 'redirect') {
      res.writeHead(307, { location: `http://localhost:${port}/ok` }).end()
      return
    }
    if (method === 'initialize') {
      if (scenario === 'html') return text(200, '<html>golden</html>', 'text/html')
      if (scenario === 'badjson') return text(200, 'not json golden', 'application/json')
      return json(
        200,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'golden-http', version: '1' },
          },
        },
        { 'mcp-session-id': 'golden-session' },
      )
    }
    if (message.id === undefined) return void res.writeHead(202).end()
    if (method === 'tools/list') return json(200, { jsonrpc: '2.0', id: message.id, result: { tools: [TOOL] } })
    if (scenario === '404-session') return text(404, 'gone golden')
    if (scenario === '400-unknown') return text(400, 'Bad Request: No valid session ID provided')
    if (scenario === 'die') return void req.socket.destroy()
    if (scenario === 'sse-cut')
      return void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(': golden\n\n')
    return json(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })
  })
  server.on('connection', s => (sockets.add(s), s.on('close', () => sockets.delete(s))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    port,
    seen,
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}

/** A port that nothing listens on. */
export const closedPort = async (): Promise<number> => {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
