// Finds nested calls of one tool that a program awaited one after another,
// where Promise.all would have run them at the same time.

/**
 * One nested call as the serial check sees it, in host time (ms). `key` is its
 * callKey. `plain`: a policy rule allowed it, with no approval of the person.
 * `previous`: the call sent just before this one, when this call can follow it
 * (mayFollow), and whether this call's arguments hold a value of its reply
 * (usesResult). `repliedAt` is absent when the call did not finish.
 */
export type TimedCall = {
  readonly id: number
  readonly tool: string
  readonly key: string
  readonly sentAt: number
  readonly repliedAt?: number
  readonly ok: boolean
  readonly plain: boolean
  readonly previous?: { readonly id: number; readonly usesResult: boolean }
}

/** Calls of `tool` that ran one after another: how many, how long from the first send to the last reply, and about how much parallel calls save. */
export type Streak = { readonly tool: string; readonly calls: number; readonly ms: number; readonly savedMs: number }

/** The limits of serialStreak, SERIAL_GAP_MS and SERIAL_MIN_SAVED_MS when absent. */
export type SerialLimits = { readonly gapMs?: number; readonly minSavedMs?: number }

/**
 * The longest time from a reply to the next call of a loop that awaits each
 * call. sleep() never reaches the host, so a longer gap stands for a sleep or
 * other work of the program between the calls. On Windows, a loop sent its next
 * call 0 to 140 ms after the reply, with 6 test processes at once, and a
 * sleep(300) between the calls left 233 ms or more.
 */
export const SERIAL_GAP_MS = 200

/** Parallel calls must save this much time before the footer names a streak. */
export const SERIAL_MIN_SAVED_MS = 3000

/**
 * True when `call`, sent just after `prev`, can follow it: `prev` worked with no
 * approval of the person, and `call` is of the same tool, with other arguments,
 * sent within `gapMs` of its reply. The host checks this before usesResult, so
 * a call that cannot follow costs no scan of a reply.
 */
export const mayFollow = (
  prev: TimedCall,
  call: Pick<TimedCall, 'tool' | 'key' | 'sentAt'>,
  gapMs = SERIAL_GAP_MS,
): boolean =>
  prev.ok &&
  prev.plain &&
  prev.repliedAt !== undefined &&
  call.tool === prev.tool &&
  call.key !== prev.key &&
  call.sentAt - prev.repliedAt <= gapMs

// `call` follows `prev`: it can follow it, takes no value from its result, and the person did not approve it.
const follows = (prev: TimedCall, call: TimedCall, gapMs: number): boolean =>
  mayFollow(prev, call, gapMs) &&
  call.plain &&
  call.repliedAt !== undefined &&
  call.previous?.id === prev.id &&
  !call.previous.usesResult

// Parallel calls take about as long as the slowest one.
const streakOf = (calls: readonly TimedCall[]): Streak => {
  const ms = calls.at(-1)!.repliedAt! - calls[0]!.sentAt
  const savedMs = ms - Math.max(...calls.map(c => c.repliedAt! - c.sentAt))
  return { tool: calls[0]!.tool, calls: calls.length, ms, savedMs }
}

/** The streak of 2 or more calls that saves the most in parallel, when it saves `minSavedMs` or more. */
export const serialStreak = (
  calls: readonly TimedCall[],
  { gapMs = SERIAL_GAP_MS, minSavedMs = SERIAL_MIN_SAVED_MS }: SerialLimits = {},
): Streak | undefined => {
  const sent = [...calls].sort((a, b) => a.id - b.id)
  let best: Streak | undefined
  let run: TimedCall[] = []
  for (const call of [...sent, undefined]) {
    const prev = run.at(-1)
    if (call !== undefined && prev !== undefined && follows(prev, call, gapMs)) {
      run.push(call)
      continue
    }
    if (run.length >= 2) {
      const streak = streakOf(run)
      if (streak.savedMs >= minSavedMs && streak.savedMs > (best?.savedMs ?? -1)) best = streak
    }
    run = call === undefined ? [] : [call]
  }
  return best
}

// The argument values that can come from a result, as their JSON text: strings
// of 4 or more characters (`s` and the text without quotes) and finite numbers (`n` and the number).
const valuesOf = (v: unknown, out: Set<string>): Set<string> => {
  if (typeof v === 'string') {
    if (v.length >= 4) out.add(`s${JSON.stringify(v).slice(1, -1)}`)
  } else if (typeof v === 'number') {
    if (Number.isFinite(v)) out.add(`n${v}`)
  } else if (Array.isArray(v)) for (const x of v) valuesOf(x, out)
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) valuesOf(x, out)
  return out
}

// A number counts only as a whole number in the text: 5 is not in 50 or 1.5. One
// regular expression scans the text: a loop of indexOf took 1.7 s for 20 numbers in 1 MB of digits.
const holdsNumber = (json: string, n: string): boolean =>
  new RegExp(`(?<![0-9.])${n.replace(/[.+]/g, '\\$&')}(?![0-9.])`).test(json)

// The scan runs in the host's message handler, so these limits bound it: past
// them, usesResult says true and the calls get no note. Each new value costs a
// scan of the result plus a fixed part (the build of a RegExp, about 10 µs), so
// many values of a small result scan, and at most MAX_SCAN_WORK / VALUE_COST values do.
export const MAX_SCAN_CHARS = 1_000_000
export const MAX_SCAN_WORK = 20 * MAX_SCAN_CHARS
export const VALUE_COST = 10_000

/**
 * True when `args` holds a value that the previous call did not send and that
 * its result (`json`) holds: a cursor, a link or an id taken from that result.
 * Also true for a result of more than MAX_SCAN_CHARS, or when the new values
 * times the result length plus VALUE_COST pass MAX_SCAN_WORK.
 */
export const usesResult = (
  args: Record<string, unknown>,
  previousArgs: Record<string, unknown>,
  json: string,
): boolean => {
  if (json.length > MAX_SCAN_CHARS) return true
  const before = valuesOf(previousArgs, new Set())
  const fresh = [...valuesOf(args, new Set())].filter(v => !before.has(v))
  if (fresh.length * (json.length + VALUE_COST) > MAX_SCAN_WORK) return true
  return fresh.some(v => (v.startsWith('n') ? holdsNumber(json, v.slice(1)) : json.includes(v.slice(1))))
}
