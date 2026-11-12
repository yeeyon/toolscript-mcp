// The tools of the downstream MCP servers, as search_tools shows them: one
// entry per tool, named mcp__<server>__<tool>, and the servers that failed.

import type { ServerKey } from './config.ts'
import { rankTools, type ArgSpec, type ToolEntry } from './protocol.ts'

/** A tool as a downstream server lists it. */
export type DownstreamTool = { readonly name: string; readonly description?: string; readonly inputSchema?: unknown }

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

/** The text of a search_tools result: the best matches, then the servers that are not connected. */
export const searchResult = (states: readonly ServerState[], query: string, limit: number): string => {
  const all = catalogOf(states)
  const found = rankTools(all, query, limit)
  const tail = notConnectedText(states)
  if (found.length === 0) return `No MCP tool matches "${query}". ${all.length} MCP tools are connected.${tail}`
  const blocks = found.map(t => {
    const summary = oneLine(t.description.split('\n')[0] ?? '', 300)
    return `### ${t.name}\n${summary}\nargs: ${argsText(t.inputSchema)}`
  })
  return `${found.length} of ${all.length} MCP tools.\n\n${blocks.join('\n\n')}${tail}`
}
