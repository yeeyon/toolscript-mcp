// The tools of the downstream MCP servers, as search_tools shows them: one
// entry per tool, named mcp__<server>__<tool>, and the servers that failed.

import type { ServerKey } from './config.ts'
import { decide, shownName, type Action, type Bridges, type Policy } from './policy.ts'
import { MAX_SHAPES, learnedShape, listsAll, rankTools, type ArgSpec, type Shapes, type ToolEntry } from './protocol.ts'

/** A tool as a downstream server lists it. */
export type DownstreamTool = {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
  readonly annotations?: unknown
  readonly _meta?: unknown
}

/**
 * One downstream server: connecting, then connected with its tools or failed
 * with the reason. A connected server whose connection closes becomes failed.
 */
export type ServerState =
  | { readonly key: ServerKey; readonly status: 'connecting' }
  | { readonly key: ServerKey; readonly status: 'connected'; readonly tools: readonly DownstreamTool[] }
  | { readonly key: ServerKey; readonly status: 'failed'; readonly reason: string }
  /**
   * A lazy server with no process (issue #63, slice 5): it starts on a nested call. `tools` is the cached list of its
   * last connect. It is for display only: no policy check, approval or argument check reads it, and `catalogOf` skips it.
   */
  | { readonly key: ServerKey; readonly status: 'asleep'; readonly tools: readonly DownstreamTool[] }

/** A server that connected or failed: the states of a host with no lazy server, as `toolscript-mcp tools` and `doctor` read. */
export type SettledState = Exclude<ServerState, { readonly status: 'connecting' | 'asleep' }>

export type CatalogEntry = ToolEntry & {
  readonly server: ServerKey
  /** The name on its own server. */
  readonly tool: string
  readonly inputSchema: unknown
  /** What call() returns: the structuredContent of the result. */
  readonly outputSchema: unknown
  /** Its server marks it to need a person's approval on every call, so an allow rule does not let it run. */
  readonly requiresUserInteraction: boolean
  readonly annotations: unknown
}

/** The full name of a downstream tool, as splitToolName reads it. */
export const toolName = (server: ServerKey, tool: string): `mcp__${string}__${string}` => `mcp__${server}__${tool}`

// C0, DEL, and the 3 line separators that C0 does not hold: NEL (U+0085), LS (U+2028) and PS (U+2029).
const CONTROL = /[\u0000-\u001f\u007f\u0085\p{Zl}\p{Zp}]/u
const CONTROLS = new RegExp(CONTROL.source, 'gu')

/** JSON.stringify writes NEL, LS and PS raw, and they start a line. The escape is the same JSON value on one line. */
const json = (v: unknown): string | undefined =>
  JSON.stringify(v)?.replace(/[\u0085\p{Zl}\p{Zp}]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** Downstream text on one line, so it cannot start a block of its own, and at most `max` characters. */
const oneLine = (text: string, max: number): string => text.replace(CONTROLS, ' ').slice(0, max)

/** The mark that Claude Code documents: only the JSON true counts. */
const REQUIRES_USER_INTERACTION = 'anthropic/requiresUserInteraction'

/** Every tool of every connected server. A tool whose name is empty or holds a control character or a line separator is left out: no call can name it. */
export const catalogOf = (states: readonly ServerState[]): CatalogEntry[] =>
  states.flatMap(s =>
    s.status === 'connected'
      ? s.tools
          .filter(t => t.name !== '' && !CONTROL.test(t.name))
          .map(t => ({
            name: toolName(s.key, t.name),
            description: t.description ?? '',
            server: s.key,
            tool: t.name,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            requiresUserInteraction: isObject(t._meta) && t._meta[REQUIRES_USER_INTERACTION] === true,
            annotations: t.annotations,
          }))
      : [],
  )

/**
 * The states as `search_tools` shows them: a server that is asleep shows its cached tools as a connected one does. Only
 * the display reads this. Every check reads the live list of a connected server.
 */
export const shownStates = (states: readonly ServerState[]): ServerState[] =>
  states.map(s => (s.status === 'asleep' ? { key: s.key, status: 'connected', tools: s.tools } : s))

/** The tools whose server requires a person's approval on every call. */
export const interactiveTools = (states: readonly ServerState[]): Set<string> =>
  new Set(
    catalogOf(states)
      .filter(t => t.requiresUserInteraction)
      .map(t => t.name),
  )

/**
 * The tool names that the connected server `server` lists, or undefined when it is not connected. Rules and marks
 * match a listed name, and a server can answer a name that it does not list, so a call of another name is refused.
 */
export const listedNames = (states: readonly ServerState[], server: string): string[] | undefined => {
  const state = states.find(s => s.key === server)
  return state?.status === 'connected' ? catalogOf([state]).map(t => t.name) : undefined
}

/** What the annotations of a tool say that it does. Only the JSON true counts, and read-only wins. */
export type ToolHint = 'read-only' | 'destructive' | '-'

/** One tool of a server as `toolscript-mcp tools` prints it: no description, because its text is the server's. */
export type ToolLine = {
  readonly name: string
  readonly hint: ToolHint
  /** What the policy of the config decides for it now. */
  readonly action: Action
  /** Its server marks it to need a person's approval on each run. */
  readonly person: boolean
}

const hintOf = (annotations: unknown): ToolHint => {
  if (!isObject(annotations)) return '-'
  if (annotations.readOnlyHint === true) return 'read-only'
  return annotations.destructiveHint === true ? 'destructive' : '-'
}

export const toolLines = (
  state: Extract<ServerState, { status: 'connected' }>,
  policy: Policy,
  bridges: Bridges,
): ToolLine[] =>
  catalogOf([state]).map(t => ({
    name: t.name,
    hint: hintOf(t.annotations),
    action: decide(policy, bridges, t.name).action,
    person: t.requiresUserInteraction,
  }))

/** `mcp__demo__list_pull_requests read-only allow`. A deny rule wins over the mark, so a denied tool shows no mark. */
export const toolLineText = ({ name, hint, action, person }: ToolLine): string =>
  `${shownName(name)} ${hint} ${action}${person && action !== 'deny' ? ', a person each run' : ''}`

/** Why a call cannot reach a server now, or undefined when it is connected. */
export const notConnected = (s: ServerState): string | undefined =>
  s.status === 'connected'
    ? undefined
    : `the MCP server "${s.key}" is not connected: ${
        s.status === 'failed'
          ? s.reason
          : s.status === 'asleep'
            ? 'it is asleep and did not start. After 3 starts in 60 s a wait applies, and then it starts on the next call that names it'
            : 'it is still connecting'
      }`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// `number (min 1)[]` would read as a bound on the array, so a bounded item gets parentheses. A union item gets them
// from `grouped`.
const ofArray = (item: string): string => (item.startsWith('number (') ? `(${item})` : item)

// A bound at or past the int32 range is the default of a schema generator (zod v4 gives every integer the safe-integer
// range), not a limit that a program meets.
const INT32 = 2147483647

// The inclusive bound, or undefined. In draft-04 and OpenAPI 3.0, `exclusiveMinimum: true` makes `minimum` exclusive.
// A numeric exclusive bound hides the inclusive one when it is as tight or tighter: `tighter` says which.
const bound = (value: unknown, exclusive: unknown, tighter: (ex: number, v: number) => boolean): number | undefined =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) < INT32 &&
  exclusive !== true &&
  !(typeof exclusive === 'number' && tighter(exclusive, value))
    ? value
    : undefined

// `number (max 100)`, `number (1-100)` or `number (min 1)`, so a program does not pass a value that the server
// refuses. Only the inclusive bounds show, and only as numbers: the text comes from this code, never from the server.
// An exclusive bound is left out: it would need a second form for each case, and the inclusive one stays true. The
// dash form holds two whole numbers in order only, so `1e-7-1` or `0--5` never reads as a subtraction.
const withBounds = (base: string, schema: Record<string, unknown>): string => {
  const min = bound(schema.minimum, schema.exclusiveMinimum, (ex, v) => ex >= v)
  const max = bound(schema.maximum, schema.exclusiveMaximum, (ex, v) => ex <= v)
  if (min !== undefined && max !== undefined)
    return Number.isInteger(min) && Number.isInteger(max) && 0 <= min && min <= max
      ? `${base} (${min}-${max})`
      : `${base} (min ${min}, max ${max})`
  if (max !== undefined) return `${base} (max ${max})`
  return min !== undefined ? `${base} (min ${min})` : base
}

// The properties of an object schema, the required ones first.
const requiredFirst = (schema: Record<string, unknown>): [name: string, schema: unknown, required: boolean][] => {
  const properties = isObject(schema.properties) ? Object.entries(schema.properties) : []
  const required = Array.isArray(schema.required) ? schema.required : []
  const marked = properties.map(([name, s]): [string, unknown, boolean] => [name, s, required.includes(name)])
  return [...marked.filter(p => p[2]), ...marked.filter(p => !p[2])]
}

/**
 * The argument names and types of an input schema, the required ones first:
 * `{ project: string; limit?: number }`. A list longer than MAX_ARGS keeps
 * whole arguments and ends with the count of the others, so a required
 * argument shows whenever any argument does. Each argument first shows its
 * plain type, and the list keeps the arguments that fit with it. Then the
 * unknown of a schema with no type in a plain type becomes the type of the
 * detail view, with at most MAX_ENUM values and no nested object spelled out,
 * when the list still fits. Those arguments share one MAX_STEPS budget, and
 * each one past it reads at least ARG_STEPS schemas before it keeps its plain
 * type. The arguments past MAX_ARGS characters cannot show, so they are not read.
 */
export const argsText = (inputSchema: unknown): string => {
  const properties = isObject(inputSchema) ? requiredFirst(inputSchema) : []
  if (properties.length === 0) return '{}'
  const args: { head: string; schema: unknown; text: string; open: boolean }[] = []
  let length = 0
  for (const [name, schema, required] of properties) {
    if (length > MAX_ARGS) break
    const head = `${name}${required ? '' : '?'}: `
    let open = false
    const untyped = (): Member[] => {
      open = true
      return [asType('unknown')]
    }
    const text = oneLine(head + joined(plainParts(schema, 0, untyped)), Infinity)
    args.push({ head, schema, text, open })
    length += text.length + 2
  }
  const list = (texts: readonly string[]): string => {
    const left = properties.length - texts.length
    return `{ ${[...texts, ...(left > 0 ? [`… ${left} more arguments`] : [])].join('; ')} }`
  }
  const texts = args.map(a => a.text)
  if (list(texts).length > MAX_ARGS) {
    let shown = 0
    while (shown < texts.length && list(texts.slice(0, shown + 1)).length <= MAX_ARGS) shown++
    texts.splice(shown)
  }
  const r: Render = { root: inputSchema, maxLevel: 0, notes: false, most: MAX_ENUM, steps: { left: MAX_STEPS } }
  let room = MAX_ARGS - list(texts).length
  texts.forEach((plain, i) => {
    const a = args[i]!
    if (!a.open) return
    r.steps.left = Math.max(r.steps.left, ARG_STEPS)
    const types = typeMembers(a.schema, (s, nest) => members(s, r, 0, nest))
    const text = types && oneLine(a.head + joined(types), Infinity)
    if (text === undefined || text.length - plain.length > room) return
    room -= text.length - plain.length
    texts[i] = text
  })
  return list(texts)
}

// The type of an argument as the short list showed it before it read unions, consts and refs: an enum in full, else
// the type alone, with `untyped` for a schema with no type. Each type of a list shows once, so a list that repeats
// array cannot double the text at each level.
const plainParts = (schema: unknown, nest: number, untyped: (schema: unknown, nest: number) => Member[]): Member[] => {
  const unknown = asType('unknown')
  if (!isObject(schema) || nest > MAX_NEST) return [unknown]
  if (Array.isArray(schema.enum))
    return schema.enum.length === 0 ? [asType('never')] : schema.enum.map(v => asType(json(v) ?? 'unknown'))
  if (schema.type === undefined) return untyped(schema, nest)
  const types = new Set<unknown>(Array.isArray(schema.type) ? schema.type.flat(MAX_NEST) : [schema.type])
  const parts = [...types].map(t =>
    t === 'array'
      ? asType(`${ofArray(grouped(plainParts(schema.items, nest + 1, untyped)))}[]`)
      : t === 'integer' || t === 'number'
        ? asType(withBounds('number', schema))
        : typeof t === 'string'
          ? asType(t)
          : unknown,
  )
  return parts.length > 0 ? parts : [unknown]
}

// The plain type of an argument with the type of the detail view for each schema with no type, or undefined when the
// steps of the list are spent.
const typeMembers = (schema: unknown, untyped: (schema: unknown, nest: number) => Member[]): Member[] | undefined => {
  try {
    return plainParts(schema, 0, untyped)
  } catch (e) {
    if (e === TOO_LARGE) return undefined
    throw e
  }
}

const MAX_ARGS = 500
// The steps that each argument of the short list can spend after the arguments before it spent MAX_STEPS.
const ARG_STEPS = 20

// Keys next to the properties that can allow more argument names.
const MORE_NAMES = [
  'patternProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependencies',
  '$ref',
]

/**
 * What an input schema says of a tool's arguments, for the check before a run.
 * A schema with no properties allows any names, as does one that sets
 * `additionalProperties` to anything but false, or one with a key in
 * MORE_NAMES. Without them, other names are typos, as in the generated types
 * of the plugin. A required name is a known name, also when the properties
 * leave it out. Undefined when the schema has no properties object.
 */
export const argSpec = (inputSchema: unknown): ArgSpec | undefined => {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return undefined
  const properties = Object.keys(inputSchema.properties)
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((n): n is string => typeof n === 'string')
    : []
  const names = [...new Set([...properties, ...required])]
  const extra = inputSchema.additionalProperties
  const more = MORE_NAMES.some(k => Object.hasOwn(inputSchema, k))
  return { names, required, isOpen: properties.length === 0 || more || (extra !== undefined && extra !== false) }
}

const notConnectedText = (states: readonly ServerState[]): string => {
  const lines = states.flatMap(s =>
    s.status === 'failed'
      ? [`- ${s.key}: ${oneLine(s.reason, 500)}`]
      : s.status === 'connecting'
        ? [`- ${s.key}: still connecting. Search again in a moment.`]
        : [],
  )
  return lines.length === 0 ? '' : `\n\n## Not connected\n${lines.join('\n')}`
}

/** Two tools of different servers with the same short name, description, schemas and mark. Compares the source fields. */
const isTwin = (a: CatalogEntry, b: CatalogEntry): boolean =>
  a.tool === b.tool &&
  a.description === b.description &&
  a.requiresUserInteraction === b.requiresUserInteraction &&
  JSON.stringify(a.inputSchema) === JSON.stringify(b.inputSchema) &&
  JSON.stringify(a.outputSchema) === JSON.stringify(b.outputSchema)

/** Most full blocks that search_tools shows. More hits show one line each, so a broad search stays short. */
const DETAIL_HITS = 3
/**
 * Most characters of all full blocks, hit 1 included, when more than DETAIL_HITS tools match. Hit 1 shows in full
 * also when it alone is longer.
 */
const DETAIL_BUDGET = 4000
const MAX_DESCRIPTION = 2000
const MAX_DECLARATION = 3000
const MAX_NOTE = 200
const MAX_LITERAL = 500
const MAX_POINTER = 1000
const MAX_ENUM = 25
// Each schema a declaration reads costs a step. A schema whose refs and unions
// branch can need more steps than its size: such a declaration is too large.
const MAX_STEPS = 2000
// The deepest object a declaration spells out: the arguments are level 1.
const MAX_LEVEL = 3
// Unions, arrays and refs nested in each other with no object between them.
const MAX_NEST = 12
const MAX_REF_HOPS = 8

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Downstream text with its white space collapsed, at most `max` characters. */
const prose = (text: string, max: number): string => oneLine(text.replace(/\s+/g, ' ').trim(), max)

const jsonType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'unknown[]' : typeof v)

// A value in full, or its type when it is too long: a cut value is a different value. A long string is not written
// out, and an object is written once: many refs can lead to one large value.
const literal = (v: unknown): string =>
  typeof v === 'string' && v.length > MAX_LITERAL
    ? 'string /* long value left out */'
    : typeof v === 'object' && v !== null
      ? once(LITERALS, v, written)
      : written(v)

const LITERALS = new WeakMap<object, string>()
const written = (v: unknown): string => {
  const text = json(v) ?? 'unknown'
  return text.length <= MAX_LITERAL ? text : `${jsonType(v)} /* long value left out */`
}

// A local JSON pointer such as #/$defs/Filter, read in the root schema. A pointer longer than MAX_POINTER is not read:
// many refs can name it.
const pointed = (root: unknown, ref: string): unknown => {
  if (!ref.startsWith('#') || ref.length > MAX_POINTER) return undefined
  let at: unknown = root
  for (const part of ref.slice(1).split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(at) || !Object.hasOwn(at, key)) return undefined
    at = at[key]
  }
  return at
}

// The keys that add to the type of a schema. Next to one of them, an allOf is an intersection.
const TYPE_KEYS = ['$ref', 'type', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf']

// The schema with each $ref followed, and an allOf of one schema opened when
// nothing next to it adds to the type. A ref that cannot be read or that loops
// gives undefined, shown as unknown. A type next to a $ref adds to it, as an allOf.
const resolve = (schema: unknown, root: unknown): unknown => {
  for (let hops = 0; hops < MAX_REF_HOPS; hops++) {
    if (isObject(schema) && typeof schema.$ref === 'string') {
      if (schema.type === undefined) schema = pointed(root, schema.$ref)
      else return once(TYPED_REFS, schema, ({ $ref, ...rest }) => ({ allOf: [rest, { $ref }] }))
    } else if (
      isObject(schema) &&
      Array.isArray(schema.allOf) &&
      schema.allOf.length === 1 &&
      !TYPE_KEYS.some(k => Object.hasOwn(schema as object, k))
    )
      schema = schema.allOf[0]
    else return schema
  }
  return undefined
}

// The copies of a schema that `resolve` and `members` read, made once: many refs can lead to a schema with many keys.
const TYPED_REFS = new WeakMap<Record<string, unknown>, unknown>()
const NEXT_TO_ALL_OF = new WeakMap<Record<string, unknown>, unknown>()

// `steps` is shared by the input and the output types of one declaration, and by the arguments of one short list.
type Render = {
  readonly root: unknown
  readonly maxLevel: number
  readonly notes: boolean
  // The most values that a union shows: MAX_ENUM in the short list, all in the detail view.
  readonly most: number
  readonly steps: { left: number }
}

const TOO_LARGE = new Error('declaration too large')

const PRIMITIVES: Record<string, string> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  null: 'null',
}

// A member of a union: a type, or a value of a const or an enum, which a long union can leave out. A null is a type.
type Member = { readonly text: string; readonly value: boolean }

const asType = (text: string): Member => ({ text, value: false })

// Stands where a union left out values.
const MORE = asType('…')

const joined = (members: readonly Member[]): string => members.map(m => m.text).join(' | ')

// The members of a const or an enum, or undefined for any other schema. An enum is cut at MAX_ENUM values, and keeps
// its null.
const valueParts = (schema: Record<string, unknown>): Member[] | undefined => {
  const value = (v: unknown): Member => ({ text: literal(v), value: v !== null })
  if ('const' in schema) return [value(schema.const)]
  if (!Array.isArray(schema.enum)) return undefined
  if (schema.enum.length === 0) return [asType('never')]
  const shown = [...schema.enum.slice(0, MAX_ENUM), ...(once(NULLS, schema.enum, e => e.includes(null)) ? [null] : [])]
  return unionOf(shown.map(value), MAX_ENUM, schema.enum.length > MAX_ENUM)
}

// A fact of an array or an object of a schema, read once: many refs can lead to one long enum, union or value.
const once = <K extends object, T>(facts: WeakMap<K, T>, key: K, read: (key: K) => T): T => {
  if (!facts.has(key)) facts.set(key, read(key))
  return facts.get(key)!
}

// Whether an enum holds null.
const NULLS = new WeakMap<unknown[], boolean>()
// The parts of a union that a list of at most MAX_ENUM values reads: all but a const that an earlier part shows, and
// the consts past MAX_ENUM other values. `more` says that a value was left out. A null const is a type.
const SHORT_READS = new WeakMap<unknown[], { read: unknown[]; more: boolean }>()
const shortRead = (union: unknown[]): { read: unknown[]; more: boolean } => {
  const values = new Set<string>()
  let more = false
  const read = union.filter(s => {
    if (!isObject(s) || !('const' in s) || s.const === null) return true
    const text = literal(s.const)
    if (values.has(text)) return false
    if (values.size >= MAX_ENUM) {
      more = true
      return false
    }
    values.add(text)
    return true
  })
  return { read, more }
}

// The members of a union, each one once, with its first `most` values and all its types. A `…` stands where values
// were left out, or at the end when `more` says that the schema had more, and never twice in a row.
const unionOf = (parts: readonly Member[], most: number, more = false): Member[] => {
  const seen = new Set<string>()
  const shown: Member[] = []
  let values = 0
  for (const p of more ? [...parts, MORE] : parts) {
    if (p !== MORE && seen.has(p.text)) continue
    seen.add(p.text)
    const m = p.value && ++values > most ? MORE : p
    if (m !== MORE || shown.at(-1) !== MORE) shown.push(m)
  }
  return shown
}

const grouped = (parts: readonly Member[]): string => (parts.length === 1 ? parts[0]!.text : `(${joined(parts)})`)

// The members of a schema's type: more than one for a union. `level` is the
// level of the object around it, which sets the indent of a nested object.
// `as` reads the schema as one type of its type list, so the schema is not copied for each type.
const members = (raw: unknown, r: Render, level: number, nest: number, as?: unknown): Member[] => {
  if (--r.steps.left < 0) throw TOO_LARGE
  const schema = resolve(raw, r.root)
  if (!isObject(schema) || nest > MAX_NEST) return [asType('unknown')]
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // The schema next to the allOf is one more part. A part that is only
    // object or unknown, or that an earlier part shows, adds nothing.
    // A loop, not a map: a map makes an array as long as the allOf before it reads a part.
    const part = (s: unknown): string => grouped(members(s, r, level, nest + 1))
    const parts = [part(once(NEXT_TO_ALL_OF, schema, ({ allOf, ...rest }) => rest))]
    for (const s of schema.allOf) parts.push(part(s))
    const shown = [...new Set(parts.filter(p => p !== 'object' && p !== 'unknown'))]
    return [asType(shown.length > 0 ? shown.join(' & ') : parts.includes('object') ? 'object' : 'unknown')]
  }
  const values = valueParts(schema)
  if (values) return values
  const type = (as === undefined ? schema.type : as) ?? (isObject(schema.properties) ? 'object' : undefined)
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []
  if (union.length > 0) {
    // The short list reads no const that it cannot show, so a long union of consts costs few steps.
    const { read, more } = r.most <= MAX_ENUM ? once(SHORT_READS, union, shortRead) : { read: union, more: false }
    const parts = read.flatMap(s => members(s, r, level, nest + 1))
    // A union that names no type, such as a oneOf of required lists, leaves the type next to it.
    if (type === undefined || parts.some(p => p.text !== 'unknown')) return unionOf(parts, r.most, more)
  }
  if (Array.isArray(type))
    return type.length === 0
      ? [asType('unknown')]
      : unionOf(
          type.flatMap(t => members(schema, r, level, nest + 1, t)),
          Infinity,
        )
  if (type === 'object') return [asType(objectType(schema, r, level + 1, nest + 1))]
  if (type === 'array') return [asType(`${ofArray(grouped(members(schema.items, r, level, nest + 1)))}[]`)]
  if (type === 'number' || type === 'integer') return [asType(withBounds('number', schema))]
  return [asType(typeof type === 'string' && Object.hasOwn(PRIMITIVES, type) ? PRIMITIVES[type]! : 'unknown')]
}

const typeText = (schema: unknown, r: Render, level: number, nest: number): string =>
  joined(members(schema, r, level, nest))

// The description of a property, or of the schema its $ref names, as a line comment.
const noteOf = (schema: unknown, root: unknown): string => {
  const resolved = resolve(isObject(schema) && typeof schema.$ref === 'string' ? { $ref: schema.$ref } : schema, root)
  const own = isObject(schema) ? schema.description : undefined
  const text = typeof own === 'string' ? own : isObject(resolved) ? resolved.description : undefined
  const note = typeof text === 'string' ? prose(text, MAX_NOTE) : ''
  return note === '' ? '' : ` // ${note}`
}

// An object type at `level`, one property to a line, the required ones first.
// The note goes on the first line of the property, where a nested object opens.
const objectType = (schema: Record<string, unknown>, r: Render, level: number, nest: number): string => {
  if (level > r.maxLevel) return 'object'
  const properties = requiredFirst(schema)
  if (properties.length === 0) {
    const extra = schema.additionalProperties
    return isObject(extra) ? `{ [key: string]: ${typeText(extra, r, level, nest + 1)} }` : 'object'
  }
  const pad = '  '.repeat(level)
  const lines = properties.map(([name, s, required]) => {
    const key = `${IDENTIFIER.test(name) ? name : json(name)}${required ? '' : '?'}`
    const [first, ...rest] = typeText(s, r, level, nest + 1).split('\n')
    return [`${pad}${key}: ${first}${r.notes ? noteOf(s, r.root) : ''}`, ...rest].join('\n')
  })
  return `{\n${lines.join('\n')}\n${'  '.repeat(level - 1)}}`
}

// The call() of a tool as a TypeScript declaration, with objects spelled out to
// `maxLevel`. With notes, it also returns a Promise of the outputSchema, when
// the tool has one. Undefined when it is too large to show.
const declaration = (t: CatalogEntry, maxLevel: number, notes: boolean): string | undefined => {
  const steps = { left: MAX_STEPS }
  try {
    const args = typeText(t.inputSchema, { root: t.inputSchema, maxLevel, notes, most: Infinity, steps }, 0, 0)
    const returns =
      t.outputSchema === undefined || !notes
        ? ''
        : `: Promise<${typeText(t.outputSchema, { root: t.outputSchema, maxLevel, notes, most: Infinity, steps }, 0, 0)}>`
    const call = `call(${JSON.stringify(t.name)}, ${args === 'object' || args === 'unknown' ? '{}' : args})${returns}`
    return call.length <= MAX_DECLARATION ? call : undefined
  } catch (e) {
    if (e === TOO_LARGE) return undefined
    throw e
  }
}

// A tool in full. A declaration too large to show loses its nested objects
// first, then its notes and its result type, and last its argument types
// past MAX_ARGS characters.
const detailBlock = (t: CatalogEntry, shapes: ReadonlyMap<string, string>, canAsk: boolean): string => {
  const call =
    declaration(t, MAX_LEVEL, true) ??
    declaration(t, 1, true) ??
    declaration(t, 1, false) ??
    `call(${JSON.stringify(t.name)}, ${argsText(t.inputSchema)})`
  const shape = t.outputSchema === undefined ? shapes.get(t.name) : undefined
  const lines = [`### ${t.name}`, prose(t.description, MAX_DESCRIPTION), ...personNote(t, canAsk), call]
  if (shape !== undefined) lines.push(`returned earlier: ${shape}`)
  return lines.filter(line => line !== '').join('\n')
}

const summaryBlock = (t: CatalogEntry, canAsk: boolean): string =>
  [
    `### ${t.name}`,
    oneLine(t.description.split('\n')[0] ?? '', 300),
    ...personNote(t, canAsk),
    `args: ${argsText(t.inputSchema)}`,
  ].join('\n')

// An allow rule does not let such a tool run, and only a name written as a string is asked before the run.
const personNote = (t: CatalogEntry, canAsk: boolean): string[] =>
  t.requiresUserInteraction
    ? [
        `A person approves each run that calls it. ${
          canAsk
            ? 'Write its name as a string in call("…").'
            : 'This MCP client cannot ask the person, so a program cannot call it.'
        }`,
      ]
    : []

/**
 * Keeps the shape of a tool's result for search_tools, for the session. A
 * shape with an empty array does not replace a known one: it hides the fields
 * of the items.
 */
export const learnShape = (shapes: Map<string, string>, tool: string, value: unknown): void => {
  const shape = learnedShape(value)
  if (shape === undefined || (shapes.has(tool) && shape.includes('[]'))) return
  if (!shapes.has(tool) && shapes.size >= MAX_SHAPES) return
  shapes.set(tool, shape)
}

/**
 * The shapes that `search_tools` shows: the ones this session learned, and the stored ones (from the shapes file)
 * of the tools that are listed now, when the hash of the tool's `inputSchema` is the one stored with the shape.
 * A tool whose schema changed shows no stored shape, also when its server connected again after the start. A
 * stored shape of a server that is not connected is not shown and not removed. `hash` is the host's, because
 * core has no Node module.
 */
export const shownShapes = (
  states: readonly ServerState[],
  learned: ReadonlyMap<string, string>,
  stored: Shapes,
  hash: (inputSchema: unknown) => string,
): Map<string, string> => {
  const shown = new Map<string, string>()
  for (const t of catalogOf(states)) {
    const entry = Object.hasOwn(stored, t.name) ? stored[t.name] : undefined
    if (entry !== undefined && entry.schema === hash(t.inputSchema)) shown.set(t.name, entry.shape)
  }
  for (const [tool, shape] of learned) shown.set(tool, shape)
  return shown
}

const ECHO_MAX = 200
/** Most tool names that the list of a search with no match holds, for all servers together. */
const NAMES_CAP = 60

/**
 * The short tool names of each server, one line each, in the order of the servers: `mcp__<key>__: a, b (+N more)`.
 * The servers take one name each in turn until NAMES_CAP names are listed, so a large server does not hide the
 * others. The names of a server are sorted. `all` comes from catalogOf, which drops names with control characters or line separators.
 */
export const namesByServer = (all: readonly CatalogEntry[], cap = NAMES_CAP): string[] => {
  const byServer = new Map<string, string[]>()
  for (const t of all) {
    const names = byServer.get(t.server)
    if (names === undefined) byServer.set(t.server, [t.tool])
    else names.push(t.tool)
  }
  const servers = [...byServer].map(([key, names]) => ({ key, names: names.sort(), shown: 0 }))
  let room = cap
  for (let round = 0; room > 0; round++) {
    const open = servers.filter(s => s.names.length > round)
    if (open.length === 0) break
    for (const s of open.slice(0, room)) s.shown++
    room -= Math.min(open.length, room)
  }
  return servers
    .filter(s => s.shown > 0)
    .map(s => {
      const more = s.names.length - s.shown
      return `mcp__${s.key}__: ${s.names.slice(0, s.shown).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
    })
}

const ACTION_PROPERTIES = ['action', 'method', 'operation']
const MAX_ACTION_VALUE = 40
const MAX_ACTION_WORDS = 50

/**
 * The words of the string values of the `enum` of the top-level argument `action`, `method` or `operation`, for the
 * rank only: a tool such as `repo_pull_request_write` names its verbs in that enum and nowhere else. It reads the first
 * MAX_ENUM values, each of at most MAX_ACTION_VALUE characters, and keeps at most MAX_ACTION_WORDS words. Any other
 * schema (`$ref`, `anyOf`, `const`, a nested object) gives an empty set.
 */
export const actionWords = (inputSchema: unknown): ReadonlySet<string> => {
  const words = new Set<string>()
  if (!isObject(inputSchema) || !Object.hasOwn(inputSchema, 'properties')) return words
  const properties = inputSchema.properties
  if (!isObject(properties)) return words
  for (const key of ACTION_PROPERTIES) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (!isObject(property) || !Array.isArray(property.enum)) continue
    for (let i = 0; i < property.enum.length && i < MAX_ENUM; i++) {
      const value: unknown = property.enum[i]
      if (typeof value !== 'string' || value.length > MAX_ACTION_VALUE) continue
      for (const word of value.toLowerCase().split(/[^a-z0-9]+/))
        if (word !== '' && words.size < MAX_ACTION_WORDS) words.add(word)
    }
  }
  return words
}

/**
 * The text of a search_tools result: the best matches, then the servers that
 * are not connected. A query with words shows its first DETAIL_HITS matches in
 * full, with the shape of a result seen earlier in the session (`shapes`, by
 * tool name). With more matches than that, hit 1 shows in full always, and
 * hits 2 and 3 only while all full blocks, hit 1 included, total DETAIL_BUDGET
 * characters or less. The first hit that does not fit and all later ones show as
 * summaries, so the full hits are a prefix of the rank order. A twin of a full
 * hit above (same short name, description, schemas and mark) is a heading and a
 * line that names that hit, anywhere in the result. It takes no place of
 * DETAIL_HITS and no budget, so those count full blocks. A list of all
 * tools shows summaries only, so the check of the servers with limit 1 stays
 * short. With no match, the result lists the tool names by server. `canAsk`:
 * the client can show an approval prompt.
 */
export const searchResult = (
  states: readonly ServerState[],
  query: string,
  limit: number,
  shapes: ReadonlyMap<string, string> = new Map(),
  canAsk = true,
): string => {
  const all = catalogOf(states)
  const found = rankTools(
    all.map(t => ({ ...t, actions: actionWords(t.inputSchema) })),
    query,
    limit,
  )
  const tail = notConnectedText(states)
  if (found.length === 0) {
    const shown = query.length > ECHO_MAX ? `${query.slice(0, ECHO_MAX)}... (${query.length} characters)` : query
    const head = `No MCP tool matches "${shown}". ${all.length} MCP tools are connected.`
    if (all.length === 0) return `${head}${tail}`
    const lines = namesByServer(all)
    const rest = all.length > NAMES_CAP ? '\nA narrower word, or `mcp__<key>__` in the query, finds the rest.' : ''
    return `${head}\n${lines.join('\n')}${rest}${tail}`
  }
  const blocks: string[] = []
  if (listsAll(query)) blocks.push(...found.map(t => summaryBlock(t, canAsk)))
  else {
    // Hit 1 shows in full always. The next hits show in full while they fit, and the first one that does not ends it.
    // A twin of a full hit above is a heading and one line, and takes no full place and no budget.
    const few = found.length <= DETAIL_HITS
    const fulls: CatalogEntry[] = []
    let used = 0
    let full = true
    for (const t of found) {
      const twin = fulls.find(f => isTwin(f, t))
      if (twin !== undefined) {
        blocks.push(`### ${t.name}\nthe same description and arguments as ${twin.name}`)
        continue
      }
      const detail = full && fulls.length < DETAIL_HITS ? detailBlock(t, shapes, canAsk) : undefined
      if (detail !== undefined && (fulls.length === 0 || few || used + detail.length <= DETAIL_BUDGET)) {
        used += detail.length
        fulls.push(t)
        blocks.push(detail)
      } else {
        full = false
        blocks.push(summaryBlock(t, canAsk))
      }
    }
  }
  return `${found.length} of ${all.length} MCP tools.\n\n${blocks.join('\n\n')}${tail}`
}
