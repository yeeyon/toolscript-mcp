// The upstream wiring of `TOOLSCRIPT_PROTOCOL=auto` (issue #154, PR 13): `serveStdio` picks the era of a connection from the
// opening exchange, and calls the factory below for a `server/discover` probe and again for the connection (it throws the
// probe instance away when the client falls back to `initialize`). So the factory only makes an instance: the state of the
// process is made one time, before it, in `createHost` (src/host/server.ts).

import { serveStdio, type HostServer, type Transport } from './sdk/server.ts'
import type { Host } from './server.ts'

export type ServeOptions = {
  /** Called for the instance of a legacy connection, before it connects: the roots of the client are asked there. */
  readonly attachRoots?: (server: HostServer) => void
  /** A line for the log: out-of-band errors of the SDK entry, one bounded line each (`sdkLine`). */
  readonly log: (line: string) => void
  /** Tests only: a transport in place of the stdio of the process. */
  readonly transport?: Transport
}

/** Serves the connection on stdio with both eras. Gives the handle that ends it. */
export const serveBoth = (
  host: Pick<Host, 'make'>,
  { attachRoots, log, transport }: ServeOptions,
): { close: () => Promise<void> } =>
  serveStdio(
    ({ era }) => {
      const instance = host.make(era)
      if (era === 'legacy') attachRoots?.(instance)
      return instance
    },
    { legacy: 'serve', ...(transport !== undefined && { transport }), onerror: err => log(sdkLine(err)) },
  )

/** The most characters of a line of the SDK entry in the log. */
export const SDK_LINE_MAX = 160

const blank = (ch: string): string => {
  const code = ch.codePointAt(0) ?? 0
  // The C0 and C1 controls, and the two line separators of Unicode.
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : ch
}

/**
 * One bounded line for an out-of-band error of the SDK entry: its name and the first line of its message, with the control
 * characters taken out and at most SDK_LINE_MAX characters. The message can hold text that the client chose (a protocol version,
 * the keys of a message that is not JSON-RPC), and a validation error can span many lines: only the first line is kept.
 */
export const sdkLine = (err: unknown): string => {
  const name = err instanceof Error && err.name !== '' ? err.name : 'Error'
  const message = err instanceof Error ? err.message : String(err)
  const first = [...(message.split(/\r?\n/, 1)[0] ?? '')].map(blank).join('')
  return `[mcp-sdk] ${name}: ${first}`.slice(0, SDK_LINE_MAX)
}
