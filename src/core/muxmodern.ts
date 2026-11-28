// The parts of the router (src/core/mux.ts) that only the 2026-07-28 era uses: the test of a discover result, the size of a
// `_meta`, the stamp of a listen stream, and the `requestState` strings that a link may send back. Pure, like the router:
// no Node module, timer, clock or random, and it never changes a message that it gets.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Obj, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined)

/** The key that a child stamps on each message of a `subscriptions/listen` stream: the id of the listen request. */
export const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId'
/** The most characters of the JSON of one `_meta` that the router forwards. */
export const META_CHARS = 8192
/** The most characters of one `requestState` that the router keeps, and how many for each link. */
export const STATE_CHARS = 8192
export const STATES_PER_LINK = 64
const FIRST_MODERN = '2026-07-28'
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for a result of `server/discover` whose `supportedVersions` has a date at or after 2026-07-28. Any other answer is no evidence. */
export const isModernDiscover = (msg: Obj): boolean => {
  const result = own(msg, 'result')
  if (!isObj(result) || Object.hasOwn(msg, 'error')) return false
  const versions = own(result, 'supportedVersions')
  return Array.isArray(versions) && versions.some(v => typeof v === 'string' && DATE.test(v) && v >= FIRST_MODERN)
}

/** True when the JSON of `params._meta` is longer than META_CHARS, or cannot be measured. */
export const metaTooLong = (params: unknown): boolean => {
  const meta = isObj(params) ? own(params, '_meta') : undefined
  if (meta === undefined) return false
  try {
    return (JSON.stringify(meta) ?? '').length > META_CHARS
  } catch {
    return true
  }
}

/** The stream stamp of a notification, when it is a number: the router id of a stream. A string form is no stamp. */
export const stampOf = (msg: Obj): number | undefined => {
  const params = own(msg, 'params')
  const meta = isObj(params) ? own(params, '_meta') : undefined
  const stamp = isObj(meta) ? own(meta, SUBSCRIPTION_ID) : undefined
  return typeof stamp === 'number' ? stamp : undefined
}

/** The notification with its stamp set to `id`, the id that the link sent for the listen request. */
export const restamped = (msg: Obj, id: string | number): Obj => {
  const params = own(msg, 'params')
  const meta = isObj(params) ? own(params, '_meta') : undefined
  if (!isObj(params) || !isObj(meta)) return msg
  return { ...msg, params: { ...params, _meta: { ...meta, [SUBSCRIPTION_ID]: id } } }
}

/** The result that ends a stream, with its stamp set to `id` when it has one. A stamp of the child never reaches the link. */
export const restampedResult = (msg: Obj, id: string | number): Obj => {
  const result = own(msg, 'result')
  const meta = isObj(result) ? own(result, '_meta') : undefined
  if (!isObj(result) || !isObj(meta) || !Object.hasOwn(meta, SUBSCRIPTION_ID)) return msg
  return { ...msg, result: { ...result, _meta: { ...meta, [SUBSCRIPTION_ID]: id } } }
}

/** The `requestState` of an `input_required` result that is worth keeping, or undefined. */
export const inputRequiredState = (msg: Obj): string | undefined => {
  const result = own(msg, 'result')
  if (!isObj(result) || own(result, 'resultType') !== 'input_required') return undefined
  const state = own(result, 'requestState')
  return typeof state === 'string' && state.length <= STATE_CHARS ? state : undefined
}

/** Keeps `state` as the newest of the set, and the oldest go past STATES_PER_LINK. */
export const remember = (states: Set<string>, state: string): void => {
  states.delete(state)
  states.add(state)
  for (const oldest of states) {
    if (states.size <= STATES_PER_LINK) break
    states.delete(oldest)
  }
}

/** True when the params carry a `requestState` that the link does not hold. A request with none is fine. */
export const foreignState = (params: unknown, states: ReadonlySet<string>): boolean => {
  if (!isObj(params) || !Object.hasOwn(params, 'requestState')) return false
  const state = params['requestState']
  return !(typeof state === 'string' && states.has(state))
}
