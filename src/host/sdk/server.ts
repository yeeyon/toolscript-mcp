// The SDK server classes, and the two requests that the host answers. The server is on the v2 package in the legacy
// protocol era (issue #154, PR 7): an instance made by hand lists no 2026 revision, so it installs no `server/discover`
// handler and answers that method with -32601, as the first SDK did.
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  isJSONRPCRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Transport,
  type CallToolRequest,
  type InputRequiredResult,
  type CallToolResult,
  type JSONRPCRequest,
  type ListToolsResult,
  type RequestId,
  type Result,
  type ServerContext,
} from '@modelcontextprotocol/server'

export { Server }
export { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
export type { CallToolResult, Transport } from '@modelcontextprotocol/server'

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

/** The context of a request, as the state codec binds it. The host passes it through and reads none of it. */
export type StateContext = ServerContext

/**
 * The seal of the state of an approval (issue #154, P3-1): the codec of the SDK, HMAC-SHA256 with `key` (32 bytes made at process
 * start), valid for `ttlSeconds`, and bound to the method of the request, so a state of one method is no state of another.
 * `verify` goes in `requestState.verify` of the server: a bad state is answered with the fixed -32602 of the SDK.
 */
export const stateCodec = <T>(key: Uint8Array, ttlSeconds: number) =>
  createRequestStateCodec<T>({ key, ttlSeconds, bind: ctx => ctx.mcpReq.method })
export type StateCodec<T> = ReturnType<typeof stateCodec<T>>

/** The answer that the SDK gives to a state that is refused: the same text and data for every reason. */
export const invalidStateError = (): ProtocolError =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid or expired requestState', {
    reason: 'invalid_request_state',
  })

/** What a handler of `tools/call` reads of the request: the cancel signal and the id of the request. */
export type CallExtra = {
  readonly signal: AbortSignal
  readonly requestId: RequestId
  /** The answers of a retried request (`inputResponses`), as the client sent them: untrusted. Absent on a first call. */
  readonly inputResponses?: Readonly<Record<string, unknown>>
  /** The payload of the state of a retried request, after the codec checked its seal and its expiry. Absent on a first call. */
  readonly state?: unknown
  /** The client capabilities of THIS request's envelope (2026-07-28 only), never a value kept from another request. */
  readonly clientCapabilities?: unknown
  /** Seals a payload into a state for the answer to this request. */
  readonly mint: (payload: unknown) => Promise<string>
}

/** What a handler of `tools/call` may answer: a result, or a request for input with a state (2026-07-28 only). */
export type CallAnswer = CallToolResult | InputRequiredResult

/** The answer that asks the person: one elicitation `approve` with an empty form, and the sealed state of the round. */
export const approvalRequest = (message: string, requestState: string): InputRequiredResult =>
  inputRequired({
    inputRequests: { approve: inputRequired.elicit({ message, requestedSchema: { type: 'object', properties: {} } }) },
    requestState,
  })

/** The tool list that a handler gives: tables with `as const` arrays, which the v2 type of a tool (mutable) does not take. */
export type ListedTools = { readonly tools: readonly { readonly name: string; readonly inputSchema: object }[] }

/** Answers `tools/list`. The list goes through JSON, so the v2 server gets a plain copy of the table, as the wire carries it. */
export const onListTools = (target: Server, handler: () => ListedTools): void =>
  target.setRequestHandler('tools/list', (): ListToolsResult => JSON.parse(JSON.stringify(handler())))

/** Answers `tools/call`. `codec` seals the states that the handler mints. */
export const onCallTool = (
  target: Server,
  handler: (request: CallToolRequest, extra: CallExtra) => CallAnswer | Promise<CallAnswer>,
  codec?: StateCodec<unknown>,
): void =>
  target.setRequestHandler('tools/call', (request, ctx) =>
    handler(request, {
      signal: ctx.mcpReq.signal,
      requestId: ctx.mcpReq.id,
      ...(ctx.mcpReq.inputResponses !== undefined && { inputResponses: ctx.mcpReq.inputResponses }),
      ...(ctx.mcpReq.requestState() !== undefined && { state: ctx.mcpReq.requestState() }),
      ...(ctx.mcpReq.envelope !== undefined && {
        clientCapabilities: (ctx.mcpReq.envelope as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY],
      }),
      mint: payload => (codec === undefined ? Promise.reject(new Error('no state codec')) : codec.mint(payload, ctx)),
    }),
  )
