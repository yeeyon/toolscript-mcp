// The transports and the line codec of the SDK. Only src/host/sdk/ imports the SDK (tests/code.check.mjs). Every link is on
// the v2 client package (issue #154, PR 6): its transport types, its HTTP transport, its in-memory pair and its line check.
export { InMemoryTransport, StreamableHTTPClientTransport, deserializeMessage } from '@modelcontextprotocol/client'
export type { FetchLike, JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
