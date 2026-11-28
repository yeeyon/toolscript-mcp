// The roots of the MCP client (issue #150). The server sends `roots/list` one time, after `notifications/initialized`,
// and only when the client declared the `roots` capability. The answer, an error or `ROOTS_WAIT_MS` settles the list
// one time: a late answer changes nothing, and `notifications/roots/list_changed` has no handler. The list only
// narrows the root of the session (`bindWorkspace`): the provider is bound after the settle, so no call runs on a
// wider root. The entries are untrusted text: `bindWorkspace` proves each one.

import type { Server } from '../sdk/server.ts'
import { LIMITS } from '../../core/workspace.ts'

/** The longest wait for the answer to `roots/list`, counted from `notifications/initialized`. */
export const ROOTS_WAIT_MS = 2_000

/** The longest wait for `notifications/initialized` itself, so a client that never sends it holds no run. */
export const INITIALIZED_WAIT_MS = 10_000

export type Roots = {
  /** The `uri` of at most `LIMITS.roots` client roots, as the client sent them. Empty for no capability, an error or a timeout. */
  readonly read: () => Promise<readonly string[]>
  /** Starts the request when the client has initialized. Call it before `connect`. */
  readonly attach: (server: Server) => void
  /** Settles the list with no root, so a waiting bind ends. */
  readonly close: () => void
}

export const createRoots = ({
  log,
  waitMs = ROOTS_WAIT_MS,
  initializedWaitMs = INITIALIZED_WAIT_MS,
}: {
  readonly log: (line: string) => void
  readonly waitMs?: number
  readonly initializedWaitMs?: number
}): Roots => {
  let settle!: (uris: readonly string[]) => void
  let never: ReturnType<typeof setTimeout> | undefined
  const settled = new Promise<readonly string[]>(resolve => (settle = resolve))
  return {
    read: () => settled,
    close: () => {
      clearTimeout(never)
      settle([])
    },
    attach: server => {
      const closed = server.onclose
      // A client that closes before it answers settles the list, so nothing waits for it.
      server.onclose = () => {
        clearTimeout(never)
        settle([])
        closed?.()
      }
      // A client that never sends `initialized` settles the list too: the wait is bounded whatever the client does.
      let asked = false
      never = setTimeout(() => {
        asked = true
        log('Workspace: the client did not initialize in time, so its roots narrow nothing')
        settle([])
      }, initializedWaitMs)
      never.unref()
      server.oninitialized = () => {
        clearTimeout(never)
        if (asked) return
        asked = true
        if (server.getClientCapabilities()?.roots === undefined) return settle([])
        const ask = new AbortController()
        const timer = setTimeout(() => {
          log('Workspace: the client did not answer roots/list in time, so its roots narrow nothing')
          ask.abort()
          settle([])
        }, waitMs)
        timer.unref()
        server.listRoots(undefined, { signal: ask.signal }).then(
          result => {
            clearTimeout(timer)
            settle(result.roots.slice(0, LIMITS.roots).map(root => root.uri))
          },
          () => {
            clearTimeout(timer)
            if (!ask.signal.aborted) log('Workspace: roots/list failed, so the client roots narrow nothing')
            settle([])
          },
        )
      }
    },
  }
}
