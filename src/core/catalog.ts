// The tools of the downstream MCP servers, as search_tools shows them: one
// entry per tool, named mcp__<server>__<tool>, and the servers that failed.

import type { ServerKey } from './config.ts'
import { learnedShape, rankTools, type ArgSpec, type ToolEntry } from './protocol.ts'

/** A tool as a downstream server lists it. */
export type DownstreamTool = {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
}

/**
 * One downstream server: connecting, then connected with its tools or failed
 * with the reason. A connected server whose connection closes becomes failed.
 */
export type ServerState =
  | { readonly key: ServerKey; readonly status: 'connecting' }
  | { readonly key: ServerKey; readonly status: 'connected'; readonly tools: readonly DownstreamTool[] }
  | { readonly key: ServerKey; readonly status: 'failed'; readonly reason: string }

export type CatalogEntry = ToolEntry & {
  readonly server: ServerKey
  /** The name on its own server. */
  readonly tool: string
  readonly inputSchema: unknown
  /** What call() returns: the structuredContent of the result. */
  readonly outputSchema: unknown
}

/** The full name of a downstream tool, as splitToolName reads it. */
export const toolName = (server: ServerKey, tool: string): `mcp__${string}__${string}` => `mcp__${server}__${tool}`

const CONTROL = /[\u0000-\u001f\u007f]/
const CONTROLS = new RegExp(CONTROL.source, 'g')

/** Downstream text on one line, so it cannot start a block of its own, and at most `max` characters. */
const oneLine = (text: string, max: number): string => text.replace(CONTROLS, ' ').slice(0, max)

/** Every tool of every connected server. A tool whose name is empty or holds a control character is left out: no call can name it. */
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
          }))
      : [],
  )

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// An empty enum allows no value. An empty type list is not a valid schema.
const typeOf = (schema: unknown): string => {
  if (!isObject(schema)) return 'unknown'
  if (Array.isArray(schema.enum))
    return schema.enum.length === 0 ? 'never' : schema.enum.map(v => JSON.stringify(v)).join(' | ')
  const type = schema.type
  if (Array.isArray(type))
    return type.length === 0 ? 'unknown' : type.map(t => typeOf({ ...schema, type: t })).join(' | ')
  if (type === 'array') return `${typeOf(schema.items)}[]`
  if (type === 'integer') return 'number'
  if (typeof type === 'string') return type
  return 'unknown'
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
 * argument shows whenever any argument does.
 */
export const argsText = (inputSchema: unknown): string => {
  const parts = (isObject(inputSchema) ? requiredFirst(inputSchema) : []).map(([name, schema, required]) =>
    oneLine(`${name}${required ? '' : '?'}: ${typeOf(schema)}`, Infinity),
  )
  if (parts.length === 0) return '{}'
  const all = `{ ${parts.join('; ')} }`
  if (all.length <= MAX_ARGS) return all
  const cut = (shown: number): string =>
    `{ ${[...parts.slice(0, shown), `… ${parts.length - shown} more arguments`].join('; ')} }`
  let shown = 0
  while (shown < parts.length && cut(shown + 1).length <= MAX_ARGS) shown++
  return cut(shown)
}

const MAX_ARGS = 500

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
 * of the plugin. Undefined when the schema has no properties object.
 */
export const argSpec = (inputSchema: unknown): ArgSpec | undefined => {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return undefined
  const names = Object.keys(inputSchema.properties)
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((n): n is string => typeof n === 'string')
    : []
  const extra = inputSchema.additionalProperties
  const more = MORE_NAMES.some(k => Object.hasOwn(inputSchema, k))
  return { names, required, isOpen: names.length === 0 || more || (extra !== undefined && extra !== false) }
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

/** Most hits that search_tools shows in full. More hits show one line each, so a broad search stays short. */
const DETAIL_HITS = 3
const MAX_DESCRIPTION = 2000
const MAX_DECLARATION = 3000
const MAX_NOTE = 200
const MAX_LITERAL = 500
const MAX_ENUM = 25
// Each schema a declaration reads costs a step. A schema whose refs and unions
// branch can need more steps than its size: such a declaration is too large.
const MAX_STEPS = 2000
// The deepest object a declaration spells out: the arguments are level 1.
const MAX_LEVEL = 3
// Unions, arrays and refs nested in each other with no object between them.
const MAX_NEST = 12
const MAX_REF_HOPS = 8
const MAX_SHAPES = 500

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Downstream text with its white space collapsed, at most `max` characters. */
const prose = (text: string, max: number): string => oneLine(text.replace(/\s+/g, ' ').trim(), max)

const jsonType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'unknown[]' : typeof v)

// A value in full, or its type when it is too long: a cut value is a different value.
const literal = (v: unknown): string => {
  const text = JSON.stringify(v) ?? 'unknown'
  return text.length <= MAX_LITERAL ? text : `${jsonType(v)} /* long value left out */`
}

// A local JSON pointer such as #/$defs/Filter, read in the root schema.
const pointed = (root: unknown, ref: string): unknown => {
  if (!ref.startsWith('#')) return undefined
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
// gives undefined, shown as unknown.
const resolve = (schema: unknown, root: unknown): unknown => {
  for (let hops = 0; hops < MAX_REF_HOPS; hops++) {
    if (isObject(schema) && typeof schema.$ref === 'string') schema = pointed(root, schema.$ref)
    else if (
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

// `steps` is shared by the input and the output types of one declaration.
type Render = {
  readonly root: unknown
  readonly maxLevel: number
  readonly notes: boolean
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

const grouped = (parts: readonly string[]): string => (parts.length === 1 ? parts[0]! : `(${parts.join(' | ')})`)

// The members of a schema's type: more than one for a union. `level` is the
// level of the object around it, which sets the indent of a nested object.
const members = (raw: unknown, r: Render, level: number, nest: number): string[] => {
  if (--r.steps.left < 0) throw TOO_LARGE
  const schema = resolve(raw, r.root)
  if (!isObject(schema) || nest > MAX_NEST) return ['unknown']
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // The schema next to the allOf is one more part. A part that is only
    // object or unknown adds nothing to the others.
    const { allOf, ...rest } = schema
    const parts = [rest, ...allOf].map(s => grouped(members(s, r, level, nest + 1)))
    const shown = parts.filter(p => p !== 'object' && p !== 'unknown')
    return [shown.length > 0 ? shown.join(' & ') : parts.includes('object') ? 'object' : 'unknown']
  }
  if ('const' in schema) return [literal(schema.const)]
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return ['never']
    const shown = [...new Set(schema.enum.slice(0, MAX_ENUM).map(literal))]
    return schema.enum.length > MAX_ENUM ? [...shown, '…'] : shown
  }
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []
  if (union.length > 0) return union.flatMap(s => members(s, r, level, nest + 1))
  const type = schema.type ?? (isObject(schema.properties) ? 'object' : undefined)
  if (Array.isArray(type))
    return type.length === 0 ? ['unknown'] : type.flatMap(t => members({ ...schema, type: t }, r, level, nest + 1))
  if (type === 'object') return [objectType(schema, r, level + 1, nest + 1)]
  if (type === 'array') return [`${grouped(members(schema.items, r, level, nest + 1))}[]`]
  return [typeof type === 'string' && Object.hasOwn(PRIMITIVES, type) ? PRIMITIVES[type]! : 'unknown']
}

const typeText = (schema: unknown, r: Render, level: number, nest: number): string =>
  members(schema, r, level, nest).join(' | ')

// The description of a property, or of the schema its $ref names, as a line comment.
const noteOf = (schema: unknown, root: unknown): string => {
  const resolved = resolve(schema, root)
  const own = isObject(schema) ? schema.description : undefined
  const text = typeof own === 'string' ? own : isObject(resolved) ? resolved.description : undefined
  const note = typeof text === 'string' ? prose(text, MAX_NOTE) : ''
  return note === '' ? '' : ` // ${note}`
}

// An object type at `level`, one property to a line, the required ones first.
// The note goes on the first line of the property, where a nested object opens.
const objectType = (schema: Record<string, unknown>, r: Render, level: number, nest: number): string => {
  const properties = requiredFirst(schema)
  if (level > r.maxLevel) return 'object'
  if (properties.length === 0) {
    const extra = schema.additionalProperties
    return isObject(extra) ? `{ [key: string]: ${typeText(extra, r, level, nest + 1)} }` : 'object'
  }
  const pad = '  '.repeat(level)
  const lines = properties.map(([name, s, required]) => {
    const key = `${IDENTIFIER.test(name) ? name : JSON.stringify(name)}${required ? '' : '?'}`
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
    const args = typeText(t.inputSchema, { root: t.inputSchema, maxLevel, notes, steps }, 0, 0)
    const returns =
      t.outputSchema === undefined || !notes
        ? ''
        : `: Promise<${typeText(t.outputSchema, { root: t.outputSchema, maxLevel, notes, steps }, 0, 0)}>`
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
const detailBlock = (t: CatalogEntry, shapes: ReadonlyMap<string, string>): string => {
  const call =
    declaration(t, MAX_LEVEL, true) ??
    declaration(t, 1, true) ??
    declaration(t, 1, false) ??
    `call(${JSON.stringify(t.name)}, ${argsText(t.inputSchema)})`
  const shape = t.outputSchema === undefined ? shapes.get(t.name) : undefined
  const lines = [`### ${t.name}`, prose(t.description, MAX_DESCRIPTION), call]
  if (shape !== undefined) lines.push(`returned earlier: ${shape}`)
  return lines.filter(line => line !== '').join('\n')
}

const summaryBlock = (t: CatalogEntry): string =>
  `### ${t.name}\n${oneLine(t.description.split('\n')[0] ?? '', 300)}\nargs: ${argsText(t.inputSchema)}`

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
 * The text of a search_tools result: the best matches, then the servers that
 * are not connected. Up to DETAIL_HITS matches show in full, with the shape of
 * a result seen earlier in the session (`shapes`, by tool name).
 */
export const searchResult = (
  states: readonly ServerState[],
  query: string,
  limit: number,
  shapes: ReadonlyMap<string, string> = new Map(),
): string => {
  const all = catalogOf(states)
  const found = rankTools(all, query, limit)
  const tail = notConnectedText(states)
  if (found.length === 0) return `No MCP tool matches "${query}". ${all.length} MCP tools are connected.${tail}`
  const blocks = found.length <= DETAIL_HITS ? found.map(t => detailBlock(t, shapes)) : found.map(summaryBlock)
  return `${found.length} of ${all.length} MCP tools.\n\n${blocks.join('\n\n')}${tail}`
}
