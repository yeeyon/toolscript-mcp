// The MCP server that a client starts: it lists the tools in SERVED and
// answers their calls. The schemas come from TOOLS as JSON Schema, so the
// handlers are set on the SDK's underlying Server: McpServer.registerTool
// takes only Zod schemas.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { searchResult } from '../core/catalog.ts'
import { policyOf, type Config } from '../core/config.ts'
import { appPath } from '../core/paths.ts'
import { askText, stalePolicyNote, type Policy } from '../core/policy.ts'
import { errorText, newKept, serverInstructions } from '../core/protocol.ts'
import { SEARCH_LIMIT, SERVED, parseInput, registration, type ServedName } from '../core/tools.ts'
import type { Downstream } from './downstream.ts'
import { runCode, type Approval, type RunContext } from './run.ts'

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError })

// A person can take a while to read the program in the prompt.
const ASK_TIMEOUT_MS = 10 * 60_000

type Extra = { readonly signal: AbortSignal; readonly requestId: string | number }

type Context = {
  readonly downstream: Downstream
  readonly run: (code: string, extra: Extra) => Promise<CallToolResult>
  readonly extra: Extra
}

type Handler = (args: object, ctx: Context) => Promise<CallToolResult>

const HANDLERS: Record<ServedName, Handler> = {
  search_tools: async (args, { downstream }) => {
    const { query, limit: asked } = parseInput('search_tools', args)
    const limit = Math.min(100, Math.max(1, asked || SEARCH_LIMIT))
    await downstream.settled
    return text(searchResult(downstream.states(), query, limit))
  },
  run_code: async (args, { run, extra }) => run(parseInput('run_code', args).code, extra),
}

const isServed = (name: string): name is ServedName => (SERVED as readonly string[]).includes(name)

export type Served = {
  readonly server: McpServer
  /** Kills the sandbox of each run in flight and waits until its exchange dir is gone. */
  readonly stopRuns: () => Promise<void>
}

export const createServer = (
  downstream: Downstream,
  config: Config,
  configFile: string,
  version: string,
  log: (line: string) => void,
): Served => {
  const mcp = new McpServer(
    { name: 'toolscript-mcp', version },
    { capabilities: { tools: {} }, instructions: serverInstructions([...config.servers.keys()]) },
  )
  // One server process serves one client session: its kept results and its saveFile folder.
  const kept = newKept()
  const filesDir = path.resolve(appPath(os.homedir(), 'files', randomUUID()))
  const stopping = new AbortController()
  const runs = new Set<Promise<unknown>>()

  const canAsk = () => mcp.server.getClientCapabilities()?.elicitation?.form !== undefined
  const ask =
    (extra: Extra) =>
    async (tools: readonly string[], code: string): Promise<Approval> => {
      try {
        const r = await mcp.server.elicitInput(
          { mode: 'form', message: askText(tools, code), requestedSchema: { type: 'object', properties: {} } },
          { signal: extra.signal, timeout: ASK_TIMEOUT_MS, relatedRequestId: extra.requestId },
        )
        return r.action === 'accept' ? 'accept' : 'decline'
      } catch (err) {
        log(`the approval prompt failed: ${errorText(err)}`)
        return 'decline'
      }
    }

  // The policy is read again at each run, so an edit needs no restart. A
  // config that does not read keeps the last good policy, and the result says so.
  let policy = config.policy
  const freshPolicy = async (): Promise<{ policy: Policy; note: string }> => {
    const read = await fs.promises.readFile(configFile, 'utf8').then(policyOf, err => ({
      ok: false as const,
      errors: [`cannot read the config: ${errorText(err)}`],
    }))
    if (read.ok) {
      policy = read.policy
      return { policy, note: '' }
    }
    log(`the policy was not reloaded: ${read.errors.join('; ')}`)
    return { policy, note: stalePolicyNote(read.errors) }
  }

  const run = async (code: string, extra: Extra): Promise<CallToolResult> => {
    const fresh = await freshPolicy()
    const ctx: RunContext = {
      downstream,
      config: { ...config, policy: fresh.policy },
      kept,
      filesDir,
      ask: ask(extra),
      canAsk,
      signal: AbortSignal.any([extra.signal, stopping.signal]),
      log,
      home: os.homedir(),
    }
    const running = runCode(ctx, code)
    runs.add(running)
    try {
      const r = await running
      return text(fresh.note === '' ? r.text : `${r.text}\n\n${fresh.note}`, r.isError)
    } finally {
      runs.delete(running)
    }
  }

  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: SERVED.map(registration) }))
  mcp.server.setRequestHandler(CallToolRequestSchema, (req, extra) => {
    const { name, arguments: args = {} } = req.params
    return isServed(name) ? HANDLERS[name](args, { downstream, run, extra }) : text(`Unknown tool: ${name}`, true)
  })
  return {
    server: mcp,
    stopRuns: async () => {
      stopping.abort()
      await Promise.allSettled(runs)
    },
  }
}
