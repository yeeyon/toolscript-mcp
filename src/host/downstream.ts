// The connections to the downstream MCP servers of the config. All connect in
// parallel. A server that fails is logged to stderr and kept as failed, and
// the others still work.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { DownstreamTool, ServerState } from '../core/catalog.ts'
import { childEnv, redact, type ServerConfig, type ServerKey } from '../core/config.ts'
import { errorText } from '../core/protocol.ts'

/** The time that one server gets for its connect and for each page of its tool list. */
export const CONNECT_TIMEOUT_MS = 30_000

/** A tool list longer than this many pages is cut, so a server cannot page forever. */
const MAX_PAGES = 100

/**
 * The longest time after the start that a search waits for servers still
 * connecting. Later searches answer at once, so a server that hangs costs
 * this wait one time, not on each search.
 */
export const FIRST_WAIT_MS = 10_000

export type Downstream = {
  /**
   * Settles when every server connected or failed, or FIRST_WAIT_MS after the
   * start, whichever comes first. Never rejects.
   */
  readonly settled: Promise<void>
  /** The state of each server now, in config order. */
  states(): readonly ServerState[]
  /** The client of each connected server, for run_code. */
  readonly clients: ReadonlyMap<ServerKey, Client>
  /** Closes every client, connected or still connecting, and so ends every stdio child. */
  close(): Promise<void>
}

/**
 * The transport of one server, and the end of what its stdio child wrote to
 * stderr, as one line. The child's stderr still goes on to ours, as with `inherit`.
 */
const transportOf = (server: ServerConfig): { transport: Transport; lastError: () => string } => {
  if (server.kind === 'http')
    return {
      transport: new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { ...server.headers } },
      }),
      lastError: () => '',
    }
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: childEnv(server),
    stderr: 'pipe',
  })
  let tail = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    tail = (tail + chunk.toString('utf8')).slice(-2000)
  })
  const lastError = () => tail.replace(/\s+/g, ' ').trim().slice(-300)
  return { transport, lastError }
}

const listAll = async (client: Client): Promise<DownstreamTool[]> => {
  const tools: DownstreamTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: CONNECT_TIMEOUT_MS })
    tools.push(...result.tools)
    cursor = result.nextCursor
    if (!cursor) break
  }
  return tools
}

export const connectAll = (
  servers: ReadonlyMap<ServerKey, ServerConfig>,
  version: string,
  log: (line: string) => void,
): Downstream => {
  let closing: Promise<void> | undefined
  const states = new Map<ServerKey, ServerState>([...servers.keys()].map(key => [key, { key, status: 'connecting' }]))
  const clients = new Map<ServerKey, Client>()
  const opened = new Set<Client>()

  const fail = (key: ServerKey, server: ServerConfig, reason: string) => {
    const safe = redact(reason, server)
    log(`${key}: failed: ${safe}`)
    states.set(key, { key, status: 'failed', reason: safe })
    clients.delete(key)
  }

  const connect = async (key: ServerKey, server: ServerConfig): Promise<void> => {
    const client = new Client({ name: 'toolscript-mcp', version })
    opened.add(client)
    const { transport, lastError } = transportOf(server)
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      const tools = await listAll(client)
      clients.set(key, client)
      states.set(key, { key, status: 'connected', tools })
      log(`${key}: connected, ${tools.length} tools`)
      client.onclose = () => {
        if (closing) return
        const stderr = lastError()
        fail(key, server, `the connection closed${stderr === '' ? '' : `. Its stderr ends with: ${stderr}`}`)
      }
    } catch (err) {
      // A child that exits gives only "Connection closed": its stderr says
      // why (on Windows, also for a command that is not found).
      const stderr = lastError()
      fail(key, server, stderr === '' ? errorText(err) : `${errorText(err)}. Its stderr ends with: ${stderr}`)
      await client.close().catch(() => {})
    }
  }

  const ready = Promise.all([...servers].map(([key, server]) => connect(key, server)))
  return {
    settled: Promise.race([ready, new Promise(r => setTimeout(r, FIRST_WAIT_MS).unref())]).then(() => {}),
    states: () => [...states.values()],
    clients,
    close: () => (closing ??= Promise.all([...opened].map(c => c.close().catch(() => {}))).then(() => {})),
  }
}
