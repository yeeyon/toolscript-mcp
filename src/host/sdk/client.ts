// The SDK clients, their call of a tool, and the one notification that the host listens to. Two client versions live here
// until the HTTP link moves (issue #154, PR 6): a stdio, shared or Workspace link has the v2 client in the legacy era, an
// HTTP link keeps the v1 client, because its transport, its OAuth provider and their errors are one SDK version. Nothing
// outside this folder asks which one a client is.
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client as ClientV2, type Tool } from '@modelcontextprotocol/client'
import type { DownstreamTool } from '../../core/catalog.ts'

/** The v1 client: the HTTP link, and `login`, which runs the OAuth flow of the v1 SDK. */
export { Client } from '@modelcontextprotocol/sdk/client/index.js'

/** The client of a link, whichever SDK it is on. */
export type HostClient = ClientV1 | ClientV2

/** `http`: the v1 client. `link`: stdio, shared and Workspace links, on the v2 client in the legacy era. */
export const newClient = (kind: 'http' | 'link', info: { name: string; version: string }): HostClient =>
  kind === 'http' ? new ClientV1(info) : new ClientV2(info, { versionNegotiation: { mode: 'legacy' } })

declare const client: ClientV1
type ToolListChangedHandler = Parameters<
  typeof client.setNotificationHandler<typeof ToolListChangedNotificationSchema>
>[1]

type CallToolParams = Parameters<ClientV1['callTool']>[0]
type CallToolOptions = Parameters<ClientV1['callTool']>[2]

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The tool as the v2 client wants it for the check of a result: the listed name and output schema. */
const toolOf = (tool: DownstreamTool): Tool => ({
  name: tool.name,
  inputSchema: { type: 'object' },
  ...(isRecord(tool.outputSchema) && { outputSchema: { ...tool.outputSchema, type: 'object' } }),
})

/**
 * Calls a tool of the server. v1 has a slot for the result schema between the two: the host never sets it. A client that is
 * not the v2 one is taken as v1, so a test double with the v1 shape still works. The v2 client checks a result against the
 * output schema of the tool in its own cache, which a list page by page does not fill (see `listToolsPage`), so the host
 * gives it the listed tool, and a result that breaks its schema is refused as v1 did.
 */
export const callClientTool = (
  target: HostClient,
  params: CallToolParams,
  options?: CallToolOptions,
  tool?: DownstreamTool,
) =>
  target instanceof ClientV2
    ? target.callTool(params, { ...options, ...(tool !== undefined && { toolDefinition: toolOf(tool) }) })
    : target.callTool(params, undefined, options)

/**
 * One page of the tool list. The v2 client walks every page itself when `listTools` has no cursor, up to its own cap and
 * with its own cache, so the host sends `tools/list` by hand and keeps its `MAX_PAGES` and its time limit.
 */
export const listToolsPage = (target: HostClient, cursor: string | undefined, options: { timeout: number }) => {
  const params = cursor === undefined ? {} : { cursor }
  return target instanceof ClientV2
    ? target.request({ method: 'tools/list', params }, options)
    : target.listTools(params, options)
}

/** Calls `handler` when the server says that its tool list changed. */
export const onToolListChanged = (target: HostClient, handler: ToolListChangedHandler): void =>
  target instanceof ClientV2
    ? target.setNotificationHandler('notifications/tools/list_changed', handler)
    : target.setNotificationHandler(ToolListChangedNotificationSchema, handler)
