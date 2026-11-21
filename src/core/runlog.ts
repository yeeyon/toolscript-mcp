// The run log: one JSON line per run_code call, so a person can see what the
// programs did. A line holds tool names, decisions, times and short codes. It
// never holds an argument, a result, program text or a message from a server,
// because any of them can hold data. The host writes the file; this file shapes
// a line, decides when the file rotates, and reads the lines back for
// `toolscript-mcp runs`.

import { serverKey, type ServerKey } from './config.ts'
import { decide, shownName, type Bridges, type Policy } from './policy.ts'
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
  'guarded',
  'tool-error',
  'timeout',
  'cancelled',
  'failed',
  'unfinished',
] as const
/** Why a nested call did not work, as a short code. */
export type CallError = (typeof CALL_ERRORS)[number]

/** The kind of a downstream error, from a fixed set. A message never reaches the log: only one of these words. */
export const CALL_CLASSES = ['validation', 'not-found', 'auth', 'rate-limit', 'timeout', 'server', 'other'] as const
export type CallClass = (typeof CALL_CLASSES)[number]

const CLASS_TEXT_LIMIT = 4096
// Each pattern is a plain alternation or has a bounded gap, so it runs in linear time on downstream text.
const VALIDATION = new RegExp(
  [
    '-32602',
    'invalid arguments for tool',
    'input validation error',
    // zod 3 and zod 4
    'invalid_type',
    'invalid_enum_value',
    'expected \\w+, received \\w+',
    'invalid enum value',
    'invalid input: expected',
    'invalid option: expected one of',
    // pydantic
    'validation errors? for',
    'input should be',
    'field required',
    '\\[type=',
    // ajv, and the GitHub server (`parameter x is not of type`)
    'must be (?:string|number|integer|boolean|array|object)',
    'must be equal to one of the allowed values',
    'must have required property',
    'is not of type',
    // python-jsonschema
    'is a required property',
    'is not one of',
    // plain forms
    'missing required (?:parameter|argument|field|property)',
    'invalid (?:parameter|argument|params|input|value)',
  ].join('|'),
)
const RATE_LIMIT = /rate limit|too many requests|throttl|quota exceeded/
// A status with a marker, or with its reason phrase. A bare number is not a status.
const STATUS =
  /(?:http(?: error)?|status ?(?:code)?)[: ]{0,3}([45]\d\d)\b|\b(400 bad request|401 unauthorized|403 forbidden|404 not found|408 request timeout|410 gone|422 validation failed|429 too many requests|500 internal server error|502 bad gateway|503 service unavailable|504 gateway timeout)/
const STATUS_CLASS: Record<string, CallClass> = {
  '400': 'validation',
  '422': 'validation',
  '401': 'auth',
  '403': 'auth',
  '407': 'auth',
  '404': 'not-found',
  '410': 'not-found',
  '408': 'timeout',
  '504': 'timeout',
  '429': 'rate-limit',
}
const MIXED_NOT_FOUND = /does not exist,? or.{0,40}(?:permission|access)/
const AUTH =
  /unauthorized|unauthenticated|forbidden|permission denied|access denied|not authorized|do not have permission|bad credentials|requires authentication|resource not accessible by|token expired|invalid token|tf400813|tf401027/
const NOT_FOUND = /not found|does not exist|no such|could not resolve to a/
const TIMEOUT = /timed out|timeout|deadline exceeded|etimedout/
const SERVER = /internal server error|internal error|bad gateway|service unavailable/

/**
 * The class of a downstream error, for the run log. `rpcCode` is the code of an McpError. It reads at most the first
 * 4096 characters and never throws. The first rule that matches wins.
 */
export const classifyCallError = (text: string, rpcCode?: number): CallClass => {
  try {
    const t = String(text).slice(0, CLASS_TEXT_LIMIT).toLowerCase()
    if (rpcCode === -32602 || VALIDATION.test(t)) return 'validation'
    if (RATE_LIMIT.test(t)) return 'rate-limit'
    const status = STATUS.exec(t)
    const code = status?.[1] ?? status?.[2]?.slice(0, 3)
    // Any other 5xx is a server error. A 4xx without a class here falls through to the text rules.
    const byStatus =
      code === undefined ? undefined : (STATUS_CLASS[code] ?? (code.startsWith('5') ? 'server' : undefined))
    if (byStatus !== undefined) return byStatus
    if (MIXED_NOT_FOUND.test(t)) return 'not-found'
    if (AUTH.test(t)) return 'auth'
    if (NOT_FOUND.test(t)) return 'not-found'
    if (TIMEOUT.test(t)) return 'timeout'
    if (rpcCode === -32603 || SERVER.test(t)) return 'server'
  } catch {
    // A text that cannot be read is `other`.
  }
  return 'other'
}

export type CallLog = {
  readonly tool: string
  readonly decision: CallDecision
  readonly ms: number
  readonly ok: boolean
  readonly error?: CallError
  /** Set only for a `tool-error` or a `failed` call that reached its server. */
  readonly class?: CallClass
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

/** Only a call that reached its server and failed has a class. */
const classAllowed = (error: CallError | undefined): boolean => error === 'tool-error' || error === 'failed'

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
      ...(classAllowed(c.error) && oneOf(CALL_CLASSES, c.class) ? { class: c.class } : {}),
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
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A call as `runs` reads it back. `unreadable`: a call in a form that runLine does not write. It never counts as ok. */
export type ReadCall = CallLog | { readonly unreadable: true; readonly tool?: string; readonly ok: false }

/** A run as `runs` reads it back. Its strings are as the file holds them: print them only through `shownName`. */
export type ReadRun = Omit<RunRecord, 'calls'> & { readonly calls: readonly ReadCall[] }

/** A line of the run log: a run, or `unreadable` when it is not one. Anyone who can write the file can change it. */
export type LogEntry = ReadRun | 'unreadable'

const readCall = (v: unknown): ReadCall => {
  if (!isObject(v) || typeof v.tool !== 'string') return { unreadable: true, ok: false }
  const { tool, decision, ms, ok, error } = v
  if (!oneOf(CALL_DECISIONS, decision) || !isCount(ms) || typeof ok !== 'boolean')
    return { unreadable: true, ok: false, tool }
  if (error !== undefined && !oneOf(CALL_ERRORS, error)) return { unreadable: true, ok: false, tool }
  // runLine writes an ok call only when the policy let it run, and never with an error code.
  if (ok && (error !== undefined || (decision !== 'allow' && decision !== 'ask-approved')))
    return { unreadable: true, ok: false, tool }
  // runLine writes a class only beside tool-error or failed. A string outside the set can come from a later version:
  // it reads as no class and is never printed.
  const cls = v.class
  if (cls !== undefined && (typeof cls !== 'string' || !classAllowed(error)))
    return { unreadable: true, ok: false, tool }
  return {
    tool,
    decision,
    ms,
    ok,
    ...(error === undefined ? {} : { error }),
    ...(oneOf(CALL_CLASSES, cls) ? { class: cls } : {}),
  }
}

export const parseRunLine = (line: string): LogEntry => {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return 'unreadable'
  }
  if (!isObject(v)) return 'unreadable'
  const { time, id, ms, ending, chars, calls, omitted } = v
  if (typeof time !== 'string' || typeof id !== 'string' || !isCount(ms) || !oneOf(RUN_ENDINGS, ending))
    return 'unreadable'
  if (!isCount(chars) || !Array.isArray(calls) || (omitted !== undefined && !isCount(omitted))) return 'unreadable'
  return { time, id, ms, ending, chars, calls: calls.map(readCall), ...(omitted === undefined ? {} : { omitted }) }
}

/** The next step for each code of a failed call. `tools` is the command that checks its server, when its key is valid. */
const CALL_FIXES: Record<CallError, ((tools: string | undefined) => string) | undefined> = {
  allow: undefined,
  'ask-approved': undefined,
  // The server part of a logged name can be any text, so it reaches a printed command only as a valid key.
  'no-server': tools =>
    tools === undefined
      ? 'no-server: the server did not connect. Run toolscript-mcp tools with its key to see the connection or login problem.'
      : `no-server: the server did not connect. Run \`${tools}\` to see the connection or login problem.`,
  denied: () => 'denied: a deny rule of the policy matches the tool. The policy decides: setup does not override it.',
  unapproved: () =>
    'unapproved: approve the tool in the prompt, or add an allow rule with its exact name. A tool that needs a person each run needs the prompt.',
  invalid: () =>
    'invalid: the tool name is wrong, or its server does not list it. Find the listed name with search_tools.',
  guarded: () =>
    'guarded: an argument of the call names a folder that toolscript-mcp guards (hints, functions, learned or oauth). No rule or approval lifts it. Take the path out of the call, or let the person edit the file.',
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

const UNREADABLE_CALL =
  'unreadable: this toolscript-mcp cannot read the call. Another version or another program wrote it.'

const DURATION = /^([1-9]\d{0,5})([mhd])$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const
// A date and a time with seconds optional, and a zone: a time without one depends on the zone of the machine.
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/

/**
 * The time of `runs --since`: an ISO 8601 time with a zone, such as `2026-11-18T09:30:00Z`, or a duration back from
 * `now`, such as `30m`, `2h` or `1d`. Undefined for any other text, also for a day or an hour that does not exist.
 */
export const parseSince = (text: string, now: Date): Date | undefined => {
  const duration = DURATION.exec(text)
  if (duration !== null) return new Date(now.getTime() - Number(duration[1]) * UNIT_MS[duration[2] as 'm' | 'h' | 'd'])
  const m = ISO_TIME.exec(text)
  if (m === null) return undefined
  const n = (group: number) => Number(m[group] ?? 0)
  const [month, day] = [n(2), n(3)]
  const days = new Date(Date.UTC(n(1), month, 0)).getUTCDate()
  const fits = month >= 1 && month <= 12 && day >= 1 && day <= days
  return fits && n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(7) <= 23 && n(8) <= 59 ? new Date(text) : undefined
}

/**
 * What `toolscript-mcp runs` asks for: the runs of `server` (of all servers when undefined), at or after `since`.
 * `now` is the time of the check.
 */
export type RunsQuery = {
  readonly server?: ServerKey
  readonly last: number
  readonly since?: Date
  readonly now: Date
}

/** What `toolscript-mcp runs` prints, and true when the newest run that it shows worked. */
export type RunsReport = { readonly lines: readonly string[]; readonly ok: boolean }

/** How far the time of a run can pass the time of the check before `runs` skips the run, for clocks a little apart. */
export const CLOCK_SLACK_MS = 5 * 60_000

/** True for a run dated more than CLOCK_SLACK_MS after `now`. A time that does not parse is never after it. */
export const isFuture = (run: ReadRun, now: Date): boolean => Date.parse(run.time) > now.getTime() + CLOCK_SLACK_MS

/** The line that counts the runs that `isFuture` skips. */
export const futureLine = (count: number): string =>
  `skipped runs dated more than ${CLOCK_SLACK_MS / 60_000} minutes after now: ${count}`

/**
 * The newest `last` runs with a call of `server` (any run without one) at or after `since`, newest first, then the
 * next step for each distinct problem, then the count of skipped lines. `ok`: the newest ended done, called a tool of
 * `server` (of any server without one), each of its calls of `server` worked, the log holds all its calls, and no
 * skipped line is newer. A skipped line is an unreadable line, or a run of `server` dated more than CLOCK_SLACK_MS
 * after `now`. Such a line can be a newer run of `server`, so it never lets an older run confirm the route. A run
 * without a call confirms no route. `tools` is the command that checks one server.
 */
export const runsReport = (
  entries: readonly LogEntry[],
  { server, last, since, now }: RunsQuery,
  tools: (server: ServerKey) => string,
): RunsReport => {
  const serverOf = (call: ReadCall) => (call.tool === undefined ? undefined : splitToolName(call.tool)?.server)
  // An unreadable call without a server can be a call of any server.
  const counts = (call: ReadCall) =>
    server === undefined || serverOf(call) === server || ('unreadable' in call && serverOf(call) === undefined)
  const runs = entries.flatMap((run, at) =>
    run === 'unreadable' || (server !== undefined && !run.calls.some(counts)) ? [] : [{ run, at }],
  )
  const future = runs.filter(({ run }) => isFuture(run, now))
  const timely = runs.filter(r => !future.includes(r))
  // A time that does not parse is never at or after `since`.
  const recent = since === undefined ? timely : timely.filter(({ run }) => Date.parse(run.time) >= since.getTime())
  const shown = recent.slice(-last).reverse()
  const unreadable = entries.filter(e => e === 'unreadable').length
  const skipped = [
    ...(unreadable === 0 ? [] : [`skipped unreadable lines of the run log: ${unreadable}`]),
    ...(future.length === 0 ? [] : [futureLine(future.length)]),
  ]
  const cutoff = since?.toISOString()
  const newest = shown[0]
  if (newest === undefined)
    return { lines: [timely.length === 0 ? 'no run yet' : `no run since ${cutoff}`, ...skipped], ok: false }
  const newer = entries.slice(newest.at + 1).includes('unreadable') || future.some(({ at }) => at > newest.at)
  const callText = (c: ReadCall) =>
    'unreadable' in c
      ? `  ${c.tool === undefined ? '-' : shownName(c.tool)} unreadable`
      : `  ${shownName(c.tool)} ${c.decision} ${c.ok ? 'ok' : (c.error ?? 'not-run')}${c.class === undefined ? '' : ` ${c.class}`}`
  const fixOf = (c: ReadCall): string | undefined => {
    if (!counts(c) || c.ok) return undefined
    if ('unreadable' in c) return UNREADABLE_CALL
    const key = serverKey(serverOf(c) ?? '')
    return c.error === undefined ? undefined : CALL_FIXES[c.error]?.(key === undefined ? undefined : tools(key))
  }
  const lines = shown.flatMap(({ run }) => [
    `${shownName(run.time)} ${run.ending} ${run.ms} ms`,
    ...run.calls.map(callText),
    ...(run.omitted === undefined ? [] : [`  ${run.omitted} more calls`]),
  ])
  // The tool-error and failed calls shown: those with a class count under it, the others under `no class`.
  const reached = shown
    .flatMap(({ run }) => run.calls.filter(counts))
    .filter((c): c is CallLog => !('unreadable' in c) && (c.error === 'tool-error' || c.error === 'failed'))
  const classCounts = [
    ...CALL_CLASSES.map(k => [k, reached.filter(c => c.class === k).length] as const),
    ['no class', reached.filter(c => c.class === undefined).length] as const,
  ].filter(([, n]) => n > 0)
  const classLine =
    classCounts.length === 0 ? [] : [`classes of failed calls: ${classCounts.map(([k, n]) => `${k} ${n}`).join(', ')}`]
  const fixes = shown.flatMap(({ run }) =>
    [...run.calls.map(fixOf), ENDING_FIXES[run.ending]].filter(f => f !== undefined),
  )
  const warning = newer
    ? ['A skipped line is newer than the newest run shown, so runs does not confirm that run. Run the task again.']
    : []
  const unlogged = newest.run.omitted ?? 0
  const partial =
    unlogged === 0
      ? []
      : [
          `${unlogged} calls of the newest run were not logged, so runs does not confirm that run. Run a task with at most ${MAX_CALLS} calls.`,
        ]
  const mine = newest.run.calls.filter(counts)
  const called = mine.some(c => !('unreadable' in c) && serverOf(c) !== undefined)
  // A failed call already says why the run does not count.
  const idle =
    called || !mine.every(c => c.ok)
      ? []
      : [`the newest run called no tool${server === undefined ? '' : ` of ${server}`}. Run a task that calls one.`]
  const ok = !newer && unlogged === 0 && called && newest.run.ending === 'done' && mine.every(c => c.ok)
  const header = cutoff === undefined ? [] : [`runs since ${cutoff}`]
  return {
    lines: [...header, ...lines, ...classLine, ...new Set(fixes), ...idle, ...partial, ...skipped, ...warning],
    ok,
  }
}
