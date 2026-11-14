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

const typeOf = (schema: unknown): string => {
  if (!isObject(schema)) return 'unknown'
  if (Array.isArray(schema.enum)) return schema.enum.map(v => JSON.stringify(v)).join(' | ')
  const type = schema.type
  if (Array.isArray(type)) return type.map(t => typeOf({ ...schema, type: t })).join(' | ')
  if (type === 'array') return `${typeOf(schema.items)}[]`
  if (type === 'integer') return 'number'
  if (typeof type === 'string') return type
  return 'unknown'
}

/** The argument names and types of an input schema: `{ project: string; limit?: number }`. */
export const argsText = (inputSchema: unknown): string => {
  const properties = isObject(inputSchema) && isObject(inputSchema.properties) ? inputSchema.properties : {}
  const required = isObject(inputSchema) && Array.isArray(inputSchema.required) ? inputSchema.required : []
  const parts = Object.entries(properties).map(
    ([name, schema]) => `${name}${required.includes(name) ? '' : '?'}: ${typeOf(schema)}`,
  )
  return oneLine(parts.length === 0 ? '{}' : `{ ${parts.join('; ')} }`, MAX_ARGS)
}

const MAX_ARGS = 500

/**
 * What an input schema says of a tool's arguments, for the check before a run.
 * A schema with no properties allows any names, as does one that sets
 * `additionalProperties` to anything but false. Without it, other names are
 * typos, as in the generated types of the plugin. Undefined when the schema
 * has no properties object.
 */
export const argSpec = (inputSchema: unknown): ArgSpec | undefined => {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return undefined
  const names = Object.keys(inputSchema.properties)
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((n): n is string => typeof n === 'string')
    : []
  const extra = inputSchema.additionalProperties
  return { names, required, isOpen: names.length === 0 || (extra !== undefined && extra !== false) }
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
const MAX_ENUM = 25
// The deepest object a declaration spells out: the arguments are level 1.
const MAX_LEVEL = 3
// Unions, arrays and refs nested in each other with no object between them.
const MAX_NEST = 12
const MAX_REF_HOPS = 8
const MAX_SHAPES = 500

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Downstream text with its white space collapsed, at most `max` characters. */
const prose = (text: string, max: number): string => oneLine(text.replace(/\s+/g, ' ').trim(), max)

const literal = (v: unknown): string => oneLine(JSON.stringify(v) ?? 'unknown', MAX_NOTE)

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

// The schema with each $ref followed and an allOf of one schema opened. A ref
// that cannot be read or that loops gives undefined, shown as unknown.
const resolve = (schema: unknown, root: unknown): unknown => {
  for (let hops = 0; hops < MAX_REF_HOPS; hops++) {
    if (isObject(schema) && typeof schema.$ref === 'string') schema = pointed(root, schema.$ref)
    else if (isObject(schema) && Array.isArray(schema.allOf) && schema.allOf.length === 1) schema = schema.allOf[0]
    else return schema
  }
  return undefined
}

type Render = { readonly root: unknown; readonly maxLevel: number }

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
  const schema = resolve(raw, r.root)
  if (!isObject(schema) || nest > MAX_NEST) return ['unknown']
  if ('const' in schema) return [literal(schema.const)]
  if (Array.isArray(schema.enum)) {
    const shown = schema.enum.slice(0, MAX_ENUM).map(literal)
    return schema.enum.length > MAX_ENUM ? [...shown, '…'] : shown
  }
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []
  if (union.length > 0) return union.flatMap(s => members(s, r, level, nest + 1))
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0)
    return [schema.allOf.map(s => grouped(members(s, r, level, nest + 1))).join(' & ')]
  const type = schema.type ?? (isObject(schema.properties) ? 'object' : undefined)
  if (Array.isArray(type)) return type.flatMap(t => members({ ...schema, type: t }, r, level, nest + 1))
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

// An object type at `level`, one property to a line. The note goes on the
// first line of the property, where a nested object opens.
const objectType = (schema: Record<string, unknown>, r: Render, level: number, nest: number): string => {
  const properties = isObject(schema.properties) ? Object.entries(schema.properties) : []
  if (level > r.maxLevel) return 'object'
  if (properties.length === 0) {
    const extra = schema.additionalProperties
    return isObject(extra) ? `{ [key: string]: ${typeText(extra, r, level, nest + 1)} }` : 'object'
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  const pad = '  '.repeat(level)
  const lines = properties.map(([name, s]) => {
    const key = `${IDENTIFIER.test(name) ? name : JSON.stringify(name)}${required.includes(name) ? '' : '?'}`
    const [first, ...rest] = typeText(s, r, level, nest + 1).split('\n')
    return [`${pad}${key}: ${first}${noteOf(s, r.root)}`, ...rest].join('\n')
  })
  return `{\n${lines.join('\n')}\n${'  '.repeat(level - 1)}}`
}

// The call() of a tool as a TypeScript declaration, with objects spelled out to
// `maxLevel`. It returns a Promise of the outputSchema, when the tool has one.
const declaration = (t: CatalogEntry, maxLevel: number): string => {
  const args = typeText(t.inputSchema, { root: t.inputSchema, maxLevel }, 0, 0)
  const returns =
    t.outputSchema === undefined
      ? ''
      : `: Promise<${typeText(t.outputSchema, { root: t.outputSchema, maxLevel }, 0, 0)}>`
  return `call(${JSON.stringify(t.name)}, ${args === 'object' || args === 'unknown' ? '{}' : args})${returns}`
}

// A tool in full. A declaration too large to show loses its nested objects
// first, then its notes and its result type.
const detailBlock = (t: CatalogEntry, shapes: ReadonlyMap<string, string>): string => {
  let call = declaration(t, MAX_LEVEL)
  if (call.length > MAX_DECLARATION) call = declaration(t, 1)
  if (call.length > MAX_DECLARATION) call = `call(${JSON.stringify(t.name)}, ${argsText(t.inputSchema)})`
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
