// The request state of the roots round on a 2026-07-28 connection (issue #154, P3-2): the first call that needs the Workspace gets
// `input_required` with a roots request and one of these strings, and its retry must carry the same string back. The string is
// sealed (HMAC-SHA256 with a key made at process start, never written or logged) and used once, and it is bound to the call: the
// tool name and the SHA-256 of the canonical JSON of its arguments. The client can read the payload: it holds a version, the kind,
// a random number, the expiry and the one hash, and nothing from the call itself. A restart ends every open state.
// The sealing is one pair, `seal(kind, fields)` and `open(kind, text)`, that holds no meaning of its own: the kind names what the state is for
// (`roots` here, `approval` for P3-1), and `fields` are the strings and numbers that the kind needs. Only `roots` is built on it so far.

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

/** The fields of a state: strings and numbers only, so nothing but what the kind names can be in it. */
export type Fields = Readonly<Record<string, string | number>>

export type Opened = { readonly ok: true; readonly fields: Fields } | { readonly ok: false; readonly reason: Refusal }

export type Sealer = {
  /** A sealed, used-once state of `kind` that carries `fields`: base64url(payload) + '.' + base64url(HMAC-SHA256), payload `{ v, k, n, e, f }`. */
  readonly seal: (kind: string, fields: Fields) => string
  /**
   * The kind of a state whose MAC is good and whose payload is whole, or undefined. It touches no table: a state of any kind is left
   * as it is, so a caller that serves one kind can tell another kind's state from a forged one without using it up.
   */
  readonly peek: (text: string) => { readonly kind: string } | undefined
  /** Opens a state of `kind` and uses it up: it is removed from the table whatever the outcome, also under another kind. */
  readonly open: (kind: string, text: string) => Opened
  /** The states that are open. */
  readonly count: () => number
}

const b64 = (bytes: Buffer): string => bytes.toString('base64url')

export const createSealer = ({
  now = Date.now,
  key = randomBytes(32),
}: {
  /** Tests set the clock. */
  readonly now?: () => number
  readonly key?: Buffer
} = {}): Sealer => {
  // nonce -> expiry. A Map keeps the order of insertion, so the first key is the oldest.
  const table = new Map<string, number>()
  const mac = (body: string): Buffer => createHmac('sha256', key).update(body).digest()
  const sweep = (): void => {
    for (const [nonce, expires] of table) if (expires <= now()) table.delete(nonce)
  }
  // The checks that touch no table: the shape, the MAC and the payload. Both `peek` and `open` start here.
  const verified = (
    text: string,
  ):
    | {
        readonly ok: true
        readonly kind: string
        readonly nonce: string
        readonly expires: number
        readonly fields: Fields
      }
    | { readonly ok: false; readonly reason: Refusal } => {
    const [body, tag, extra] = text.split('.')
    if (body === undefined || tag === undefined || extra !== undefined || text.length > 512) {
      return { ok: false, reason: 'malformed' }
    }
    const given = Buffer.from(tag, 'base64url')
    const wanted = mac(body)
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, reason: 'mac' }
    let payload: { v?: unknown; k?: unknown; n?: unknown; e?: unknown; f?: unknown }
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof payload
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    const fields = payload.f
    if (
      payload.v !== VERSION ||
      typeof payload.k !== 'string' ||
      typeof payload.n !== 'string' ||
      typeof payload.e !== 'number' ||
      typeof fields !== 'object' ||
      fields === null ||
      Array.isArray(fields)
    ) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, kind: payload.k, nonce: payload.n, expires: payload.e, fields: fields as Fields }
  }
  return {
    seal: (kind, fields) => {
      sweep()
      const nonce = randomBytes(16).toString('hex')
      const expires = now() + STATE_TTL_MS
      while (table.size >= STATES_OPEN_MAX) table.delete(table.keys().next().value as string)
      table.set(nonce, expires)
      const body = b64(Buffer.from(JSON.stringify({ v: VERSION, k: kind, n: nonce, e: expires, f: fields })))
      return `${body}.${b64(mac(body))}`
    },
    peek: text => {
      const read = verified(text)
      return read.ok ? { kind: read.kind } : undefined
    },
    open: (kind, text) => {
      const read = verified(text)
      if (!read.ok) return { ok: false, reason: read.reason }
      // Used up from here on, whatever follows.
      const known = table.delete(read.nonce)
      if (read.kind !== kind) return { ok: false, reason: 'kind' }
      if (read.expires <= now()) return { ok: false, reason: 'expired' }
      if (!known) return { ok: false, reason: 'used' }
      return { ok: true, fields: read.fields }
    },
    count: () => (sweep(), table.size),
  }
}

// The sealer of the process: the key is made when the module loads, at the start of the process, and is never written or logged.
// One sealer for every kind, so the kinds share one key and one used-once table.
export const processSealer = createSealer()
export const seal = (kind: string, fields: Fields): string => processSealer.seal(kind, fields)
export const open = (kind: string, text: string): Opened => processSealer.open(kind, text)
export const peek = (text: string): { readonly kind: string } | undefined => processSealer.peek(text)

export type RootsState = {
  /** A new state for the call `tool` with `args`. */
  readonly mint: (tool: string, args: unknown) => string
  /**
   * Checks a state presented with the call `tool` and `args`, and uses it up: it is removed whatever the outcome, except a state of
   * another kind, which is refused (`kind`) and left as it is.
   */
  readonly take: (state: string, tool: string, args: unknown) => 'ok' | Refusal
  /** The states that are open. */
  readonly open: () => number
  /** The kind of a whole sealed state of this process, or undefined. It uses nothing up. */
  readonly kindOf: (state: string) => string | undefined
}

/** The state of kind `roots`: one field, the hash that binds it to the call. It is built on a sealer, the one of the process by default. */
export const createRootsState = (sealer: Sealer = processSealer): RootsState => {
  return {
    mint: (tool, args) => sealer.seal(KIND, { c: callHash(tool, args) }),
    take: (state, tool, args) => {
      // A state that is whole and of another kind is not ours: it is refused and not used up, so its own kind can still open it.
      const seen = sealer.peek(state)
      if (seen !== undefined && seen.kind !== KIND) return 'kind'
      const opened = sealer.open(KIND, state)
      if (!opened.ok) return opened.reason
      return opened.fields['c'] === callHash(tool, args) ? 'ok' : 'call'
    },
    open: sealer.count,
    kindOf: state => sealer.peek(state)?.kind,
  }
}
