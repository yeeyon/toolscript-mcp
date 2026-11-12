// The MCP server that a client starts: it lists the tools in SERVED and
// answers their calls. The schemas come from TOOLS as JSON Schema, so the
// handlers are set on the SDK's underlying Server: McpServer.registerTool
// takes only Zod schemas.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { searchResult } from '../core/catalog.ts'
import { SERVER_INSTRUCTIONS } from '../core/protocol.ts'
import { SEARCH_LIMIT, SERVED, parseInput, registration, type ServedName } from '../core/tools.ts'
import type { Downstream } from './downstream.ts'

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError })

type Handler = (args: object, downstream: Downstream) => Promise<CallToolResult>

const HANDLERS: Record<ServedName, Handler> = {
  search_tools: async (args, downstream) => {
    const { query, limit: asked } = parseInput('search_tools', args)
    const limit = Math.min(100, Math.max(1, asked || SEARCH_LIMIT))
    await downstream.settled
    return text(searchResult(downstream.states(), query, limit))
  },
}

const isServed = (name: string): name is ServedName => (SERVED as readonly string[]).includes(name)

export const createServer = (downstream: Downstream, version: string): McpServer => {
  const mcp = new McpServer(
    { name: 'toolscript-mcp', version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  )
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: SERVED.map(registration) }))
  mcp.server.setRequestHandler(CallToolRequestSchema, req => {
    const { name, arguments: args = {} } = req.params
    return isServed(name) ? HANDLERS[name](args, downstream) : text(`Unknown tool: ${name}`, true)
  })
  return mcp
}
