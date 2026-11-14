// The run log: one JSON line per run_code call, so a person can see what the
// programs did. A line holds tool names, decisions, times and short codes. It
// never holds an argument, a result, program text or a message from a server,
// because any of them can hold data. The host writes the file; this file shapes
// a line and decides when the file rotates.

import { decide, type Policy } from './policy.ts'
import { isCallable, splitToolName } from './protocol.ts'
import { SERVER_NAME } from './tools.ts'

/** How a run ended. `refused`: it never started. `failed`: the sandbox gave no answer. */
export type RunEnding = 'done' | 'error' | 'timeout' | 'refused' | 'cancelled' | 'failed'

/** What the policy and the approval said of one nested call. `invalid`: not an MCP tool name. */
export type CallDecision = 'allow' | 'ask-approved' | 'denied' | 'unapproved' | 'invalid'

/** Why a nested call did not work, as a short code. */
export type CallError = CallDecision | 'no-server' | 'tool-error' | 'timeout' | 'cancelled' | 'failed' | 'unfinished'

export type CallLog = {
  readonly tool: string
  readonly decision: CallDecision
  readonly ms: number
  readonly ok: boolean
  readonly error?: CallError
}

export type RunRecord = {
  readonly time: string
  readonly id: string
  readonly ms: number
  readonly ending: RunEnding
  /** The length of the text that the model got. */
  readonly chars: number
  readonly calls: readonly CallLog[]
  /** Calls past MAX_CALLS that the line does not list. */
  readonly omitted?: number
}

/** The decision of the policy for one nested call, with the tools the person approved for this run. */
export const callDecision = (policy: Policy, approved: ReadonlySet<string>, tool: string): CallDecision => {
  if (!isCallable(tool, SERVER_NAME) || splitToolName(tool) === undefined) return 'invalid'
  const { action } = decide(policy, tool)
  if (action === 'allow') return 'allow'
  if (action === 'deny') return 'denied'
  return approved.has(tool) ? 'ask-approved' : 'unapproved'
}

export const MAX_CALLS = 200
export const MAX_LOG_BYTES = 5 * 1024 * 1024

export type RunInput = {
  readonly now: Date
  readonly id: string
  readonly ms: number
  readonly ending: RunEnding
  readonly chars: number
  readonly calls: readonly CallLog[]
  /** The tool names of the servers connected before or after the run. A program can build any other name, and a name can hold data. */
  readonly known: ReadonlySet<string>
}

export const runRecord = (input: RunInput): RunRecord => {
  // Each field is copied by name: a stray field of an input never reaches the line.
  const calls = input.calls.slice(0, MAX_CALLS).map(
    (c): CallLog => ({
      tool: input.known.has(c.tool) ? c.tool : 'unknown',
      decision: c.decision,
      ms: Math.round(c.ms),
      ok: c.ok,
      ...(c.error === undefined ? {} : { error: c.error }),
    }),
  )
  const omitted = input.calls.length - calls.length
  return {
    time: input.now.toISOString(),
    id: input.id,
    ms: Math.round(input.ms),
    ending: input.ending,
    chars: input.chars,
    calls,
    ...(omitted > 0 ? { omitted } : {}),
  }
}

export const runLine = (record: RunRecord): string => `${JSON.stringify(record)}\n`

/** True when the file must move to the old name before a line of `add` bytes goes in. */
export const rotates = (size: number, add: number, max = MAX_LOG_BYTES): boolean => size > 0 && size + add > max
