// The wire of the shared-server broker (issue #63): the limits, the name of the endpoint, the mutual proof of the key
// that comes before any other byte, the entry that a host sends after it, and the line splitter. Pure: the host
// passes in the HMAC, the nonces and the comparison, so a test calls the two sides with fake ones.

import { brokerFolder } from './paths.ts'
import { shareText } from './share.ts'

/** Changes with the wire. It is read by both sides, and the build id covers the code of the broker as well. */
export const WIRE = 1

/** What the broker reads and waits for before the proof (a squatter or a stray client costs it no more than this). */
export const PROOF_BYTES = 4096
export const PROOF_MS = 2_000
export const PROOF_CONNECTIONS = 16

/** The time that a host gives a broker to start and listen, and one that listens to give the child. */
export const BROKER_START_MS = 10_000
export const CHILD_INIT_MS = 30_000
/** A child with no link stops after this time, and a broker with nothing to hold leaves a little later. */
export const CHILD_IDLE_MS = 600_000
/** After the end of stdin, the wait before the tree is ended. */
export const STOP_WAIT_MS = 2_000
/** The longest socket path: `sun_path` holds about 104 bytes on macOS and 108 on Linux. */
export const SOCKET_MAX_BYTES = 100

/** The idle time from `TOOLSCRIPT_BROKER_IDLE_MS` (at least 1000), or the default for any other text. */
export const idleMs = (text: string | undefined): number => {
  const n = text !== undefined && /^\d+$/.test(text) ? Number(text) : CHILD_IDLE_MS
  return n >= 1000 ? n : CHILD_IDLE_MS
}

/** The length of a text in UTF-8 bytes, which is what `sun_path` counts. */
export const utf8Length = (text: string): number => {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** The folder of the socket when the broker folder is too deep for `sun_path`: one short folder of the user. */
export const shortSocketFolder = (uid: number): string => `/tmp/tsm-${uid}`

/**
 * The pipe or socket for the first 12 hex digits of HMAC(key, build id). A short name keeps a socket path short, and a
 * socket whose path in the broker folder would not fit (a temp home under a long macOS TMPDIR) goes to the short folder.
 */
export const endpointOf = (platform: string, home: string, mac: string, uid: number): string => {
  const name = `tsm-${mac.slice(0, 12)}.sock`
  if (platform === 'win32') return `\\\\.\\pipe\\toolscript-mcp-${mac.slice(0, 12)}`
  const near = `${brokerFolder(home)}/${name}`
  return utf8Length(near) <= SOCKET_MAX_BYTES ? near : `${shortSocketFolder(uid)}/${name}`
}

/** What the host sends after the proof: the server entry as resolved, with the folder in place of any rule. */
export type Entry = {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly folder: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The entry in a frame, or the reason that it is not one. The frame comes from a peer that proved the key. */
export const parseEntry = (frame: unknown): Entry | string => {
  if (!isObj(frame) || frame.t !== 'entry') return 'the first frame after the proof is not an entry'
  const { command, args, env, folder } = frame
  if (typeof command !== 'string' || command === '' || typeof folder !== 'string' || folder === '')
    return 'the entry has no command or no folder'
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) return 'the entry has bad arguments'
  if (!isObj(env) || !Object.values(env).every(v => typeof v === 'string')) return 'the entry has a bad environment'
  return { command, args: args as string[], env: env as Record<string, string>, folder }
}

/**
 * The text of the share key of an entry, which the broker hashes: the broker derives it from what it received and never
 * takes a key from a host. It is the text of `shareText`, so it holds the env values. Never print it.
 */
export const entryText = (entry: Entry): string =>
  shareText(
    { class: 'folder', rule: 5 },
    { kind: 'stdio', command: entry.command, args: entry.args, env: {}, cwd: entry.folder },
    entry.env,
    { home: entry.folder, folder: entry.folder },
  )

/** What the two sides need from a crypto library. `same` compares in constant time. */
export type Crypto = {
  readonly mac: (text: string) => string
  readonly nonce: () => string
  readonly same: (a: string, b: string) => boolean
}

type Role = 'broker' | 'host'
/** The proof of a role is bound to both nonces and to the role, so a proof of one cannot pass as another. */
const proofText = (role: Role, host: string, broker: string): string =>
  `toolscript-mcp ${WIRE} ${role} ${host} ${broker}`
const NONCE = /^[0-9a-f]{32}$/
const isNonce = (v: unknown): v is string => typeof v === 'string' && NONCE.test(v)
const isProof = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const frame = (value: unknown): string => `${JSON.stringify(value)}\n`

export const parseFrame = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** One step of a handshake: a frame to send, the end of it, or the reason that it failed. */
export type Step = { readonly send?: string; readonly done?: true; readonly fail?: string }

export type Side = { readonly start: () => string; readonly step: (line: string) => Step }

/**
 * The broker side, for one connection. Nothing is sent before the first frame of the peer, and the broker proves the
 * key in its first reply, bound to the nonce of the peer. It answers `ok` only after the proof of the peer.
 */
export const brokerSide = (c: Crypto): Side => {
  let state: 'hello' | 'proof' | 'done' = 'hello'
  let host = ''
  let broker = ''
  return {
    start: () => '',
    step: line => {
      const msg = parseFrame(line)
      if (state === 'hello') {
        if (!isObj(msg) || msg.t !== 'hello' || msg.v !== WIRE || !isNonce(msg.n)) return { fail: 'bad hello' }
        state = 'proof'
        host = msg.n
        broker = c.nonce()
        return { send: frame({ t: 'hello', n: broker, p: c.mac(proofText('broker', host, broker)) }) }
      }
      if (state === 'proof') {
        if (
          !isObj(msg) ||
          msg.t !== 'proof' ||
          !isProof(msg.p) ||
          !c.same(msg.p, c.mac(proofText('host', host, broker)))
        )
          return { fail: 'wrong proof' }
        state = 'done'
        return { send: frame({ t: 'ok' }), done: true }
      }
      return { fail: 'extra frame' }
    },
  }
}

/** The host side. The host sends its proof only after it checked the broker's, and sends no entry before `ok`. */
export const hostSide = (c: Crypto): Side => {
  let state: 'hello' | 'ok' | 'done' = 'hello'
  const host = c.nonce()
  return {
    start: () => frame({ t: 'hello', v: WIRE, n: host }),
    step: line => {
      const msg = parseFrame(line)
      if (state === 'hello') {
        if (!isObj(msg) || !isNonce(msg.n) || !isProof(msg.p)) return { fail: 'the peer did not answer as a broker' }
        if (!c.same(msg.p, c.mac(proofText('broker', host, msg.n)))) return { fail: 'the peer did not prove the key' }
        state = 'ok'
        return { send: frame({ t: 'proof', p: c.mac(proofText('host', host, msg.n)) }) }
      }
      if (state === 'ok') {
        if (!isObj(msg) || msg.t !== 'ok') return { fail: 'the broker refused the proof' }
        state = 'done'
        return { done: true }
      }
      return { fail: 'extra frame' }
    },
  }
}

export const entryFrame = (entry: Entry): string => frame({ t: 'entry', ...entry })
export const attachedFrame = frame({ t: 'attached' })
export const refusedFrame = (reason: string): string => frame({ t: 'refused', reason })

/** The answer to an entry: attached, or the reason that the broker gives. Any other frame is no answer. */
export const parseAnswer = (line: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  const msg = parseFrame(line)
  if (isObj(msg) && msg.t === 'attached') return { ok: true }
  if (isObj(msg) && msg.t === 'refused' && typeof msg.reason === 'string')
    return { ok: false, reason: msg.reason.slice(0, 300) }
  return { ok: false, reason: 'the broker gave no valid answer to the entry' }
}

/** The failure of a shared link. No fallback (decision 024): it names the check and the three ways out. */
export const unusable = (why: string): string =>
  `the shared-server broker is not usable: ${why}. Run "toolscript-mcp doctor". To start this server for each ` +
  'session instead, set "share": false on the server or at the top level of the config, or set TOOLSCRIPT_SHARE=0'

/** Splits a stream of text chunks into lines. A line is complete at its `\n`. */
export const lineSplitter = (onLine: (line: string) => void): ((chunk: string) => void) => {
  let rest = ''
  return chunk => {
    rest += chunk
    for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n')) {
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (line.trim() !== '') onLine(line)
    }
  }
}

/**
 * The PATH list with each entry replaced by its real path (`real` returns undefined for an entry that cannot be read,
 * which stays as written) and repeats dropped. Decision 027: two shells whose PATH differs only in a per-shell link to
 * one folder share one copy. `fold` is true where paths ignore case.
 */
export const resolvePath = (
  path: string,
  delimiter: string,
  real: (entry: string) => string | undefined,
  fold: boolean,
): string => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of path.split(delimiter)) {
    if (entry === '') continue
    const resolved = real(entry) ?? entry
    const same = fold ? resolved.toLowerCase() : resolved
    if (seen.has(same)) continue
    seen.add(same)
    out.push(resolved)
  }
  return out.join(delimiter)
}

/** The env with each PATH variable (any letter case) resolved. */
export const resolveEnvPath = (
  env: Readonly<Record<string, string>>,
  delimiter: string,
  real: (entry: string) => string | undefined,
  fold: boolean,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      name.toUpperCase() === 'PATH' ? resolvePath(value, delimiter, real, fold) : value,
    ]),
  )
