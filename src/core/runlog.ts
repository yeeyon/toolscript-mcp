// The run log: one JSON line per run_code call, so a person can see what the
// programs did. A line holds tool names, decisions, times and short codes. It
// never holds an argument, a result, program text or a message from a server,
// because any of them can hold data. The host writes the file; this file shapes
// a line, decides when the file rotates, and reads the lines back for
// `toolscript-mcp runs`.

import { decide, type Bridges, type Policy } from './policy.ts'
import { isCallable, splitToolName } from './protocol.ts'
import { SERVER_NAME } from './tools.ts'

const RUN_ENDINGS = ['done', 'error', 'timeout', 'refused', 'cancelled', 'failed'] as const
/** How a run ended. `refused`: it never started. `failed`: the sandbox gave no answer. */
export type RunEnding = (typeof RUN_ENDINGS)[number]

const CALL_DECISIONS = ['allow', 'ask-approved', 'denied', 'unapproved', 'invalid'] as const
/** What the policy and the approval said of one nested call. `invalid`: not an MCP tool name, or one its connected server does not list. */
export type CallDecision = (typeof CALL_DECISIONS)[number]

const CALL_ERRORS = [
  ...CALL_DECISIONS,
  'no-server',
  'tool-error',
  'timeout',
  'cancelled',
  'failed',
  'unfinished',
] as const
/** Why a nested call did not work, as a short code. */
export type CallError = (typeof CALL_ERRORS)[number]

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

/**
 * The decision of the policy for one nested call, with the tools the person
 * approved for this run. A tool in `interactive` needs the person also under an allow rule.
 */
export const callDecision = (
  policy: Policy,
  bridges: Bridges,
  approved: ReadonlySet<string>,
  tool: string,
  interactive: ReadonlySet<string>,
): CallDecision => {
  if (!isCallable(tool, SERVER_NAME) || splitToolName(tool) === undefined) return 'invalid'
  const { action } = decide(policy, bridges, tool)
  if (action === 'deny') return 'denied'
  if (approved.has(tool)) return 'ask-approved'
  return action === 'allow' && !interactive.has(tool) ? 'allow' : 'unapproved'
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
  /**
   * The tool names of the servers connected before or after the run. A program
   * can build any other name, and a name can hold data.
   */
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v)
// A control character in a printed name could move the cursor or fake a line.
const isText = (v: unknown): v is string => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const parseCall = (v: unknown): CallLog | undefined => {
  if (!isObject(v) || !isText(v.tool) || !oneOf(CALL_DECISIONS, v.decision) || !isCount(v.ms)) return undefined
  if (typeof v.ok !== 'boolean' || (v.error !== undefined && !oneOf(CALL_ERRORS, v.error))) return undefined
  return {
    tool: v.tool,
    decision: v.decision,
    ms: v.ms,
    ok: v.ok,
    ...(v.error === undefined ? {} : { error: v.error }),
  }
}

/** A line of the run log as a record, or undefined when it is not one. Anyone who can write the file can change it. */
export const parseRunLine = (line: string): RunRecord | undefined => {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(v) || !isText(v.time) || !isText(v.id) || !isCount(v.ms) || !oneOf(RUN_ENDINGS, v.ending))
    return undefined
  if (!isCount(v.chars) || !Array.isArray(v.calls) || (v.omitted !== undefined && !isCount(v.omitted))) return undefined
  const calls: CallLog[] = []
  for (const raw of v.calls) {
    const call = parseCall(raw)
    if (call === undefined) return undefined
    calls.push(call)
  }
  const { time, id, ms, ending, chars, omitted } = v
  return { time, id, ms, ending, chars, calls, ...(omitted === undefined ? {} : { omitted }) }
}

/** The next step for each code of a failed call. `tools` is the command that checks one server. */
const CALL_FIXES: Record<CallError, ((server: string, tools: (server: string) => string) => string) | undefined> = {
  allow: undefined,
  'ask-approved': undefined,
  'no-server': (server, tools) =>
    `no-server: the server did not connect. Run \`${tools(server)}\` to see the connection or login problem.`,
  denied: () => 'denied: a deny rule of the policy matches the tool. The policy decides: setup does not override it.',
  unapproved: () =>
    'unapproved: approve the tool in the prompt, or add an allow rule with its exact name. A tool that needs a person each run needs the prompt.',
  invalid: () =>
    'invalid: the tool name is wrong, or its server does not list it. Find the listed name with search_tools.',
  'tool-error': () => 'tool-error: the server returned an error. Check the arguments of the call.',
  timeout: () => 'timeout: the call got no answer within sandbox.callTimeoutSeconds.',
  cancelled: () => 'cancelled: the run stopped before the call ended.',
  failed: () => 'failed: toolscript-mcp could not complete the call.',
  unfinished: () => 'unfinished: the program ended before the call answered. Await each call.',
}

/** The next step for each ending of a run that did not work. */
const ENDING_FIXES: Record<RunEnding, string | undefined> = {
  done: undefined,
  error: 'error: the program threw an error. Read it in the run_code result.',
  timeout: 'timeout: the run passed sandbox.timeoutSeconds. Do less in one run, or raise the limit.',
  refused:
    'refused: the program did not start. A call code says why. A call without a code had a server that was not connected, or arguments that did not fit.',
  cancelled: 'cancelled: the client cancelled the run.',
  failed: 'failed: the sandbox gave no answer. Read the stderr of toolscript-mcp in the log of the client.',
}

/** What `toolscript-mcp runs` prints, and true when the newest run that it shows worked. */
export type RunsReport = { readonly lines: readonly string[]; readonly ok: boolean }

/**
 * The newest `last` records with a call of `server` (any record without one), newest first, then the next step for
 * each distinct problem. `ok`: the newest ended done and each of its calls of `server` worked.
 */
export const runsReport = (
  records: readonly RunRecord[],
  server: string | undefined,
  last: number,
  tools: (server: string) => string,
): RunsReport => {
  const serverOf = (call: CallLog) => splitToolName(call.tool)?.server
  const counts = (call: CallLog) => server === undefined || serverOf(call) === server
  const shown = records
    .filter(r => server === undefined || r.calls.some(counts))
    .slice(-last)
    .reverse()
  const newest = shown[0]
  if (newest === undefined) return { lines: ['no run yet'], ok: false }
  const lines = shown.flatMap(r => [
    `${r.time} ${r.ending} ${r.ms} ms`,
    ...r.calls.map(c => `  ${c.tool} ${c.decision} ${c.ok ? 'ok' : (c.error ?? 'not-run')}`),
    ...(r.omitted === undefined ? [] : [`  ${r.omitted} more calls`]),
  ])
  const fixes = shown.flatMap(r => {
    const calls = r.calls.map(c =>
      counts(c) && !c.ok && c.error !== undefined ? CALL_FIXES[c.error]?.(serverOf(c) ?? '<server>', tools) : undefined,
    )
    return [...calls, ENDING_FIXES[r.ending]].filter(fix => fix !== undefined)
  })
  const ok = newest.ending === 'done' && newest.calls.filter(counts).every(c => c.ok)
  return { lines: [...lines, ...new Set(fixes)], ok }
}
