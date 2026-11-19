// Finds nested calls of one tool that a program awaited one after another,
// where Promise.all would have run them at the same time.

/**
 * One nested call as the serial check sees it, in host time (ms). `key` is its
 * callKey. `plain`: a policy rule allowed it, with no approval of the person.
 * `previous`: the call whose reply came last before this call was sent, and
 * whether this call's arguments hold a value of that reply (usesResult).
 * `repliedAt` is absent when the call did not finish.
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

/** Calls that ran one after another: how many, how long from the first send to the last reply, and about how much parallel calls save. */
export type Streak = { readonly calls: number; readonly ms: number; readonly savedMs: number }

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

// `call` follows `prev`: the same tool, sent right after its reply, with other
// arguments that take no value from its result, and neither approved by the person.
const follows = (prev: TimedCall, call: TimedCall, gapMs: number): boolean =>
  prev.ok &&
  prev.plain &&
  call.plain &&
  prev.repliedAt !== undefined &&
  call.repliedAt !== undefined &&
  call.tool === prev.tool &&
  call.key !== prev.key &&
  call.previous?.id === prev.id &&
  !call.previous.usesResult &&
  call.sentAt - prev.repliedAt <= gapMs

// Parallel calls take about as long as the slowest one.
const streakOf = (calls: readonly TimedCall[]): Streak => {
  const ms = calls.at(-1)!.repliedAt! - calls[0]!.sentAt
  return { calls: calls.length, ms, savedMs: ms - Math.max(...calls.map(c => c.repliedAt! - c.sentAt)) }
}

/** The streak of 2 or more calls that saves the most in parallel, when it saves `minSavedMs` or more. */
export const serialStreak = (
  calls: readonly TimedCall[],
  gapMs = SERIAL_GAP_MS,
  minSavedMs = SERIAL_MIN_SAVED_MS,
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

const NUMBER_CHAR = /[0-9.]/

// A number counts only as a whole number in the text: 5 is not in 50 or 1.5.
const holdsNumber = (json: string, n: string): boolean => {
  for (let i = json.indexOf(n); i !== -1; i = json.indexOf(n, i + 1))
    if (!NUMBER_CHAR.test(json[i - 1] ?? '') && !NUMBER_CHAR.test(json[i + n.length] ?? '')) return true
  return false
}

/**
 * True when `args` holds a value that the previous call did not send and that
 * its result (`json`) holds: a cursor, a link or an id taken from that result.
 */
export const usesResult = (
  args: Record<string, unknown>,
  previousArgs: Record<string, unknown>,
  json: string,
): boolean => {
  const before = valuesOf(previousArgs, new Set())
  for (const v of valuesOf(args, new Set())) {
    if (before.has(v)) continue
    const text = v.slice(1)
    if (v.startsWith('n') ? holdsNumber(json, text) : json.includes(text)) return true
  }
  return false
}
