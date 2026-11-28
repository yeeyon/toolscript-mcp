// The one place where the tests take the MCP SDK (#154, Phase 1 PR 4). Plain .mjs: the e2e files run with Node 22.13,
// which loads no .ts file. It imports the SDK package itself and never src/host/sdk/: from PR 5 to PR 7 the host moves
// to SDK v2 while these peers stay on v1, so the suite shows that the new host still talks to an old client and an old
// server. PR 8 moves the peers by a change to this file. Re-exports only, under the SDK's own names: no wrapper, no
// fake, no default option.
export { Client } from '@modelcontextprotocol/sdk/client/index.js'
export { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
export { ReadBuffer, deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
export { Server } from '@modelcontextprotocol/sdk/server/index.js'
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
export {
  ElicitRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
// The one name of the v2 client package that a test reads: the line check of SDK v2, which tests/codec.test.ts compares with
// v1's (#154, PR 5). The peers above stay on v1.
export { deserializeMessage as deserializeMessageV2 } from '@modelcontextprotocol/client'
