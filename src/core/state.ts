// The state of an approval on a 2026-07-28 connection (issue #154, P3-1). The handler of `run_code` does not pause a run to ask the
// person: it returns `input_required` with the prompt and a `requestState`, and the client calls again with the answer and the state
// (the multi-round-trip pattern of the revision). The state round-trips through the client, so it is attacker-controlled input on
// re-entry. It is sealed by the sealer of the process (`src/host/workspace/rootsstate.ts`: HMAC-SHA256, a key made at process start,
// a used-once number, 600 s), the same one that seals the states of the roots round, with the kind `approval`. This file holds what
// the seal does not: the fields, the hashes that bind a state to one program, one set of tools and one policy, and the answer of the
// client. Pure: no Node module. A caller gives the hash function.
//
// The fields hold the kind of the stage, the round, and three hashes. They hold no program text, no tool name, no path and no
// secret: the client can read them, and that must be harmless.

import type { Policy } from './policy.ts'

/** `tools`: the approval of the tools that a program needs. `policy`: the approval of a looser policy, a round before it. */
export type StateKind = 'tools' | 'policy'

/** What an approval state carries, besides the version, the kind `approval`, the number and the expiry of the seal. */
export type StatePayload = {
  /** The stage that asked: the tools of a plan, or the looser policy of the file. */
  readonly k: StateKind
  /** The number of this round of one call: 1 for the first prompt, and a round of the roots counts as one. */
  readonly r: number
  /** The hash of the arguments of the call (its tool name and its arguments). */
  readonly a: string
  /** The hash of the sorted tools that the plan asks for (empty for a policy round). */
  readonly t: string
  /** The hash of the policy: the policy in force for a tools round, the policy that the file proposes for a policy round. */
  readonly p: string
}

/** The most rounds of one call: the fifth gets the refusal of a prompt that was not answered. */
export const MAX_ROUNDS = 4
/** The most characters of a sealed state. */
export const MAX_STATE_CHARS = 512

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

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/**
 * The payload in the fields of an opened state, or undefined when they are not exactly the fields of one: `s` (the stage, `tools` or
 * `policy`), `r` (the round, 1 to MAX_ROUNDS) and the hashes `a`, `t` and `p`.
 */
export const parseFields = (fields: Readonly<Record<string, unknown>>): StatePayload | undefined => {
  const { s, r, a, t, p, ...rest } = fields
  if (Object.keys(rest).length > 0 || (s !== 'tools' && s !== 'policy')) return undefined
  if (!Number.isInteger(r) || (r as number) < 1 || (r as number) > MAX_ROUNDS) return undefined
  if (!isText(a, 64) || !isText(t, 64) || !isText(p, 64)) return undefined
  return { k: s, r: r as number, a, t, p }
}

/** The next round of a call: the round of the state that was presented plus one. */
export const nextRound = (presented: StatePayload): number => presented.r + 1

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
