// The upstream wiring of `TOOLSCRIPT_PROTOCOL=auto` (issue #154, PR 13): `serveStdio` picks the era of a connection from the
// opening exchange, and calls the factory below for a `server/discover` probe and again for the connection (it throws the
// probe instance away when the client falls back to `initialize`). So the factory only makes an instance: the state of the
// process is made one time, before it, in `createHost` (src/host/server.ts).

import { serveStdio, type HostServer, type Transport } from './sdk/server.ts'
import type { Host } from './server.ts'

export type ServeOptions = {
  /** Called for the instance of a legacy connection, before it connects: the roots of the client are asked there. */
  readonly attachRoots?: (server: HostServer) => void
  /** A line for the log: out-of-band errors of the SDK entry. It never carries argument text. */
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
    { legacy: 'serve', ...(transport !== undefined && { transport }), onerror: err => log(`[mcp-sdk] ${err.message}`) },
  )
