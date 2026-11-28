// The protocol errors of the SDK, by what the callers do with them: ask, read the code, compare with a code.
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/** The codes of a protocol error that the host reads. */
export const PROTOCOL_CODES = { RequestTimeout: ErrorCode.RequestTimeout } as const

/** True for an error that the protocol layer raised, or that a server answered with a code. */
export const isProtocolError = (err: unknown): err is McpError => err instanceof McpError

/** The code of a protocol error, or undefined for any other error. */
export const protocolCode = (err: unknown): number | undefined => (err instanceof McpError ? err.code : undefined)
