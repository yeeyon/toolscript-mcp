// The SDK client, its call of a tool, and the one notification that the host listens to.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

export { Client } from '@modelcontextprotocol/sdk/client/index.js'

declare const client: Client
type ToolListChangedHandler = Parameters<
  typeof client.setNotificationHandler<typeof ToolListChangedNotificationSchema>
>[1]

type CallToolParams = Parameters<Client['callTool']>[0]
type CallToolOptions = Parameters<Client['callTool']>[2]

/** Calls a tool of the server. v1 has a slot for the result schema between the two: the host never sets it. */
export const callClientTool = (target: Client, params: CallToolParams, options?: CallToolOptions) =>
  target.callTool(params, undefined, options)

/** Calls `handler` when the server says that its tool list changed. */
export const onToolListChanged = (target: Client, handler: ToolListChangedHandler): void =>
  target.setNotificationHandler(ToolListChangedNotificationSchema, handler)
