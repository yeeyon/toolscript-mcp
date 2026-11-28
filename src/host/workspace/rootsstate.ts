// The request state of the roots round on a 2026-07-28 connection (issue #154, P3-2): the first call that needs the Workspace gets
// `input_required` with a roots request and one of these strings, and its retry must carry the same string back. The string is
// sealed (HMAC-SHA256 with a key made at process start, never written or logged) and used once, and it is bound to the call: the
// tool name and the SHA-256 of the canonical JSON of its arguments. The client can read the payload: it holds a version, the kind,
// a random number, the expiry and the one hash, and nothing from the call itself. A restart ends every open state.
// This file holds the kind `roots` only: the approval rounds of P3-1 keep their own kinds, and one codec will serve both.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** How long a state lives, and how many are open at once (the oldest goes). */
export const STATE_TTL_MS = 600_000
export const STATES_OPEN_MAX = 256
const VERSION = 1
const KIND = 'roots'

/** Why a state was refused: a fixed word for the log, never shown to the client. */
export type Refusal = 'malformed' | 'mac' | 'kind' | 'expired' | 'used' | 'call'

/** The JSON of a value with the keys of each object sorted, so the same arguments give the same bytes. */
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The hash that binds a state to a call. */
export const callHash = (tool: string, args: unknown): string =>
  createHash('sha256').update(canonical({ tool, args })).digest('hex')

export type RootsState = {
  /** A new state for the call `tool` with `args`. */
  readonly mint: (tool: string, args: unknown) => string
  /** Checks a state presented with the call `tool` and `args`, and uses it up: it is removed whatever the outcome. */
  readonly take: (state: string, tool: string, args: unknown) => 'ok' | Refusal
  /** The states that are open. */
  readonly open: () => number
}

const b64 = (bytes: Buffer): string => bytes.toString('base64url')

export const createRootsState = ({
  now = Date.now,
  key = randomBytes(32),
}: {
  /** Tests set the clock. */
  readonly now?: () => number
  readonly key?: Buffer
} = {}): RootsState => {
  // nonce -> expiry. A Map keeps the order of insertion, so the first key is the oldest.
  const open = new Map<string, number>()
  const mac = (body: string): Buffer => createHmac('sha256', key).update(body).digest()
  const sweep = (): void => {
    for (const [nonce, expires] of open) if (expires <= now()) open.delete(nonce)
  }
  return {
    mint: (tool, args) => {
      sweep()
      const nonce = randomBytes(16).toString('hex')
      const expires = now() + STATE_TTL_MS
      while (open.size >= STATES_OPEN_MAX) open.delete(open.keys().next().value as string)
      open.set(nonce, expires)
      const body = b64(
        Buffer.from(JSON.stringify({ v: VERSION, k: KIND, n: nonce, e: expires, c: callHash(tool, args) })),
      )
      return `${body}.${b64(mac(body))}`
    },
    take: (state, tool, args) => {
      const [body, tag, extra] = state.split('.')
      if (body === undefined || tag === undefined || extra !== undefined || state.length > 512) return 'malformed'
      const given = Buffer.from(tag, 'base64url')
      const wanted = mac(body)
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return 'mac'
      let payload: { v?: unknown; k?: unknown; n?: unknown; e?: unknown; c?: unknown }
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof payload
      } catch {
        return 'malformed'
      }
      if (payload.v !== VERSION || typeof payload.n !== 'string' || typeof payload.e !== 'number') return 'malformed'
      // Used up from here on, whatever follows.
      const known = open.delete(payload.n)
      if (payload.k !== KIND) return 'kind'
      if (payload.e <= now()) return 'expired'
      if (!known) return 'used'
      return payload.c === callHash(tool, args) ? 'ok' : 'call'
    },
    open: () => (sweep(), open.size),
  }
}
