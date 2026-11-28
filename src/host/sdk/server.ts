// The SDK server classes, and the two requests that the host answers. The server is on the v2 package in the legacy
// protocol era (issue #154, PR 7): an instance made by hand lists no 2026 revision, so it installs no `server/discover`
// handler and answers that method with -32601, as the first SDK did.
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolRequest,
  type CallToolResult,
  type JSONRPCRequest,
  type ListToolsResult,
  type RequestId,
  type Result,
  type ServerContext,
} from '@modelcontextprotocol/server'

export { Server }
export { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
export type { CallToolResult } from '@modelcontextprotocol/server'

const BAD_CALL = 'Invalid tools/call request: '

/**
 * The server of a session. The v2 server checks a `tools/call` request before the handler runs and answers a bad one with
 * -32602 and a text that starts with `Invalid tools/call request: `. The first SDK answered -32603 with the issues alone, and a
 * client may read that code or text, so the answer is mapped back here, in the hook that the SDK documents for this.
 */
export class HostServer extends Server {
  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
  ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    const wrapped = super._wrapHandler(method, handler)
    return method !== 'tools/call'
      ? wrapped
      : async (request, ctx) => {
          try {
            return await wrapped(request, ctx)
          } catch (err) {
            if (
              err instanceof ProtocolError &&
              err.code === ProtocolErrorCode.InvalidParams &&
              err.message.startsWith(BAD_CALL)
            )
              throw new ProtocolError(ProtocolErrorCode.InternalError, err.message.slice(BAD_CALL.length))
            throw err
          }
        }
  }
}

/** What a handler of `tools/call` reads of the request: the cancel signal and the id of the request. */
export type CallExtra = { readonly signal: AbortSignal; readonly requestId: RequestId }

/** The tool list that a handler gives: tables with `as const` arrays, which the v2 type of a tool (mutable) does not take. */
export type ListedTools = { readonly tools: readonly { readonly name: string; readonly inputSchema: object }[] }

/** Answers `tools/list`. The list goes through JSON, so the v2 server gets a plain copy of the table, as the wire carries it. */
export const onListTools = (target: Server, handler: () => ListedTools): void =>
  target.setRequestHandler('tools/list', (): ListToolsResult => JSON.parse(JSON.stringify(handler())))

/** Answers `tools/call`. */
export const onCallTool = (
  target: Server,
  handler: (request: CallToolRequest, extra: CallExtra) => CallToolResult | Promise<CallToolResult>,
): void =>
  target.setRequestHandler('tools/call', (request, ctx) =>
    handler(request, { signal: ctx.mcpReq.signal, requestId: ctx.mcpReq.id }),
  )
