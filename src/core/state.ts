// The state of an approval on a 2026-07-28 connection (issue #154, P3-1). The handler of `run_code` does not pause a run to ask the
// person: it returns `input_required` with the prompt and a `requestState`, and the client calls again with the answer and the state
// (the multi-round-trip pattern of the revision). The state round-trips through the client, so it is attacker-controlled input on
// re-entry. It is sealed and expires in the host (HMAC-SHA256, the codec of the SDK, `src/host/sdk/server.ts`), and this file holds
// what the seal does not: the payload, the hashes that bind it to one program, one set of tools and one policy, and the table that
// lets a state be used one time. Pure: no Node module. A caller gives the hash function.
//
// The payload holds a version, the kind, the round, a random number used once and three hashes. It holds no program text, no tool
// name, no path and no secret: the client can read it, and that must be harmless.

import type { Policy } from './policy.ts'

/** `tools`: the approval of the tools that a program needs. `policy`: the approval of a looser policy, a round before it. */
export type StateKind = 'tools' | 'policy'

export type StatePayload = {
  /** The version of this payload. */
  readonly v: 1
  readonly k: StateKind
  /** The number of this round of one call: 1 for the first prompt. */
  readonly r: number
  /** A random number, used one time. */
  readonly n: string
  /** The hash of the arguments of the call (its tool name and its arguments). */
  readonly a: string
  /** The hash of the sorted tools that the plan asks for (empty for a policy round). */
  readonly t: string
  /** The hash of the policy: the policy in force for a tools round, the policy that the file proposes for a policy round. */
  readonly p: string
}

/** The most rounds of one call: the fifth gets the refusal of a prompt that was not answered. */
export const MAX_ROUNDS = 4
/** The most states open at one time: the oldest is dropped. */
export const MAX_OPEN = 256
/** The most characters of a sealed state. */
export const MAX_STATE_CHARS = 512
/** The life of a state in seconds, as the codec seals it. */
export const STATE_TTL_SECONDS = 600

/** The reasons a state is refused. Only the host's log sees one, as a fixed word. The client sees the same error for all. */
export type StateRefusal = 'malformed' | 'used' | 'kind' | 'program' | 'round'

/** JSON with the keys of each object in order: the same value always gives the same text. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )

/** A function that gives the hash of a text, in base64url: the host passes SHA-256. */
export type Hash = (text: string) => string

/** The hash of one call: its tool name and its arguments, as the client sent them. A byte of difference changes it. */
export const argsHash = (hash: Hash, name: string, args: unknown): string => hash(canonicalJson({ name, args }))

/** The hash of the tools that a plan asks for, sorted: the order of the plan does not matter. */
export const toolsHash = (hash: Hash, tools: readonly string[]): string =>
  hash(canonicalJson([...new Set(tools)].sort()))

/** The hash of a policy as read: the rules in order, each with its match, action and index. */
export const policyHash = (hash: Hash, policy: Policy): string => hash(canonicalJson(policy))

const isKind = (v: unknown): v is StateKind => v === 'tools' || v === 'policy'
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** The payload in `value` (decoded by the codec after its check), or undefined when it is not one. */
export const parsePayload = (value: unknown): StatePayload | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { v, k, r, n, a, t, p, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0 || v !== 1 || !isKind(k)) return undefined
  if (!Number.isInteger(r) || (r as number) < 1 || (r as number) > MAX_ROUNDS) return undefined
  if (!isText(n, 64) || !isText(a, 64) || !isText(t, 64) || !isText(p, 64)) return undefined
  return { v, k, r: r as number, n, a, t, p }
}

/**
 * The states that are open: a random number and the time it expires. `take` removes a number whatever the answer, so a state
 * is used one time. At most MAX_OPEN are kept, and an expired one goes when another is used or made.
 */
export class OpenStates {
  readonly #open = new Map<string, number>()
  readonly #ttlMs: number
  constructor(ttlSeconds: number = STATE_TTL_SECONDS) {
    this.#ttlMs = ttlSeconds * 1000
  }
  /** Records a new number. The oldest goes when there are more than MAX_OPEN. */
  add(nonce: string, now: number): void {
    this.#sweep(now)
    this.#open.set(nonce, now + this.#ttlMs)
    while (this.#open.size > MAX_OPEN) this.#open.delete(this.#open.keys().next().value as string)
  }
  /** True when the number was open and had not expired. It is removed in every case. */
  take(nonce: string, now: number): boolean {
    this.#sweep(now)
    const expires = this.#open.get(nonce)
    this.#open.delete(nonce)
    return expires !== undefined && expires > now
  }
  get size(): number {
    return this.#open.size
  }
  #sweep(now: number): void {
    for (const [nonce, expires] of this.#open) if (expires <= now) this.#open.delete(nonce)
  }
}

/**
 * The checks of a verified payload against the call that carries it: the kind that the handler is at, and the arguments. The tools
 * and the policy are not checked here: a plan that changed between two rounds gets a new prompt, not an error.
 */
export const checkPayload = (payload: StatePayload, kind: StateKind, args: string): StateRefusal | undefined =>
  payload.k !== kind ? 'kind' : payload.a !== args ? 'program' : undefined

/** The next round of a call: the round of the state that was presented plus one, or 1. */
export const nextRound = (presented: StatePayload | undefined): number => (presented?.r ?? 0) + 1

/** What the person answered in `inputResponses.approve`: only an `action` of the elicitation result counts. */
export type Answer = 'accept' | 'decline' | 'none'

/**
 * The answer in the `approve` entry of a retried request. `accept` is an accept. `decline` and `cancel` are a decline. A missing
 * entry, one that is not an object, or one with another action is no answer: nothing runs on it.
 */
export const answerOf = (inputResponses: Readonly<Record<string, unknown>> | undefined): Answer => {
  const entry = inputResponses?.approve
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'none'
  const action = (entry as { action?: unknown }).action
  return action === 'accept' ? 'accept' : action === 'decline' || action === 'cancel' ? 'decline' : 'none'
}
