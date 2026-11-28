// The SDK server classes, and the two requests that the host answers. The server is on the v2 package in the legacy
// protocol era (issue #154, PR 7): an instance made by hand lists no 2026 revision, so it installs no `server/discover`
// handler and answers that method with -32601, as the first SDK did.
import {
  inputRequired,
  isJSONRPCRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Transport,
  type CallToolRequest,
  type CallToolResult,
  type InputRequiredResult,
  type JSONRPCRequest,
  type ListToolsResult,
  type RequestId,
  type Result,
  type ServerContext,
} from '@modelcontextprotocol/server'

export { Server, inputRequired, ProtocolError, ProtocolErrorCode }
export { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
export type { CallToolResult, InputRequiredResult, Transport } from '@modelcontextprotocol/server'

const BAD_CALL = 'Invalid tools/call request: '

/**
 * The server of a session. The v2 server checks a `tools/call` request before the handler runs and answers a bad one with
 * -32602 and a text that starts with `Invalid tools/call request: `. The first SDK answered -32603 with the issues alone, and a
 * client may read that code or text, so the answer is mapped back here, in the hook that the SDK documents for this.
 */
export class HostServer extends Server {
  /**
   * Called with the method of each request that reaches this instance, before it is handled. The host uses it to see that a
   * modern connection is in use and not only probed: `serveStdio` makes an instance for a `server/discover` probe and
   * throws it away when the client falls back to `initialize`.
   */
  onRequest?: (method: string) => void

  override async connect(transport: Transport): Promise<void> {
    await super.connect(transport)
    const inner = transport.onmessage
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message)) this.onRequest?.(message.method)
      inner?.(message, extra)
    }
  }

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

const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/**
 * What a handler of `tools/call` reads of the request: the cancel signal and the id of the request, and on a 2026-07-28 request
 * the client capabilities of that request's envelope, the `inputResponses` of a retry and its `requestState` string (raw: the host
 * checks it itself). All of the three are client data and untrusted. A 2025 request has none of them.
 */
export type CallExtra = {
  readonly signal: AbortSignal
  readonly requestId: RequestId
  readonly capabilities?: unknown
  readonly inputResponses?: Record<string, unknown>
  readonly requestState?: string
}

/** The tool list that a handler gives: tables with `as const` arrays, which the v2 type of a tool (mutable) does not take. */
export type ListedTools = { readonly tools: readonly { readonly name: string; readonly inputSchema: object }[] }

/** Answers `tools/list`. The list goes through JSON, so the v2 server gets a plain copy of the table, as the wire carries it. */
export const onListTools = (target: Server, handler: () => ListedTools): void =>
  target.setRequestHandler('tools/list', (): ListToolsResult => JSON.parse(JSON.stringify(handler())))

/** Answers `tools/call`. */
export const onCallTool = (
  target: Server,
  handler: (
    request: CallToolRequest,
    extra: CallExtra,
  ) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>,
): void =>
  target.setRequestHandler('tools/call', (request, ctx) => {
    const { envelope, inputResponses } = ctx.mcpReq
    const capabilities = (envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES]
    const state = ctx.mcpReq.requestState<unknown>()
    return handler(request, {
      signal: ctx.mcpReq.signal,
      requestId: ctx.mcpReq.id,
      ...(capabilities !== undefined && { capabilities }),
      ...(inputResponses !== undefined && { inputResponses }),
      ...(typeof state === 'string' && { requestState: state }),
    })
  })
