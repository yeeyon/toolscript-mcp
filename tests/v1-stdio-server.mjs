// A stdio MCP server built with SDK v1 (tests/sdk-v1.mjs), the old kind of downstream server that tests/downstream.test.ts
// connects to (#154, gate G4). One tool, `ping`, answers "pong".
//
//   node tests/v1-stdio-server.mjs
import { McpServer, StdioServerTransport } from './sdk-v1.mjs'

const mcp = new McpServer({ name: 'v1-stdio', version: '1.0.0' })
mcp.registerTool('ping', { description: 'Ping.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
await mcp.connect(new StdioServerTransport())
