// The router of one child process that several links share (issue #63). A link is one session of toolscript-mcp. The
// router gives each request of a link its own id before the request goes to the child, and sends each answer, each
// progress notice and each failure back to the one link that asked. It is pure: no Node module, timer, clock or random.
// An input goes in and a list of effects comes out, in the order to carry them out. It reads each message as
// untrusted: no JSON value makes it throw, and it never changes a message that it gets.

/** The id of a link. The caller makes it and never reuses it for another link. */
export type LinkId = string

/** What to do next: a message to the child, or one to a link. */
export type Effect =
  | { readonly to: 'child'; readonly msg: unknown }
  | { readonly to: 'link'; readonly link: LinkId; readonly msg: unknown }

export type Router = {
  /** A new link. Attaching a link that is attached has no effect. */
  readonly attach: (link: LinkId) => readonly Effect[]
  /** The link leaves: its open requests are cancelled at the child, and no effect names it later. */
  readonly detach: (link: LinkId) => readonly Effect[]
  readonly fromLink: (link: LinkId, msg: unknown) => readonly Effect[]
  readonly fromChild: (msg: unknown) => readonly Effect[]
  /** The child ended. Each open request gets an error, then every input gives no effect. */
  readonly died: () => readonly Effect[]
  /** The requests that wait for an answer: 0 after all answers, cancels and detaches. */
  readonly open: () => number
}

export const DIED_CODE = -32000
const NOT_FOUND_CODE = -32601
const VERSION = '2.0'

type Id = string | number
type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
/** An own property only: a message can come from anywhere, so nothing is read through a prototype. */
const own = (o: Obj, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)
const answer = (id: Id, result: unknown): unknown => ({ jsonrpc: VERSION, id, result })
const failure = (id: Id, code: number, message: string): unknown => ({ jsonrpc: VERSION, id, error: { code, message } })

/** The ids of one link, kept apart by type: 7 and "7" are two ids, and no string joins two inputs. */
type Held = { readonly numbers: Map<number, number>; readonly strings: Map<string, number> }

type Waiter = { readonly link: LinkId; readonly id: Id }
type Call = {
  readonly kind: 'call'
  readonly link: LinkId
  readonly id: Id
  /** The token that the router put in place of the progress token of the link, and the token of the link. */
  readonly token?: { readonly sent: number; readonly original: unknown }
}
/** The one initialize that the child sees. Every link that asked while it was open waits in `waiters`. */
type Init = { readonly kind: 'init'; readonly waiters: Waiter[] }

export const createRouter = (): Router => {
  const links = new Map<LinkId, Held>()
  const open = new Map<number, Call | Init>()
  const tokens = new Map<number, number>()
  let nextId = 1
  let nextToken = 1
  let dead = false
  let cached: { readonly result: unknown } | undefined
  let opening: number | undefined
  let initialized = false

  const holder = (held: Held, id: Id): number | undefined =>
    typeof id === 'number' ? held.numbers.get(id) : held.strings.get(id)
  const hold = (held: Held, id: Id, rid: number): void => {
    if (typeof id === 'number') held.numbers.set(id, rid)
    else held.strings.set(id, rid)
  }
  const release = (held: Held, id: Id): void => {
    if (typeof id === 'number') held.numbers.delete(id)
    else held.strings.delete(id)
  }

  /** Closes the request `rid` for the link, with no message to the link. */
  const close = (rid: number, link: LinkId, id: Id): void => {
    const entry = open.get(rid)
    const held = links.get(link)
    if (held !== undefined) release(held, id)
    if (entry?.kind === 'call') {
      open.delete(rid)
      if (entry.token !== undefined) tokens.delete(entry.token.sent)
    } else if (entry !== undefined) {
      const at = entry.waiters.findIndex(w => w.link === link && w.id === id)
      if (at >= 0) entry.waiters.splice(at, 1)
    }
  }

  const cancelChild = (rid: number, reason: unknown): Effect => ({
    to: 'child',
    msg: {
      jsonrpc: VERSION,
      method: 'notifications/cancelled',
      params: { requestId: rid, ...(typeof reason === 'string' && { reason }) },
    },
  })

  /** The link gives up the request that it holds under `id`: the child hears of it when no other link waits. */
  const cancel = (link: LinkId, id: Id, reason: unknown): Effect[] => {
    const held = links.get(link)
    const rid = held === undefined ? undefined : holder(held, id)
    const entry = rid === undefined ? undefined : open.get(rid)
    if (rid === undefined || entry === undefined) return []
    close(rid, link, id)
    if (entry.kind === 'call') return [cancelChild(rid, reason)]
    if (entry.waiters.length > 0) return []
    open.delete(rid)
    opening = undefined
    return [cancelChild(rid, reason)]
  }

  /** The message with its progress token swapped for one that no other request has. */
  const withToken = (msg: Obj, params: unknown): { msg: Obj; token?: Call['token'] } => {
    const meta = isObj(params) ? own(params, '_meta') : undefined
    const original = isObj(meta) ? own(meta, 'progressToken') : undefined
    if (!isObj(params) || !isObj(meta) || !isId(original)) return { msg }
    const sent = nextToken++
    return {
      msg: { ...msg, params: { ...params, _meta: { ...meta, progressToken: sent } } },
      token: { sent, original },
    }
  }

  const request = (link: LinkId, id: Id, msg: Obj, held: Held): Effect[] => {
    const method = own(msg, 'method')
    if (method === 'ping') return [{ to: 'link', link, msg: answer(id, {}) }]
    if (holder(held, id) !== undefined) return []
    if (method === 'initialize') {
      if (cached !== undefined) return [{ to: 'link', link, msg: answer(id, cached.result) }]
      if (opening !== undefined) {
        const entry = open.get(opening) as Init
        entry.waiters.push({ link, id })
        hold(held, id, opening)
        return []
      }
      const rid = nextId++
      opening = rid
      open.set(rid, { kind: 'init', waiters: [{ link, id }] })
      hold(held, id, rid)
      const params = own(msg, 'params')
      const forwarded = { ...msg, id: rid, params: { ...(isObj(params) ? params : {}), capabilities: {} } }
      return [{ to: 'child', msg: forwarded }]
    }
    const rid = nextId++
    const { msg: changed, token } = withToken(msg, own(msg, 'params'))
    open.set(rid, { kind: 'call', link, id, ...(token !== undefined && { token }) })
    hold(held, id, rid)
    if (token !== undefined) tokens.set(token.sent, rid)
    return [{ to: 'child', msg: { ...changed, id: rid } }]
  }

  const notice = (link: LinkId, msg: Obj, method: unknown): Effect[] => {
    if (method === 'notifications/cancelled') {
      const params = own(msg, 'params')
      const id = isObj(params) ? own(params, 'requestId') : undefined
      return isId(id) ? cancel(link, id, isObj(params) ? own(params, 'reason') : undefined) : []
    }
    if (method === 'notifications/initialized' && cached !== undefined && !initialized) {
      initialized = true
      return [{ to: 'child', msg }]
    }
    return []
  }

  const fromLink = (link: LinkId, msg: unknown): Effect[] => {
    const held = links.get(link)
    if (dead || held === undefined || !isObj(msg)) return []
    const method = own(msg, 'method')
    if (typeof method !== 'string') return []
    const id = own(msg, 'id')
    if (id === undefined) return notice(link, msg, method)
    return isId(id) ? request(link, id, msg, held) : []
  }

  /** The answer of the child to the initialize that it saw: each waiting link gets it, or its failure. */
  const answerInit = (rid: number, entry: Init, msg: Obj): Effect[] => {
    open.delete(rid)
    opening = undefined
    const result = own(msg, 'result')
    const good = Object.hasOwn(msg, 'result') && !Object.hasOwn(msg, 'error')
    if (good) cached = { result }
    return entry.waiters.flatMap(({ link, id }): Effect[] => {
      const held = links.get(link)
      if (held !== undefined) release(held, id)
      return [{ to: 'link', link, msg: good ? answer(id, result) : { ...msg, id } }]
    })
  }

  const response = (rid: number, msg: Obj): Effect[] => {
    const entry = open.get(rid)
    if (entry === undefined) return []
    if (entry.kind === 'init') return answerInit(rid, entry, msg)
    open.delete(rid)
    if (entry.token !== undefined) tokens.delete(entry.token.sent)
    const held = links.get(entry.link)
    if (held !== undefined) release(held, entry.id)
    return [{ to: 'link', link: entry.link, msg: { ...msg, id: entry.id } }]
  }

  const progress = (msg: Obj): Effect[] => {
    const params = own(msg, 'params')
    const sent = isObj(params) ? own(params, 'progressToken') : undefined
    const rid = typeof sent === 'number' ? tokens.get(sent) : undefined
    const entry = rid === undefined ? undefined : open.get(rid)
    if (!isObj(params) || entry?.kind !== 'call' || entry.token === undefined) return []
    const changed = { ...msg, params: { ...params, progressToken: entry.token.original } }
    return [{ to: 'link', link: entry.link, msg: changed }]
  }

  const fromChild = (msg: unknown): Effect[] => {
    if (dead || !isObj(msg)) return []
    const method = own(msg, 'method')
    const id = own(msg, 'id')
    if (typeof method === 'string') {
      if (id === undefined) {
        if (method === 'notifications/progress') return progress(msg)
        if (method !== 'notifications/tools/list_changed') return []
        return [...links.keys()].map(link => ({ to: 'link', link, msg }))
      }
      if (!isId(id)) return []
      // A request of the child reaches no link: only ping has an answer.
      return [
        { to: 'child', msg: method === 'ping' ? answer(id, {}) : failure(id, NOT_FOUND_CODE, 'Method not found') },
      ]
    }
    const done = Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error')
    return typeof id === 'number' && done ? response(id, msg) : []
  }

  return {
    attach: link => {
      if (!dead && !links.has(link)) links.set(link, { numbers: new Map(), strings: new Map() })
      return []
    },
    detach: link => {
      const held = links.get(link)
      if (dead || held === undefined) return []
      const mine = [...open.entries()]
        .flatMap(([rid, entry]): [number, Id][] =>
          entry.kind === 'call'
            ? entry.link === link
              ? [[rid, entry.id]]
              : []
            : entry.waiters.filter(w => w.link === link).map((w): [number, Id] => [rid, w.id]),
        )
        .sort((a, b) => a[0] - b[0])
      const effects = mine.flatMap(([, id]) => cancel(link, id, undefined))
      links.delete(link)
      return effects
    },
    fromLink,
    fromChild,
    died: () => {
      if (dead) return []
      dead = true
      const effects = [...open.entries()]
        .sort((a, b) => a[0] - b[0])
        .flatMap(([, entry]): Effect[] =>
          (entry.kind === 'call' ? [entry] : entry.waiters).map(w => ({
            to: 'link',
            link: w.link,
            msg: failure(w.id, DIED_CODE, 'the server process ended'),
          })),
        )
      open.clear()
      tokens.clear()
      links.clear()
      return effects
    },
    open: () => [...open.values()].reduce((n, entry) => n + (entry.kind === 'call' ? 1 : entry.waiters.length), 0),
  }
}
