// The transports and the line codec of the SDK. Only src/host/sdk/ imports the SDK (tests/code.check.mjs).
export { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
export { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
export { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
export type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
export type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
