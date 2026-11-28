// The one place where the tests take the MCP SDK (#154, Phase 1 PR 8). It imports the SDK v2 packages themselves and never
// src/host/sdk/, so the suite shows a v2 host against v2 peers, written as a user of the package would write them. Re-exports
// only, under the SDK's own names: no wrapper, no fake, no default option. The v1 peers that stay are in tests/sdk-v1.mjs.
export { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
export {
  LATEST_PROTOCOL_VERSION,
  ProtocolError,
  ProtocolErrorCode,
  ReadBuffer,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/client'
export { deserializeMessage, serializeMessage } from '@modelcontextprotocol/client'
export { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
export { McpServer, Server } from '@modelcontextprotocol/server'
