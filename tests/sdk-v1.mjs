// The SDK v1 peers that stay in the tests (#154, Phase 1 PR 8), as a dev-only dependency with an exact pin. The tests take SDK
// v2 through tests/sdk.mjs; these three users, and only these, take a v1 peer, because the old kind of peer is what the host
// meets in the field:
//  - tests/server.e2e.mjs: a v1 `Client` over stdio against the built server (gate G2: a client that opens with `initialize`
//    lists and calls);
//  - tests/downstream.test.ts: a v1 `McpServer` over stdio as a downstream server, through tests/v1-stdio-server.mjs (gate G4: a
//    real old server kind), and the v1 `Server` and `StreamableHTTPServerTransport` of its two HTTP fakes (the same old kind over HTTP);
//  - tests/fake-oauth.ts: the v1 `McpServer` and `StreamableHTTPServerTransport`, the old HTTP server kind for the OAuth and
//    refresh tests.
// Two more users keep a v1 reference, because the test is about the first SDK itself: tests/codec.test.ts compares the v1 `ReadBuffer`
// with the v2 one, and tests/childenv-child.mjs prints the v1 `getDefaultEnvironment`, the list that src/core/childenv.ts must equal. Plain .mjs: the e2e files run with Node 22.13, which
// loads no .ts file. Re-exports only, under the SDK's own names: no wrapper, no fake, no default option.
export { Client } from '@modelcontextprotocol/sdk/client/index.js'
export { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
export { Server } from '@modelcontextprotocol/sdk/server/index.js'
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
export { ReadBuffer, deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
export { ElicitRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
