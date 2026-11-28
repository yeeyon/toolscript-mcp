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
export type ListedTool = {
  readonly name: string
  readonly description?: string
  readonly inputSchema: object
  readonly outputSchema?: object
  readonly annotations?: object
  readonly _meta?: object
}
export type ListedTools = { readonly tools: readonly ListedTool[] }

/** A deep, mutable copy of a plain value: what the wire carries (a key whose value is undefined is not in it). */
const plain = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(plain)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, plain(v)]),
        )
      : value

/** An object of a tool, copied. Its fields are the table's, so the schema of `ListToolsResult` types them as it checks them. */
const plainObject = (value: object): Record<string, unknown> => plain(value) as Record<string, unknown>

/** The tools of a handler as the v2 `tools/list` result, field by field, in the order of the first SDK's wire (the bytes are pinned). */
export const toToolList = (listed: ListedTools): ListToolsResult => ({
  tools: listed.tools.map(t => ({
    name: t.name,
    ...(t.description !== undefined && { description: t.description }),
    inputSchema: { ...plainObject(t.inputSchema), type: 'object' as const },
    ...(t.outputSchema !== undefined && { outputSchema: { ...plainObject(t.outputSchema), type: 'object' as const } }),
    ...(t.annotations !== undefined && { annotations: plainObject(t.annotations) }),
    ...(t._meta !== undefined && { _meta: plainObject(t._meta) }),
  })),
})

/** Answers `tools/list`. */
export const onListTools = (target: Server, handler: () => ListedTools): void =>
  target.setRequestHandler('tools/list', (): ListToolsResult => toToolList(handler()))

/** Answers `tools/call`. */
export const onCallTool = (
  target: Server,
  handler: (request: CallToolRequest, extra: CallExtra) => CallToolResult | Promise<CallToolResult>,
): void =>
  target.setRequestHandler('tools/call', (request, ctx) =>
    handler(request, { signal: ctx.mcpReq.signal, requestId: ctx.mcpReq.id }),
  )
