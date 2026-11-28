// The protocol errors of the SDK, by what the callers do with them: ask, read the code, compare with a code, show the text.
// A link on the v2 client raises `ProtocolError` (a code that a server answered) and `SdkError` (a timeout, a closed
// connection); a test double of the first SDK raises `McpError` for all of these. The host sees one shape and one text.
// An HTTP link raises `SdkHttpError` (the status of an answer) and `SdkError` (a content type): the text stays what the
// first SDK wrote, `Streamable HTTP error: <message>`, because a model and a person read it (issue #154, PR 6).
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  AuthorizationServerMismatchError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from '@modelcontextprotocol/client'

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

const RESULT_PREFIX = /^Invalid result for [^:\s]+: /u

/** The HTTP status that an answer of the server gave to a request, or undefined for any other error. */
export const httpStatus = (err: unknown): number | undefined => (err instanceof SdkHttpError ? err.status : undefined)

/** True when the stored client belongs to another authorization server and only a new login can register one. */
export const isBoundElsewhere = (err: unknown): boolean => err instanceof AuthorizationServerMismatchError

/** The messages of the HTTP transport that the first SDK worded another way. */
const httpMessage = (message: string): string =>
  message === 'Server returned 401 after re-authentication'
    ? 'Server returned 401 after successful authentication'
    : message.startsWith('Server returned 403 insufficient_scope after step-up')
      ? 'Server returned 403 after trying upscoping'
      : // The text of a redirect that was not followed: the new SDK adds a hint after the URL.
        message.replace(
          '; use that URL as the endpoint if it is the intended server (redirectPolicy',
          ' (redirectPolicy',
        )

/** The code of a protocol error, or undefined for any other error. */
export const protocolCode = (err: unknown): number | undefined => protocolFailure(err)?.code

/**
 * The text of an error of a link, as the v1 SDK wrote it: `MCP error <code>: <message>` for a protocol error. A model
 * and a person read this text, so it stays the same whichever SDK raised the error.
 */
export const sdkErrorText = (err: unknown): string => {
  if (err instanceof SdkHttpError) return `Streamable HTTP error: ${httpMessage(err.message)}`
  if (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpUnexpectedContent)
    return `Streamable HTTP error: ${err.message}`
  if (err instanceof ProtocolError) return `MCP error ${err.code}: ${err.message}`
  if (err instanceof SdkError) {
    // A result that breaks the result schema: v1 gave the issues of the schema alone, v2 puts the method in front.
    if (err.code === SdkErrorCode.InvalidResult) return err.message.replace(RESULT_PREFIX, '')
    const code = legacyCode(err.code)
    return code === undefined ? err.message : `MCP error ${code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
