// The SDK server classes, and the two requests that the host answers.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export { Server } from '@modelcontextprotocol/sdk/server/index.js'
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

declare const server: Server
type ListToolsHandler = Parameters<typeof server.setRequestHandler<typeof ListToolsRequestSchema>>[1]
type CallToolHandler = Parameters<typeof server.setRequestHandler<typeof CallToolRequestSchema>>[1]

/** Answers `tools/list`. */
export const onListTools = (target: Server, handler: ListToolsHandler): void =>
  target.setRequestHandler(ListToolsRequestSchema, handler)

/** Answers `tools/call`. */
export const onCallTool = (target: Server, handler: CallToolHandler): void =>
  target.setRequestHandler(CallToolRequestSchema, handler)
