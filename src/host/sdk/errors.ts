// The protocol errors of the SDK, by what the callers do with them: ask, read the code, compare with a code, show the text.
// A link on the v2 client raises `ProtocolError` (a code that a server answered) and `SdkError` (a timeout, a closed
// connection); a link on the v1 client raises `McpError` for all of these. The host sees one shape and one text.
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'

/** The codes of a protocol error that the host reads. */
export const PROTOCOL_CODES = { RequestTimeout: ErrorCode.RequestTimeout } as const

/** What the host reads of a protocol error, from either SDK. */
export type ProtocolFailure = { readonly code: number; readonly data?: unknown }

/** The code that the v1 SDK gave to what the v2 SDK reports as an `SdkError`, or undefined when v1 had no such code. */
const legacyCode = (code: SdkErrorCode): number | undefined =>
  code === SdkErrorCode.RequestTimeout
    ? ErrorCode.RequestTimeout
    : code === SdkErrorCode.ConnectionClosed
      ? ErrorCode.ConnectionClosed
      : undefined

/** The code and data of an error that the protocol layer raised or that a server answered with a code. */
export const protocolFailure = (err: unknown): ProtocolFailure | undefined => {
  if (err instanceof McpError || err instanceof ProtocolError) return { code: err.code, data: err.data }
  if (err instanceof SdkError) {
    const code = legacyCode(err.code)
    return code === undefined ? undefined : { code, data: err.data }
  }
  return undefined
}

/** The code of a protocol error, or undefined for any other error. */
export const protocolCode = (err: unknown): number | undefined => protocolFailure(err)?.code

/**
 * The text of an error of a link, as the v1 SDK wrote it: `MCP error <code>: <message>` for a protocol error. A model
 * and a person read this text, so it stays the same whichever SDK raised the error.
 */
export const sdkErrorText = (err: unknown): string => {
  if (err instanceof ProtocolError) return `MCP error ${err.code}: ${err.message}`
  if (err instanceof SdkError) {
    const code = legacyCode(err.code)
    return code === undefined ? err.message : `MCP error ${code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
