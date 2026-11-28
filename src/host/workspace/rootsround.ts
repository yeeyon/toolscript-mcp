// The roots round of a 2026-07-28 connection (issue #154, P3-2). That era has no `roots/list` push, so the first call that needs the
// Workspace answers `input_required` with a roots request, and the retry carries the roots. `round` decides what a call does:
// go on, be asked (a state is minted for it), or be refused (its state is not a good one). It reads no file and calls no client.
//
//  - Asked only when the request's own envelope declares `roots`. A client that declares none has no Workspace on the connection.
//  - A retry settles the list of the process, one time: the first answer stays. A retry with no usable `roots` entry (none, an error,
//    another shape) takes the Workspace off for the process, and so does a third call after two roots requests with no retry that
//    held a good state. Off means: the bind of the Workspace refuses (never the bound root), and the call goes on without it.
//  - One fixed line on stderr says it, once, and carries no text of the client.

import { LIMITS } from '../../core/workspace.ts'
import type { Roots } from './roots.ts'
import { createRootsState, type RootsState } from './rootsstate.ts'

/** The roots requests that go unanswered before the Workspace is off for the process. */
export const ROOTS_ASKS_MAX = 2

export const NO_WORKSPACE_LINE = 'Workspace: this connection has no Workspace, because the client gave no roots'

export type Step =
  | { readonly kind: 'go' }
  | { readonly kind: 'ask'; readonly state: string }
  /** The state of the retry is not a good one: the call is refused with the fixed -32602 and nothing settles. */
  | { readonly kind: 'refused' }

/** What the round reads of a call: the client data that `CallExtra` of `sdk/server.ts` carries. All of it is untrusted. */
export type Presented = {
  readonly capabilities?: unknown
  readonly inputResponses?: Record<string, unknown>
  readonly requestState?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** True when the capabilities of the request declare `roots`. */
export const declaresRoots = (capabilities: unknown): boolean => isObj(capabilities) && isObj(capabilities['roots'])

/** The `uri` of each root of an answer, or undefined when the entry is not a roots result (a list under `roots`). */
export const urisOf = (entry: unknown): readonly string[] | undefined => {
  if (!isObj(entry) || !Object.hasOwn(entry, 'roots') || !Array.isArray(entry['roots'])) return undefined
  return entry['roots'].flatMap(root => (isObj(root) && typeof root['uri'] === 'string' ? [root['uri']] : []))
}

export type RootsRound = {
  readonly round: (tool: string, args: unknown, presented: Presented) => Step
}

export const createRootsRound = ({
  roots,
  log,
  state = createRootsState(),
}: {
  readonly roots: Pick<Roots, 'isSettled' | 'answer' | 'modern'>
  readonly log: (line: string) => void
  readonly state?: RootsState
}): RootsRound => {
  let asked = 0
  let said = false
  const off = (): Step => {
    if (!said) {
      said = true
      log(NO_WORKSPACE_LINE)
    }
    roots.modern()
    return { kind: 'go' }
  }
  return {
    round: (tool, args, presented) => {
      if (presented.requestState !== undefined) {
        const outcome = state.take(presented.requestState, tool, args)
        if (outcome !== 'ok') {
          log(`Workspace: a roots state was refused (${outcome})`)
          return { kind: 'refused' }
        }
        asked = 0
        if (roots.isSettled()) return { kind: 'go' }
        const uris = urisOf(presented.inputResponses?.['roots'])
        if (uris === undefined) return off()
        roots.answer(uris.slice(0, LIMITS.roots))
        return { kind: 'go' }
      }
      if (roots.isSettled()) return { kind: 'go' }
      if (asked >= ROOTS_ASKS_MAX || !declaresRoots(presented.capabilities)) return off()
      asked++
      return { kind: 'ask', state: state.mint(tool, args) }
    },
  }
}
