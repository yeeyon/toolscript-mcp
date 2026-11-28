// The transports and the line codec of the SDK. Only src/host/sdk/ imports the SDK (tests/code.check.mjs).
// A stdio, shared or Workspace link is on the v2 client (issue #154, PR 5): its transport types, its in-memory pair and its
// line check are v2's. The HTTP transport stays v1 (its OAuth provider and errors are v1) until PR 6.
export { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
export { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export { InMemoryTransport, deserializeMessage } from '@modelcontextprotocol/client'
export type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
export type { FetchLike, Transport as HttpWireTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
