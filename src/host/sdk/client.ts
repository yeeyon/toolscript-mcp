// The SDK client, its call of a tool, and the one notification that the host listens to. Every link is on the v2
// client in the legacy protocol era (issue #154, PR 6): a stdio, shared or Workspace link, an HTTP link and `login`.
import {
  Client,
  type CallToolRequestOptions,
  type CallToolRequestParams,
  type Tool,
} from '@modelcontextprotocol/client'
import type { DownstreamTool } from '../../core/catalog.ts'

/** The client of a link. */
export type HostClient = Client

/** A client of the legacy era, which offers its own version and never asks `server/discover`. */
export const newClient = (info: { name: string; version: string }): HostClient =>
  new Client(info, { versionNegotiation: { mode: 'legacy' } })

type CallToolOptions = Pick<CallToolRequestOptions, 'timeout' | 'signal' | 'resetTimeoutOnProgress' | 'maxTotalTimeout'>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The tool as the v2 client wants it for the check of a result: the listed name and output schema. */
const toolOf = (tool: DownstreamTool): Tool => ({
  name: tool.name,
  inputSchema: { type: 'object' },
  ...(isRecord(tool.outputSchema) && { outputSchema: { ...tool.outputSchema, type: 'object' } }),
})

/** The call of a test double that has the shape of the first SDK: the result schema sits between the two. */
type DoubleShape = {
  readonly callTool: (
    params: CallToolRequestParams,
    resultSchema: undefined,
    options?: CallToolOptions,
  ) => ReturnType<HostClient['callTool']>
}

/**
 * Calls a tool of the server. The v2 client checks a result against the output schema of the tool in its own cache, which
 * a list page by page does not fill (see `listToolsPage`), so the host gives it the listed tool, and a result that breaks
 * its schema is refused as before. A target that is not a v2 client is a test double of the first SDK's shape.
 */
export const callClientTool = (
  target: HostClient | DoubleShape,
  params: CallToolRequestParams,
  options?: CallToolOptions,
  tool?: DownstreamTool,
) =>
  target instanceof Client
    ? target.callTool(params, { ...options, ...(tool !== undefined && { toolDefinition: toolOf(tool) }) })
    : target.callTool(params, undefined, options)

/**
 * One page of the tool list. The v2 client walks every page itself when `listTools` has no cursor, up to its own cap and
 * with its own cache, so the host sends `tools/list` by hand and keeps its `MAX_PAGES` and its time limit.
 */
export const listToolsPage = (target: HostClient, cursor: string | undefined, options: { timeout: number }) =>
  target.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } }, options)

/** Calls `handler` when the server says that its tool list changed. */
export const onToolListChanged = (target: HostClient, handler: () => void): void =>
  target.setNotificationHandler('notifications/tools/list_changed', handler)
